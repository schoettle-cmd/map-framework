#!/usr/bin/env python3
"""Deep scrape all websites for email addresses - check multiple pages."""
import json
import re
import requests
import time
from urllib.parse import urljoin
from bs4 import BeautifulSoup

PROSPECTS_FILE = '/opt/cottage/data/prospects.json'

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

BAD_EMAILS = {
    'user@domain.com', 'example@mysite.com', 'info@hotplate.com',
    'info@cash.app', 'astigma@astigmatic.com', 'team@latofonts.com',
    'wix@example.com', 'email@example.com', 'your@email.com',
    'name@domain.com', 'you@example.com', 'test@test.com',
}

BAD_DOMAINS = {
    'sentry.io', 'wixpress.com', 'squarespace.com', 'googleapis.com',
    'schema.org', 'cloudflare.com', 'jquery.com', 'w3.org',
    'facebook.com', 'instagram.com', 'twitter.com', 'google.com',
    'gstatic.com', 'fbcdn.net', 'cdninstagram.com', 'shopify.com',
    'squareup.com', 'square.site', 'hotplate.com', 'heygoldie.com',
    'latofonts.com', 'astigmatic.com', 'fontawesome.com',
    'typekit.net', 'fonts.com', 'adobe.com', 'gravatar.com',
}

PAGES_TO_CHECK = [
    '', '/contact', '/contact-us', '/about', '/about-us',
    '/pages/contact', '/pages/about', '/info', '/reach-out',
    '/get-in-touch', '/order', '/menu', '/catering',
]

def extract_emails(html):
    """Extract valid email addresses from HTML."""
    emails = set()

    # From mailto links
    soup = BeautifulSoup(html, 'lxml')
    for a in soup.find_all('a', href=True):
        href = a['href']
        if href.startswith('mailto:'):
            email = href.replace('mailto:', '').split('?')[0].strip().lower()
            if '@' in email and '.' in email:
                emails.add(email)

    # From text via regex
    pattern = r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'
    for email in re.findall(pattern, html):
        emails.add(email.lower().strip())

    # Filter junk
    good = set()
    for e in emails:
        if e in BAD_EMAILS:
            continue
        domain = e.split('@')[1] if '@' in e else ''
        if any(bad in domain for bad in BAD_DOMAINS):
            continue
        if any(x in e for x in ['.png', '.jpg', '.svg', '.css', '.js', '@2x', '@3x']):
            continue
        if len(e) > 60:
            continue
        good.add(e)

    return list(good)

def scrape_site(url):
    """Scrape a website thoroughly for emails."""
    if not url.startswith('http'):
        url = 'https://' + url

    all_emails = set()

    for page in PAGES_TO_CHECK:
        try:
            page_url = urljoin(url.rstrip('/') + '/', page.lstrip('/')) if page else url
            resp = requests.get(page_url, headers=HEADERS, timeout=10, allow_redirects=True)
            if resp.status_code == 200:
                emails = extract_emails(resp.text)
                all_emails.update(emails)
        except:
            pass
        time.sleep(0.3)

    return list(all_emails)

def main():
    data = json.load(open(PROSPECTS_FILE))

    # Find all prospects with websites but no email
    needs_scrape = [p for p in data['prospects']
                    if p.get('website', '').strip()
                    and (not p.get('email', '').strip())]

    print(f"Prospects with website but no email: {len(needs_scrape)}")
    print()

    found = 0
    for i, p in enumerate(needs_scrape):
        name = p.get('businessName', p.get('name', '?'))
        website = p['website'].strip()
        print(f"[{i+1}/{len(needs_scrape)}] {name} — {website}")

        emails = scrape_site(website)
        if emails:
            # Prefer emails matching the website domain
            from urllib.parse import urlparse
            domain = urlparse(website if website.startswith('http') else 'https://' + website).netloc.replace('www.', '')
            domain_emails = [e for e in emails if domain.split('.')[0] in e]
            best = domain_emails[0] if domain_emails else emails[0]
            p['email'] = best
            found += 1
            print(f"  ✓ {best}" + (f" (also: {', '.join(e for e in emails if e != best)})" if len(emails) > 1 else ""))
        else:
            print(f"  ✗ No email found")

    with open(PROSPECTS_FILE, 'w') as f:
        json.dump(data, f, indent=2)

    has_email = sum(1 for p in data['prospects'] if p.get('email', '').strip())
    print(f"\n=== RESULTS ===")
    print(f"New emails found: {found}")
    print(f"Total with email: {has_email} / {len(data['prospects'])}")

if __name__ == '__main__':
    main()
