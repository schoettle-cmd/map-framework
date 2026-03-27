#!/usr/bin/env python3
"""
Enrich prospects with emails and photos scraped from their websites.
- Scrapes website pages for email addresses (mailto links, text patterns)
- Checks DNS MX records for common email patterns (info@, hello@, contact@)
- Downloads hero/profile images from websites to replace generic Unsplash photos
"""

import json
import re
import os
import sys
import time
import hashlib
import requests
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

DATA_DIR = '/opt/cottage/data'
IMG_DIR = '/opt/cottage/public/uploads/chefs'
PROSPECTS_FILE = os.path.join(DATA_DIR, 'prospects.json')
ELEMENTS_FILE = os.path.join(DATA_DIR, 'elements.json')

# Generic unsplash images to replace
GENERIC_PREFIX = 'https://images.unsplash.com/'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

COMMON_EMAIL_PREFIXES = ['info', 'hello', 'contact', 'order', 'orders', 'eat', 'food', 'catering', 'support', 'chef']

def extract_emails_from_html(html, domain):
    """Extract email addresses from HTML content."""
    emails = set()

    # From mailto links
    soup = BeautifulSoup(html, 'lxml')
    for a in soup.find_all('a', href=True):
        href = a['href']
        if href.startswith('mailto:'):
            email = href.replace('mailto:', '').split('?')[0].strip().lower()
            if '@' in email and '.' in email:
                emails.add(email)

    # From text content using regex
    email_pattern = r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'
    found = re.findall(email_pattern, html)
    for email in found:
        email = email.lower().strip()
        # Filter out common false positives
        if not any(x in email for x in ['example.com', 'sentry.io', 'wixpress', 'squarespace',
                                         'googleapis', 'schema.org', 'cloudflare', 'jquery',
                                         '.png', '.jpg', '.svg', '.css', '.js', 'webpack',
                                         '@2x', '@3x', 'sentry', 'wix.com']):
            emails.add(email)

    return list(emails)

def extract_best_image(html, url):
    """Extract the best hero/profile image from the page."""
    soup = BeautifulSoup(html, 'lxml')
    candidates = []

    # Open Graph image (usually the best hero image)
    og_img = soup.find('meta', property='og:image')
    if og_img and og_img.get('content'):
        candidates.append(('og', og_img['content']))

    # Twitter card image
    tw_img = soup.find('meta', attrs={'name': 'twitter:image'})
    if tw_img and tw_img.get('content'):
        candidates.append(('twitter', tw_img['content']))

    # Schema.org image
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string or '')
            if isinstance(data, dict):
                img = data.get('image')
                if isinstance(img, str):
                    candidates.append(('schema', img))
                elif isinstance(img, list) and img:
                    candidates.append(('schema', img[0] if isinstance(img[0], str) else img[0].get('url', '')))
                elif isinstance(img, dict):
                    candidates.append(('schema', img.get('url', '')))
        except:
            pass

    # Large hero images in the page
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-src') or ''
        if not src:
            continue
        # Look for large images (by class, width attribute, or name hints)
        classes = ' '.join(img.get('class', []))
        alt = img.get('alt', '')
        width = img.get('width', '')

        is_hero = any(x in classes.lower() for x in ['hero', 'banner', 'header', 'logo', 'brand', 'main', 'cover', 'featured'])
        is_large = False
        try:
            is_large = int(width) >= 300
        except:
            pass

        if is_hero or is_large:
            candidates.append(('hero', src))

    # Filter and resolve URLs
    for source, img_url in candidates:
        if not img_url:
            continue
        # Resolve relative URLs
        full_url = urljoin(url, img_url)
        # Skip tiny icons, svgs, data URIs
        if any(x in full_url.lower() for x in ['favicon', '1x1', 'pixel', 'spacer', '.svg', 'data:image']):
            continue
        # Skip unsplash (we're trying to get away from those)
        if 'unsplash.com' in full_url:
            continue
        return full_url

    return None

def download_image(img_url, prospect_id):
    """Download an image and save it locally. Returns the local path."""
    try:
        resp = requests.get(img_url, headers=HEADERS, timeout=15, stream=True)
        if resp.status_code != 200:
            return None

        content_type = resp.headers.get('content-type', '')
        if 'image' not in content_type and not any(img_url.lower().endswith(x) for x in ['.jpg', '.jpeg', '.png', '.webp']):
            return None

        # Determine extension
        ext = '.jpg'
        if 'png' in content_type or img_url.lower().endswith('.png'):
            ext = '.png'
        elif 'webp' in content_type or img_url.lower().endswith('.webp'):
            ext = '.webp'

        filename = f'{prospect_id}{ext}'
        filepath = os.path.join(IMG_DIR, filename)

        with open(filepath, 'wb') as f:
            for chunk in resp.iter_content(8192):
                f.write(chunk)

        # Check file size - too small is probably an icon
        if os.path.getsize(filepath) < 5000:
            os.remove(filepath)
            return None

        return f'/uploads/chefs/{filename}'
    except Exception as e:
        print(f'  Image download error: {e}')
        return None

def check_mx_records(domain):
    """Check if domain has MX records (can receive email)."""
    try:
        import dns.resolver
        answers = dns.resolver.resolve(domain, 'MX')
        return len(answers) > 0
    except:
        return False

def try_common_emails(domain):
    """Try common email prefixes and return the domain for suggestion."""
    if check_mx_records(domain):
        return f'info@{domain}'
    return None

def scrape_website(url, prospect_id, prospect_name):
    """Scrape a website for email and image."""
    result = {'email': None, 'image': None}

    try:
        # Normalize URL
        if not url.startswith('http'):
            url = 'https://' + url

        resp = requests.get(url, headers=HEADERS, timeout=15, allow_redirects=True)
        if resp.status_code != 200:
            print(f'  HTTP {resp.status_code}')
            return result

        html = resp.text
        domain = urlparse(resp.url).netloc.replace('www.', '')

        # Extract emails
        emails = extract_emails_from_html(html, domain)
        if emails:
            # Prefer emails matching the domain
            domain_emails = [e for e in emails if domain in e]
            result['email'] = domain_emails[0] if domain_emails else emails[0]

        # If no email found, check common pages
        if not result['email']:
            for page in ['/contact', '/about', '/contact-us', '/about-us']:
                try:
                    page_url = urljoin(resp.url, page)
                    page_resp = requests.get(page_url, headers=HEADERS, timeout=10, allow_redirects=True)
                    if page_resp.status_code == 200:
                        page_emails = extract_emails_from_html(page_resp.text, domain)
                        if page_emails:
                            domain_emails = [e for e in page_emails if domain in e]
                            result['email'] = domain_emails[0] if domain_emails else page_emails[0]
                            break
                except:
                    pass

        # If still no email, try MX + common prefix
        if not result['email']:
            mx_email = try_common_emails(domain)
            if mx_email:
                result['email'] = mx_email
                print(f'  Email from MX: {mx_email}')

        # Extract image
        img_url = extract_best_image(html, resp.url)
        if img_url:
            local_path = download_image(img_url, prospect_id)
            if local_path:
                result['image'] = local_path

    except requests.exceptions.Timeout:
        print(f'  Timeout')
    except requests.exceptions.ConnectionError:
        print(f'  Connection error')
    except Exception as e:
        print(f'  Error: {e}')

    return result

def main():
    # Ensure upload directory exists
    os.makedirs(IMG_DIR, exist_ok=True)

    # Load data
    with open(PROSPECTS_FILE) as f:
        prospects_data = json.load(f)
    prospects = prospects_data['prospects']

    with open(ELEMENTS_FILE) as f:
        elements_data = json.load(f)

    total = len(prospects)
    with_website = [p for p in prospects if p.get('website') and p['website'].strip()]
    needs_email = [p for p in with_website if not p.get('email') or not p['email'].strip()]
    has_generic_img = [p for p in with_website if p.get('imageUrl', '').startswith(GENERIC_PREFIX)]

    print(f'Total prospects: {total}')
    print(f'With websites: {len(with_website)}')
    print(f'Need email (have website): {len(needs_email)}')
    print(f'Have generic image (have website): {len(has_generic_img)}')
    print()

    emails_found = 0
    images_found = 0
    updated_ids = []

    for i, p in enumerate(with_website):
        pid = p.get('id', '?')
        name = p.get('businessName') or p.get('name', 'Unknown')
        website = p['website'].strip()
        needs_email_flag = not p.get('email') or not p['email'].strip()
        needs_image_flag = p.get('imageUrl', '').startswith(GENERIC_PREFIX)

        if not needs_email_flag and not needs_image_flag:
            print(f'[{i+1}/{len(with_website)}] {name} — already has email and unique image, skipping')
            continue

        what_needed = []
        if needs_email_flag:
            what_needed.append('email')
        if needs_image_flag:
            what_needed.append('image')

        print(f'[{i+1}/{len(with_website)}] {name} — {website} (need: {", ".join(what_needed)})')

        result = scrape_website(website, pid, name)

        updated = False
        if result['email'] and needs_email_flag:
            p['email'] = result['email']
            print(f'  ✓ Email: {result["email"]}')
            emails_found += 1
            updated = True
        elif needs_email_flag:
            print(f'  ✗ No email found')

        if result['image'] and needs_image_flag:
            p['imageUrl'] = result['image']
            print(f'  ✓ Image: {result["image"]}')
            images_found += 1
            updated = True

            # Also update matching element
            for el in elements_data['elements']:
                if el.get('metadata', {}).get('prospectId') == pid:
                    el['imageUrl'] = result['image']
                    break
        elif needs_image_flag:
            print(f'  ✗ No suitable image found')

        if updated:
            updated_ids.append(pid)

        # Be polite - don't hammer servers
        time.sleep(1)

    # Save updated data
    with open(PROSPECTS_FILE, 'w') as f:
        json.dump(prospects_data, f, indent=2)

    with open(ELEMENTS_FILE, 'w') as f:
        json.dump(elements_data, f, indent=2)

    print(f'\n=== RESULTS ===')
    print(f'Emails found: {emails_found}')
    print(f'Images found: {images_found}')
    print(f'Prospects updated: {len(updated_ids)}')

    # Summary of remaining gaps
    still_no_email = sum(1 for p in prospects if not p.get('email') or not p['email'].strip())
    still_generic = sum(1 for p in prospects if p.get('imageUrl', '').startswith(GENERIC_PREFIX))
    print(f'Still missing email: {still_no_email}')
    print(f'Still have generic image: {still_generic}')

if __name__ == '__main__':
    main()
