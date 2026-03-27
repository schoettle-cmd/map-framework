/**
 * MEHKO Prospect Scraper — Sources LA County permitted home kitchen operators
 *
 * Primary sources:
 *   - mehko-registry: Official LA County DPH MEHKO permit list (283+ operators)
 *   - mehko-map:      mehkomap.github.io — enriched data with addresses, coordinates,
 *                     cuisine types, descriptions, Instagram, websites (260+ operators)
 *
 * Enrichment:
 *   - deep-scrape:    Scrapes individual business websites for phone/email/products
 *   - duckduckgo:     Searches for operators without websites to find their online presence
 */

const cheerio = require('cheerio');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchPage(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...opts.headers },
    signal: AbortSignal.timeout(opts.timeout || 15000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJSON(url, opts = {}) {
  const text = await fetchPage(url, opts);
  return JSON.parse(text);
}

function makeProspect(data, source, sourceUrl) {
  return {
    id: 'pros_' + crypto.randomBytes(8).toString('hex'),
    name: (data.name || '').slice(0, 200),
    businessName: (data.businessName || data.name || '').slice(0, 200),
    address: (data.address || '').slice(0, 500),
    neighborhood: (data.neighborhood || data.city || '').slice(0, 100),
    phone: (data.phone || '').slice(0, 30),
    email: (data.email || '').slice(0, 200),
    website: (data.website || '').slice(0, 500),
    instagram: (data.instagram || '').slice(0, 100),
    products: Array.isArray(data.products) ? data.products.map(p => String(p).slice(0, 200)) : [],
    imageUrl: (data.imageUrl || '').slice(0, 1000),
    permitType: (data.permitType || 'MEHKO').slice(0, 50),
    permitNumber: (data.permitNumber || '').slice(0, 100),
    source,
    sourceUrl: (sourceUrl || '').slice(0, 500),
    notes: (data.notes || '').slice(0, 2000),
    lat: data.lat || null,
    lng: data.lng || null,
    cuisineType: (data.cuisineType || '').slice(0, 100),
    tags: (data.tags || '').slice(0, 500),
    status: 'prospect',
    featured: false,
    scrapedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    convertedAt: null,
    convertedUserId: null
  };
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function titleCase(s) {
  return s.toLowerCase().replace(/(?:^|\s|'|-)\w/g, c => c.toUpperCase());
}

// ── Deep Scrape a Business Website ───────────────────────────────────────────

async function deepScrape(url) {
  try {
    const html = await fetchPage(url, { timeout: 10000 });
    const $ = cheerio.load(html);

    $('script, style, noscript, svg').remove();
    const bodyText = clean($('body').text()).slice(0, 15000);

    const phones = bodyText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
    const phone = phones[0] || '';

    // Prefer mailto: links in raw HTML (cleanest source)
    const mailtoMatches = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4})/g) || [];
    const mailtoEmails = mailtoMatches.map(m => m.replace('mailto:', ''));

    // Fallback: extract from body text with word-boundary anchoring
    const textEmails = bodyText.match(/(?:^|[\s,;:(>])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4})(?:[\s,;:)<]|$)/g) || [];
    const cleanedTextEmails = textEmails.map(m => {
      const match = m.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4})/);
      return match ? match[1] : '';
    }).filter(Boolean);

    const allEmails = [...new Set([...mailtoEmails, ...cleanedTextEmails])];
    const junkDomains = ['sentry', 'wixpress', 'example', 'email.com', 'squarespace', 'godaddy', 'cloudflare', 'googleapis'];
    const email = allEmails.find(e => !junkDomains.some(j => e.includes(j))) || '';

    const igMatches = html.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{2,30})/g) || [];
    const igHandle = igMatches.length > 0 ? '@' + igMatches[0].replace(/.*(?:instagram\.com|instagr\.am)\//, '').replace(/[/?].*/, '') : '';

    const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

    // ── Products / menu items extraction ──
    const products = [];
    const seenProducts = new Set();
    const addProduct = (name) => {
      const cleaned = clean(name).slice(0, 200);
      if (cleaned.length >= 2 && cleaned.length <= 200 && !seenProducts.has(cleaned.toLowerCase())) {
        seenProducts.add(cleaned.toLowerCase());
        products.push(cleaned);
      }
    };

    // 1) JSON-LD Product or Menu schema data
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
        }
      } catch (_) {}
    });

    // 2) Elements with class containing product/menu-item/dish/item keywords
    $('[class*="product" i], [class*="menu-item" i], [class*="dish" i], [class*="menu_item" i]').each((_, el) => {
      // Look for a heading or title-like child first, fallback to the element's own text
      const heading = $(el).find('h1, h2, h3, h4, h5, .title, .name, [class*="title"], [class*="name"]').first().text();
      const text = heading || $(el).text();
      const name = clean(text).split(/\n/)[0]?.slice(0, 200);
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // 3) h3/h4 tags within sections that have "menu" or "product" in class/id
    $('[class*="menu" i], [id*="menu" i], [class*="product" i], [id*="product" i]').find('h3, h4').each((_, el) => {
      const name = clean($(el).text());
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // 4) Square / Shopify / e-commerce product titles
    $('.product-title, .product-name, .product-card__title, .grid-product__title, .ProductItem-details h2, .ProductItem-details h3').each((_, el) => {
      const name = clean($(el).text());
      if (name && name.length >= 2 && name.length <= 120) addProduct(name);
    });

    // 5) Meta tags with product info
    const metaProduct = $('meta[property="product:name"]').attr('content') || $('meta[property="og:title"]').attr('content') || '';
    if (metaProduct && metaProduct.length <= 120) addProduct(metaProduct);

    // Cap at 20 products
    const finalProducts = products.slice(0, 20);

    // ── Logo / hero image extraction ──
    let imageUrl = '';

    // Priority 1: og:image meta tag
    imageUrl = $('meta[property="og:image"]').attr('content') || '';

    // Priority 2: JSON-LD logo field
    if (!imageUrl) {
      $('script[type="application/ld+json"]').each((_, el) => {
        if (imageUrl) return;
        try {
          const ld = JSON.parse($(el).html());
          const items = Array.isArray(ld) ? ld : [ld];
          for (const item of items) {
            if (item.logo) {
              imageUrl = typeof item.logo === 'string' ? item.logo : (item.logo.url || '');
              if (imageUrl) return;
            }
            if (item.image) {
              const img = Array.isArray(item.image) ? item.image[0] : item.image;
              imageUrl = typeof img === 'string' ? img : (img?.url || '');
              if (imageUrl) return;
            }
          }
        } catch (_) {}
      });
    }

    // Priority 3: First img with "logo" in class, id, or alt
    if (!imageUrl) {
      const logoImg = $('img[class*="logo" i], img[id*="logo" i], img[alt*="logo" i]').first();
      imageUrl = logoImg.attr('src') || '';
    }

    // Priority 4: apple-touch-icon
    if (!imageUrl) {
      imageUrl = $('link[rel="apple-touch-icon"]').attr('href') || $('link[rel="apple-touch-icon-precomposed"]').attr('href') || '';
    }

    // Priority 5: favicon as last resort
    if (!imageUrl) {
      imageUrl = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || '';
    }

    // Make relative URLs absolute
    if (imageUrl && !imageUrl.startsWith('http')) {
      try {
        imageUrl = new URL(imageUrl, url).href;
      } catch (_) {
        imageUrl = '';
      }
    }

    return { phone, email, instagram: igHandle, description: (metaDesc || bodyText.slice(0, 300)), products: finalProducts, imageUrl };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Source: MEHKO Map (mehkomap.github.io) — richest source ──────────────────

async function scrapeMEHKOMap() {
  const data = await fetchJSON('https://mehkomap.github.io/mehko/data/businesses.json', { timeout: 20000 });
  const businesses = data.businesses || [];

  return businesses.map(b => makeProspect({
    name: titleCase(b.name),
    businessName: titleCase(b.name),
    address: b.address || '',
    neighborhood: (b.address || '').split(',').pop()?.trim().split(/\s+\d/)[0]?.trim() || '',
    website: b.website || '',
    instagram: b.instagram || '',
    lat: b.lat || null,
    lng: b.lon || null,
    cuisineType: b.type || '',
    tags: b.tags || '',
    notes: b.description || '',
    permitType: 'MEHKO'
  }, 'mehko-map', 'https://mehkomap.github.io/mehko/'));
}

// ── Source: Official LA County MEHKO Registry ────────────────────────────────

async function scrapeMEHKORegistry() {
  const data = await fetchJSON('http://publichealth.lacounty.gov/eh/data/mehko.json', { timeout: 20000 });
  const programs = data.programs || [];

  return {
    lastUpdated: data.lastUpdated,
    prospects: programs.map(p => makeProspect({
      name: titleCase(p.name),
      businessName: titleCase(p.name),
      city: titleCase(p.city),
      neighborhood: titleCase(p.city),
      address: `${titleCase(p.city)}, CA ${p.zip}`,
      permitType: 'MEHKO',
      permitNumber: p.recordid,
      notes: `Permitted MEHKO since ${p.startdate}. LA County Record: ${p.recordid}`
    }, 'mehko-registry', 'http://publichealth.lacounty.gov/eh/i-want-to/view-mehko-list.htm'))
  };
}

// ── Enrichment: Deep-scrape websites for contact info ────────────────────────

async function enrichWithWebsites(prospects) {
  const withSites = prospects.filter(p => p.website && p.website.startsWith('http'));
  const log = { attempted: withSites.length, success: 0, failed: 0 };

  // Batch 5 at a time
  for (let i = 0; i < withSites.length; i += 5) {
    const batch = withSites.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(p => deepScrape(p.website)));

    batch.forEach((p, j) => {
      if (results[j].status === 'fulfilled') {
        const d = results[j].value;
        if (!d.error) {
          log.success++;
          if (d.phone && !p.phone) p.phone = d.phone;
          if (d.email && !p.email) p.email = d.email;
          if (d.instagram && !p.instagram) p.instagram = d.instagram;
          if (d.description) p.notes = (p.notes + ' | ' + d.description).slice(0, 2000);
          if (d.products && d.products.length > 0 && (!p.products || p.products.length === 0)) p.products = d.products;
          if (d.imageUrl) p.imageUrl = d.imageUrl;
        } else {
          log.failed++;
        }
      } else {
        log.failed++;
      }
    });

    // Rate limit
    if (i + 5 < withSites.length) await new Promise(r => setTimeout(r, 800));
  }

  return log;
}

// ── Generic Webpage Scraper ──────────────────────────────────────────────────

async function scrapeWebpage(url) {
  const details = await deepScrape(url);
  if (details.error) {
    return [makeProspect({ name: url, businessName: url, website: url, notes: `Scrape failed: ${details.error}` }, 'webpage', url)];
  }

  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const title = clean($('title').text()) || clean($('h1').first().text());
  const bizName = title.replace(/\s*[-|–—].*/g, '').trim() || url;

  return [makeProspect({ name: bizName, businessName: bizName, website: url, ...details }, 'webpage', url)];
}

// ── Geocoding — resolve addresses to lat/lng via Nominatim ──────────────────

async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Cuisine/1.0 (home-chef-discovery)' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  return null;
}

async function geocodeMissing(prospects) {
  const missing = prospects.filter(p => (p.lat == null || p.lng == null) && p.address);
  const log = { attempted: missing.length, success: 0, failed: 0 };

  // One at a time — Nominatim rate limit is 1 req/sec
  for (const p of missing) {
    try {
      const coords = await geocodeAddress(p.address);
      if (coords) {
        p.lat = coords.lat;
        p.lng = coords.lng;
        log.success++;
      } else {
        log.failed++;
      }
    } catch (_) {
      log.failed++;
    }
    // Respect Nominatim 1 req/sec rate limit
    await new Promise(r => setTimeout(r, 1100));
  }

  return log;
}

// ── Main Orchestrator ────────────────────────────────────────────────────────

async function scrapeAll(options = {}) {
  const { source, url, skipEnrich } = options;
  const log = [];

  const runSource = async (name, fn) => {
    const start = Date.now();
    log.push({ source: name, status: 'started', time: new Date().toISOString() });
    try {
      const results = await fn();
      const elapsed = Date.now() - start;
      const count = Array.isArray(results) ? results.length : results?.prospects?.length || 0;
      log.push({ source: name, status: 'done', count, elapsed: `${elapsed}ms` });
      return results;
    } catch (e) {
      const elapsed = Date.now() - start;
      log.push({ source: name, status: 'error', error: e.message, elapsed: `${elapsed}ms` });
      return [];
    }
  };

  if (source === 'webpage') {
    if (!url) throw new Error('URL required for webpage scraper');
    const results = await runSource('webpage', () => scrapeWebpage(url));
    return { prospects: results, log, total: results.length };
  }

  if (source === 'mehko-registry') {
    const reg = await runSource('mehko-registry', scrapeMEHKORegistry);
    const prospects = reg.prospects || [];
    return { prospects, log, total: prospects.length };
  }

  if (source === 'mehko-map') {
    const prospects = await runSource('mehko-map', scrapeMEHKOMap);
    return { prospects, log, total: prospects.length };
  }

  // Default: merge both sources + enrich
  // Step 1: Fetch both sources in parallel
  const [mapData, registryData] = await Promise.allSettled([
    runSource('mehko-map', scrapeMEHKOMap),
    runSource('mehko-registry', scrapeMEHKORegistry)
  ]);

  const mapProspects = mapData.status === 'fulfilled' ? (Array.isArray(mapData.value) ? mapData.value : []) : [];
  const regResult = registryData.status === 'fulfilled' ? registryData.value : { prospects: [] };
  const regProspects = regResult.prospects || [];

  // Step 2: Merge — use map data as primary (it has coordinates, types, descriptions)
  // then layer in registry data for permit numbers and any missing entries
  const merged = new Map();

  // Map data first (richer)
  for (const p of mapProspects) {
    const key = (p.businessName || p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length >= 2) merged.set(key, p);
  }

  // Merge registry data
  for (const p of regProspects) {
    const key = (p.businessName || p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length < 2) continue;

    if (merged.has(key)) {
      const existing = merged.get(key);
      // Registry has permit number
      if (p.permitNumber && !existing.permitNumber) existing.permitNumber = p.permitNumber;
      if (p.notes && !existing.notes.includes(p.permitNumber || '')) {
        existing.notes = (existing.notes + ' | ' + p.notes).slice(0, 2000);
      }
    } else {
      // New entry only in registry
      merged.set(key, p);
    }
  }

  let allProspects = [...merged.values()];
  log.push({ source: 'merge', status: 'done', count: allProspects.length, note: `${mapProspects.length} from map + ${regProspects.length} from registry = ${allProspects.length} unique` });

  // Step 3: Geocode prospects missing coordinates
  const needGeo = allProspects.filter(p => (p.lat == null || p.lng == null) && p.address);
  if (needGeo.length > 0) {
    const geoLog = await geocodeMissing(allProspects);
    log.push({ source: 'geocode', status: 'done', ...geoLog, note: `${needGeo.length} prospects needed geocoding` });
  }

  // Step 4: Enrich — deep-scrape websites for phone/email
  if (!skipEnrich) {
    const enrichLog = await enrichWithWebsites(allProspects);
    log.push({ source: 'deep-scrape', status: 'done', ...enrichLog });
  }

  return { prospects: allProspects, log, total: allProspects.length };
}

module.exports = { scrapeAll, scrapeMEHKOMap, scrapeMEHKORegistry, enrichWithWebsites, geocodeMissing, geocodeAddress, scrapeWebpage, deepScrape };
