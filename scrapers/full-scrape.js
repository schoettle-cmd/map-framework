#!/usr/bin/env node
/**
 * Full Deep Scrape — Scrapes ALL MEHKO business websites individually
 * Extracts products, images, contact info, hours, ordering links
 * Updates prospects.json with enriched data
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROSPECTS_PATH = path.join(__dirname, '..', 'data', 'prospects.json');

async function fetchPage(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...opts.headers },
    signal: AbortSignal.timeout(opts.timeout || 15000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

// ── Enhanced Deep Scrape ─────────────────────────────────────────────────────

async function deepScrapeEnhanced(url, businessName) {
  const result = {
    phone: '',
    email: '',
    instagram: '',
    description: '',
    products: [],
    imageUrl: '',
    address: '',
    hours: '',
    orderingLinks: [],
    error: null
  };

  try {
    const html = await fetchPage(url, { timeout: 15000 });
    const $ = cheerio.load(html);

    // Remove noise
    $('script, style, noscript, svg, iframe').remove();
    const bodyText = clean($('body').text()).slice(0, 20000);
    const rawHtml = html;

    // ── Phone ──
    const phones = bodyText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
    result.phone = phones[0] || '';

    // ── Email ──
    const mailtoMatches = rawHtml.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})/g) || [];
    const mailtoEmails = mailtoMatches.map(m => m.replace('mailto:', ''));
    const textEmails = bodyText.match(/(?:^|[\s,;:(>])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})(?:[\s,;:)<]|$)/g) || [];
    const cleanedTextEmails = textEmails.map(m => {
      const match = m.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6})/);
      return match ? match[1] : '';
    }).filter(Boolean);
    const allEmails = [...new Set([...mailtoEmails, ...cleanedTextEmails])];
    const junkDomains = ['sentry', 'wixpress', 'example', 'email.com', 'squarespace', 'godaddy', 'cloudflare', 'googleapis', 'w3.org', 'schema.org'];
    result.email = allEmails.find(e => !junkDomains.some(j => e.includes(j))) || '';

    // ── Instagram ──
    const igMatches = rawHtml.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{2,30})/g) || [];
    if (igMatches.length > 0) {
      const handle = igMatches[0].replace(/.*(?:instagram\.com|instagr\.am)\//, '').replace(/[/?#].*/, '');
      if (!['explore', 'p', 'reel', 'stories', 'accounts'].includes(handle)) {
        result.instagram = '@' + handle;
      }
    }

    // ── Description ──
    const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    result.description = metaDesc || bodyText.slice(0, 400);

    // ── Products / Menu Items ──
    const seenProducts = new Set();
    const addProduct = (name) => {
      const cleaned = clean(name).slice(0, 200);
      if (cleaned.length >= 2 && cleaned.length <= 200 && !seenProducts.has(cleaned.toLowerCase())) {
        // Filter out garbage
        const lower = cleaned.toLowerCase();
        if (['home', 'about', 'contact', 'menu', 'order', 'cart', 'login', 'sign up', 'faq', 'blog',
             'privacy policy', 'terms of service', 'shop', 'all products', 'checkout', 'search',
             'close', 'open', 'read more', 'learn more', 'view all', 'see all', 'load more',
             'subscribe', 'newsletter', 'follow us', 'back to top'].includes(lower)) return;
        if (cleaned.split(' ').length > 15) return; // Too long, probably a sentence
        seenProducts.add(cleaned.toLowerCase());
        result.products.push(cleaned);
      }
    };

    // JSON-LD structured data
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const ld = JSON.parse($(el).html());
        const items = Array.isArray(ld) ? ld : [ld];
        for (const item of items) {
          if (item['@type'] === 'Product' && item.name) addProduct(item.name);
          if (item['@type'] === 'Menu' && Array.isArray(item.hasMenuSection)) {
            for (const section of item.hasMenuSection) {
              if (Array.isArray(section.hasMenuItem)) {
                for (const mi of section.hasMenuItem) { if (mi.name) addProduct(mi.name); }
              }
            }
          }
          if (item['@type'] === 'MenuItem' && item.name) addProduct(item.name);
          if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
            for (const li of item.itemListElement) {
              if (li.name) addProduct(li.name);
              if (li.item && li.item.name) addProduct(li.item.name);
            }
          }
          // Address from structured data
          if (item.address && typeof item.address === 'object') {
            const addr = [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion, item.address.postalCode].filter(Boolean).join(', ');
            if (addr && !result.address) result.address = addr;
          }
          // Hours from structured data
          if (item.openingHoursSpecification && !result.hours) {
            const specs = Array.isArray(item.openingHoursSpecification) ? item.openingHoursSpecification : [item.openingHoursSpecification];
            result.hours = specs.map(s => `${s.dayOfWeek || ''}: ${s.opens || ''}-${s.closes || ''}`).join('; ').slice(0, 500);
          }
          if (item.openingHours && !result.hours) {
            result.hours = (Array.isArray(item.openingHours) ? item.openingHours.join('; ') : String(item.openingHours)).slice(0, 500);
          }
        }
      } catch (_) {}
    });

    // Product/menu elements by CSS class
    $('[class*="product" i], [class*="menu-item" i], [class*="dish" i], [class*="menu_item" i], [class*="food-item" i]').each((_, el) => {
      const heading = $(el).find('h1, h2, h3, h4, h5, .title, .name, [class*="title"], [class*="name"]').first().text();
      const text = heading || $(el).text();
      const name = clean(text).split(/\n/)[0]?.slice(0, 200);
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // Menu sections with h3/h4
    $('[class*="menu" i], [id*="menu" i], [class*="product" i], [id*="product" i]').find('h3, h4, h2').each((_, el) => {
      const name = clean($(el).text());
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // Square / Shopify / e-commerce product titles
    $('.product-title, .product-name, .product-card__title, .grid-product__title, .ProductItem-details h2, .ProductItem-details h3').each((_, el) => {
      const name = clean($(el).text());
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // Square Online store items
    $('[data-section-type="products"] .grid-item__title, .product-card .product-card__title, .item-card .item-card__title').each((_, el) => {
      const name = clean($(el).text());
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // Hotplate menu items
    $('[class*="MenuItem"], [class*="menuItem"], [class*="item-name"]').each((_, el) => {
      const name = clean($(el).text()).split(/\$|\d+\.\d+/)[0]?.trim();
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // Wix product items
    $('[data-hook="product-item-name"], [data-hook="product-title"]').each((_, el) => {
      const name = clean($(el).text());
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // Generic: li elements in ul with menu/product context
    $('ul[class*="menu" i] li, ul[class*="product" i] li, ol[class*="menu" i] li').each((_, el) => {
      const text = clean($(el).text());
      const name = text.split(/\$|\d+\.\d+/)[0]?.trim();
      if (name && name.length >= 3 && name.length <= 100 && name.split(' ').length <= 8) addProduct(name);
    });

    // Meta product tag
    const metaProduct = $('meta[property="product:name"]').attr('content') || '';
    if (metaProduct && metaProduct.length <= 120) addProduct(metaProduct);

    // OG title as fallback product
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    if (ogTitle && ogTitle.length <= 120 && result.products.length === 0) addProduct(ogTitle);

    // Cap at 25 products
    result.products = result.products.slice(0, 25);

    // ── Image ──
    // Priority 1: og:image
    result.imageUrl = $('meta[property="og:image"]').attr('content') || '';

    // Priority 2: JSON-LD logo/image
    if (!result.imageUrl) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (result.imageUrl) return;
        try {
          const ld = JSON.parse($(el).html());
          const items = Array.isArray(ld) ? ld : [ld];
          for (const item of items) {
            if (item.logo) {
              result.imageUrl = typeof item.logo === 'string' ? item.logo : (item.logo.url || '');
              if (result.imageUrl) return;
            }
            if (item.image) {
              const img = Array.isArray(item.image) ? item.image[0] : item.image;
              result.imageUrl = typeof img === 'string' ? img : (img?.url || '');
              if (result.imageUrl) return;
            }
          }
        } catch (_) {}
      });
    }

    // Priority 3: Logo img
    if (!result.imageUrl) {
      const logoImg = $('img[class*="logo" i], img[id*="logo" i], img[alt*="logo" i]').first();
      result.imageUrl = logoImg.attr('src') || '';
    }

    // Priority 4: Hero image (first large image)
    if (!result.imageUrl) {
      $('img').each((_, el) => {
        if (result.imageUrl) return;
        const src = $(el).attr('src') || '';
        if (src && !src.includes('icon') && !src.includes('pixel') && !src.includes('tracking')) {
          result.imageUrl = src;
        }
      });
    }

    // Priority 5: apple-touch-icon
    if (!result.imageUrl) {
      result.imageUrl = $('link[rel="apple-touch-icon"]').attr('href') || $('link[rel="apple-touch-icon-precomposed"]').attr('href') || '';
    }

    // Make relative URLs absolute
    if (result.imageUrl && !result.imageUrl.startsWith('http')) {
      try { result.imageUrl = new URL(result.imageUrl, url).href; }
      catch (_) { result.imageUrl = ''; }
    }

    // ── Address from page ──
    if (!result.address) {
      // Look for address-like patterns
      const addrMatch = bodyText.match(/\d{1,5}\s+[A-Z][a-zA-Z\s]{2,30}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place)[.,]?\s*(?:#\s*\d+\s*,?\s*)?[A-Z][a-zA-Z\s]{2,20},?\s*(?:CA|California)\s*\d{5}/i);
      if (addrMatch) result.address = clean(addrMatch[0]);
    }

    // ── Hours ──
    if (!result.hours) {
      // Look for common hours patterns
      const hoursPatterns = [
        /(?:hours|schedule|open|we're open)[:\s]*((?:mon|tue|wed|thu|fri|sat|sun|daily|everyday|weekday|weekend)[\s\S]{5,200})/i,
        /(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?)\s*[-–:]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)/i
      ];
      for (const pat of hoursPatterns) {
        const m = bodyText.match(pat);
        if (m) {
          result.hours = clean(m[0]).slice(0, 500);
          break;
        }
      }
    }

    // ── Ordering Links ──
    const orderDomains = ['square.site', 'shopify', 'hotplate.com', 'ubereats.com', 'doordash.com', 'grubhub.com', 'postmates.com', 'chownow.com', 'toast-restaurants.com', 'order.online'];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (orderDomains.some(d => href.includes(d))) {
        if (!result.orderingLinks.includes(href)) {
          result.orderingLinks.push(href.slice(0, 500));
        }
      }
    });
    // Also check if the page URL itself is an ordering platform
    if (orderDomains.some(d => url.includes(d))) {
      if (!result.orderingLinks.includes(url)) {
        result.orderingLinks.push(url);
      }
    }

    result.orderingLinks = result.orderingLinks.slice(0, 5);

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n============================================================');
  console.log('  MEHKO Full Deep Scrape — All Business Websites');
  console.log('============================================================\n');

  // Load prospects
  const data = JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf-8'));
  const total = data.prospects.length;
  console.log(`Loaded ${total} total prospects from prospects.json`);

  // Filter to those with websites
  const withSites = data.prospects.filter(p => p.website && p.website.startsWith('http'));
  console.log(`Found ${withSites.length} prospects with websites to scrape\n`);

  const stats = {
    attempted: withSites.length,
    success: 0,
    failed: 0,
    errors: [],
    productsFound: 0,
    imagesFound: 0,
    phonesFound: 0,
    emailsFound: 0,
    instagramsFound: 0,
    addressesFound: 0,
    hoursFound: 0,
    orderingLinksFound: 0,
    bestEnriched: []
  };

  const BATCH_SIZE = 4;
  const DELAY_BETWEEN_BATCHES = 1000;

  for (let i = 0; i < withSites.length; i += BATCH_SIZE) {
    const batch = withSites.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(withSites.length / BATCH_SIZE);

    console.log(`--- Batch ${batchNum}/${totalBatches} (${batch.map(p => p.businessName.slice(0, 20)).join(', ')}) ---`);

    const results = await Promise.allSettled(
      batch.map(p => deepScrapeEnhanced(p.website, p.businessName))
    );

    batch.forEach((prospect, j) => {
      const settledResult = results[j];
      let d;
      if (settledResult.status === 'fulfilled') {
        d = settledResult.value;
      } else {
        d = { error: settledResult.reason?.message || 'Promise rejected' };
      }

      if (d.error) {
        stats.failed++;
        stats.errors.push({ name: prospect.businessName, url: prospect.website, error: d.error });
        console.log(`  FAIL: ${prospect.businessName} — ${d.error}`);
        return;
      }

      stats.success++;

      // Update prospect with scraped data
      let enrichCount = 0;

      if (d.phone && !prospect.phone) { prospect.phone = d.phone; stats.phonesFound++; enrichCount++; }
      else if (prospect.phone) { stats.phonesFound++; } // Already had one

      if (d.email && !prospect.email) { prospect.email = d.email; stats.emailsFound++; enrichCount++; }
      else if (prospect.email) { stats.emailsFound++; }

      if (d.instagram && !prospect.instagram) { prospect.instagram = d.instagram; stats.instagramsFound++; enrichCount++; }
      else if (prospect.instagram) { stats.instagramsFound++; }

      if (d.description) {
        // Append description if new info
        if (!prospect.notes.includes(d.description.slice(0, 50))) {
          prospect.notes = (prospect.notes + ' | Website: ' + d.description).slice(0, 2000);
        }
      }

      if (d.products && d.products.length > 0) {
        // Merge products - add new ones
        const existing = new Set((prospect.products || []).map(p => p.toLowerCase()));
        const newProducts = d.products.filter(p => !existing.has(p.toLowerCase()));
        prospect.products = [...(prospect.products || []), ...newProducts].slice(0, 25);
        stats.productsFound += d.products.length;
        enrichCount += d.products.length;
      }

      if (d.imageUrl && !prospect.imageUrl) { prospect.imageUrl = d.imageUrl; stats.imagesFound++; enrichCount++; }
      else if (prospect.imageUrl) { stats.imagesFound++; }

      if (d.address && !prospect.address) { prospect.address = d.address; stats.addressesFound++; enrichCount++; }
      else if (d.address) { stats.addressesFound++; }

      if (d.hours) {
        prospect.hours = d.hours;
        stats.hoursFound++;
        enrichCount++;
      }

      if (d.orderingLinks && d.orderingLinks.length > 0) {
        prospect.orderingLinks = d.orderingLinks;
        stats.orderingLinksFound += d.orderingLinks.length;
        enrichCount++;
      }

      // Update scrape timestamp
      prospect.scrapedAt = new Date().toISOString();

      // Track best enriched
      if (enrichCount >= 3) {
        stats.bestEnriched.push({
          name: prospect.businessName,
          products: (prospect.products || []).length,
          phone: prospect.phone || '',
          email: prospect.email || '',
          instagram: prospect.instagram || '',
          imageUrl: prospect.imageUrl ? 'YES' : '',
          hours: d.hours ? 'YES' : '',
          orderLinks: (d.orderingLinks || []).length,
          enrichCount
        });
      }

      console.log(`  OK: ${prospect.businessName} — ${(d.products || []).length} products, phone=${d.phone ? 'Y' : 'N'}, email=${d.email ? 'Y' : 'N'}, img=${d.imageUrl ? 'Y' : 'N'}, ig=${d.instagram ? 'Y' : 'N'}`);
    });

    // Rate limit between batches
    if (i + BATCH_SIZE < withSites.length) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES));
    }
  }

  // Save updated prospects
  console.log('\nSaving updated prospects...');
  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(data, null, 2));
  console.log('Saved to', PROSPECTS_PATH);

  // ── Final Summary ──────────────────────────────────────────────────────────
  console.log('\n============================================================');
  console.log('  SCRAPE RESULTS SUMMARY');
  console.log('============================================================');
  console.log(`  Total prospects:        ${total}`);
  console.log(`  With websites:          ${stats.attempted}`);
  console.log(`  Successfully scraped:   ${stats.success}`);
  console.log(`  Failed:                 ${stats.failed}`);
  console.log('------------------------------------------------------------');
  console.log(`  Products found:         ${stats.productsFound}`);
  console.log(`  Images found:           ${stats.imagesFound}`);
  console.log(`  Phones found:           ${stats.phonesFound}`);
  console.log(`  Emails found:           ${stats.emailsFound}`);
  console.log(`  Instagrams found:       ${stats.instagramsFound}`);
  console.log(`  Addresses found:        ${stats.addressesFound}`);
  console.log(`  Hours found:            ${stats.hoursFound}`);
  console.log(`  Ordering links found:   ${stats.orderingLinksFound}`);
  console.log('============================================================');

  if (stats.errors.length > 0) {
    console.log('\n-- Failed Sites --');
    stats.errors.forEach(e => console.log(`  ${e.name}: ${e.url} — ${e.error}`));
  }

  // Sort best enriched by enrichCount
  stats.bestEnriched.sort((a, b) => b.enrichCount - a.enrichCount);
  if (stats.bestEnriched.length > 0) {
    console.log(`\n-- Top ${Math.min(15, stats.bestEnriched.length)} Best-Enriched Businesses --`);
    stats.bestEnriched.slice(0, 15).forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.name}`);
      console.log(`     Products: ${b.products}, Phone: ${b.phone || 'N'}, Email: ${b.email || 'N'}, IG: ${b.instagram || 'N'}, Image: ${b.imageUrl}, Hours: ${b.hours}, OrderLinks: ${b.orderLinks}`);
    });
  }

  // Count final stats across ALL prospects
  console.log('\n-- Final Prospect Database Stats --');
  const finalWithProducts = data.prospects.filter(p => p.products && p.products.length > 0).length;
  const finalTotalProducts = data.prospects.reduce((sum, p) => sum + (p.products ? p.products.length : 0), 0);
  const finalWithImage = data.prospects.filter(p => p.imageUrl).length;
  const finalWithPhone = data.prospects.filter(p => p.phone).length;
  const finalWithEmail = data.prospects.filter(p => p.email).length;
  const finalWithIG = data.prospects.filter(p => p.instagram).length;
  console.log(`  Total prospects:          ${data.prospects.length}`);
  console.log(`  With products:            ${finalWithProducts} (${finalTotalProducts} total items)`);
  console.log(`  With image:               ${finalWithImage}`);
  console.log(`  With phone:               ${finalWithPhone}`);
  console.log(`  With email:               ${finalWithEmail}`);
  console.log(`  With Instagram:           ${finalWithIG}`);

  return stats;
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
