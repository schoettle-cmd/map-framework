/**
 * Cottage Prospect Scraper — Multi-source scraper for finding cottage food sellers in LA
 *
 * Sources:
 *   - duckduckgo:  Search engine results (reliable, no captcha)
 *   - shef:        Shef.com home cook marketplace
 *   - lacounty:    LA County DPH cottage food page
 *   - webpage:     Deep-scrape any URL for business info
 *
 * Pipeline: search → discover URLs → deep-scrape each for contact info
 */

const cheerio = require('cheerio');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchPage(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...opts.headers
    },
    signal: AbortSignal.timeout(opts.timeout || 15000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function makeProspect(data, source, sourceUrl) {
  return {
    id: 'pros_' + crypto.randomBytes(8).toString('hex'),
    name: (data.name || '').slice(0, 200),
    businessName: (data.businessName || data.name || '').slice(0, 200),
    address: (data.address || '').slice(0, 500),
    neighborhood: (data.neighborhood || '').slice(0, 100),
    phone: (data.phone || '').slice(0, 30),
    email: (data.email || '').slice(0, 200),
    website: (data.website || '').slice(0, 500),
    instagram: (data.instagram || '').slice(0, 100),
    products: Array.isArray(data.products) ? data.products.map(p => String(p).slice(0, 200)) : [],
    permitType: (data.permitType || '').slice(0, 50),
    permitNumber: (data.permitNumber || '').slice(0, 100),
    source,
    sourceUrl: (sourceUrl || '').slice(0, 500),
    notes: (data.notes || '').slice(0, 2000),
    status: 'prospect',
    featured: false,
    scrapedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    convertedAt: null,
    convertedUserId: null
  };
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function extractUrl(ddgHref) {
  // DuckDuckGo wraps URLs in redirects: //duckduckgo.com/l/?uddg=<encoded>&rut=...
  if (!ddgHref) return '';
  try {
    const match = ddgHref.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch (e) {}
  if (ddgHref.startsWith('http')) return ddgHref;
  return '';
}

// ── DuckDuckGo Search ────────────────────────────────────────────────────────

async function searchDDG(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const results = [];

  // Parse DDG HTML results
  $('.result').each((_, el) => {
    const r = $(el);
    const titleEl = r.find('.result__a');
    const title = clean(titleEl.text());
    const href = extractUrl(titleEl.attr('href'));
    const snippet = clean(r.find('.result__snippet').text());

    if (title && href && !href.includes('duckduckgo.com') && !href.includes('amazon.com') && !href.includes('bing.com')) {
      results.push({ title, url: href, snippet });
    }
  });

  return results;
}

// ── Deep Scrape a Business Website ───────────────────────────────────────────

async function deepScrape(url) {
  try {
    const html = await fetchPage(url, { timeout: 12000 });
    const $ = cheerio.load(html);
    const bodyHtml = html;

    const title = clean($('title').text()) || clean($('h1').first().text());
    const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

    $('script, style, noscript, svg').remove();
    const bodyText = clean($('body').text()).slice(0, 15000);

    // Phone
    const phones = bodyText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
    const phone = phones[0] || '';

    // Email
    const emails = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const email = (emails.find(e => !e.includes('sentry') && !e.includes('wixpress') && !e.includes('example')) || '');

    // Instagram
    const igMatches = bodyHtml.match(/(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]{2,30})/g) || [];
    const igHandle = igMatches.length > 0 ? '@' + igMatches[0].replace(/.*(?:instagram\.com|instagr\.am)\//, '').replace(/[/?].*/, '') : '';

    // Address
    const addressPatterns = [
      /\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Ct|Pl|Street|Avenue|Boulevard|Drive|Road|Lane|Court|Place)\.?(?:[\s,]+(?:Suite|Ste|Apt|Unit|#)\s*\S+)?[\s,]+[A-Z][a-zA-Z\s]+,?\s*(?:CA|California)\s*\d{5}/,
      /\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Ct|Pl|Street|Avenue|Boulevard|Drive)\.?[\s,]+[A-Z][a-zA-Z]+/
    ];
    let address = '';
    for (const pat of addressPatterns) {
      const m = bodyText.match(pat);
      if (m) { address = m[0]; break; }
    }

    // Permit number
    const permitMatch = bodyText.match(/(?:permit|registration|CFO|license)\s*#?\s*:?\s*((?:LA|CF|CFO)[\w-]+\d+)/i);
    const permitNumber = permitMatch ? permitMatch[1] : '';
    const permitType = bodyText.match(/class\s*[AB]/i)?.[0] || '';

    // Products — look for menu/product items
    const products = [];
    $('h3, h4, .product-title, [class*="product-name"], [class*="menu-item"], .wsite-content-title').each((_, el) => {
      const name = clean($(el).text());
      if (name.length > 3 && name.length < 80 && !name.match(/^(home|about|contact|menu|shop|order|faq|blog)/i)) {
        products.push(name);
      }
    });

    // Neighborhood from text
    const laNeighborhoods = ['Silver Lake', 'Los Feliz', 'Echo Park', 'Highland Park', 'Eagle Rock', 'Atwater Village', 'Glendale', 'Pasadena', 'Burbank', 'Hollywood', 'West Hollywood', 'Santa Monica', 'Venice', 'Culver City', 'Mar Vista', 'Palms', 'Westwood', 'Koreatown', 'Downtown', 'DTLA', 'Boyle Heights', 'East LA', 'El Sereno', 'Lincoln Heights', 'Chinatown', 'Arts District', 'South LA', 'Inglewood', 'Compton', 'Long Beach', 'Torrance', 'Lakewood', 'Whittier', 'Alhambra', 'Monterey Park', 'San Gabriel', 'Arcadia', 'Glassell Park', 'Cypress Park', 'Mt Washington', 'Frogtown', 'Elysian Park'];
    let neighborhood = '';
    for (const n of laNeighborhoods) {
      if (bodyText.includes(n)) { neighborhood = n; break; }
    }

    return { phone, email, instagram: igHandle, address, permitNumber, permitType, products: products.slice(0, 10), neighborhood, description: metaDesc || bodyText.slice(0, 300) };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Source: DuckDuckGo Cottage Food Search ────────────────────────────────────

async function scrapeDuckDuckGo() {
  const results = [];
  const queries = [
    'cottage food Los Angeles order homemade',
    '"cottage food" "Los Angeles" bakery permit',
    'home bakery Los Angeles order cookies bread',
    '"cottage food operation" California Los Angeles',
    'homemade food Los Angeles delivery order online',
    'LA cottage food permit Class A Class B baker'
  ];

  for (const q of queries) {
    try {
      const searchResults = await searchDDG(q);

      for (const sr of searchResults) {
        // Filter: skip aggregator/news/govt pages — we want actual businesses
        const dominated = ['yelp.com/search', 'google.com', 'youtube.com', 'wikipedia.org', 'reddit.com', 'facebook.com/groups', 'twitter.com', 'tiktok.com', 'amazon.com', 'linkedin.com', 'nytimes.com', 'latimes.com', 'eater.com', 'timeout.com'];
        if (dominated.some(d => sr.url.includes(d))) continue;

        // Skip government/info pages
        if (sr.url.includes('cdph.ca.gov') || sr.url.includes('publichealth.lacounty.gov')) continue;

        const bizName = sr.title.replace(/\s*[-|–—:].*/g, '').replace(/\s*\|.*/, '').trim();
        if (bizName.length < 3 || bizName.length > 100) continue;

        // Check if it looks like an actual cottage food business
        const text = (sr.title + ' ' + sr.snippet).toLowerCase();
        const relevant = ['cottage food', 'home bak', 'homemade', 'CFO', 'permit', 'Class A', 'Class B', 'order', 'cookies', 'bread', 'tamales', 'pastry', 'cake'].some(k => text.includes(k.toLowerCase()));
        if (!relevant) continue;

        results.push({
          name: bizName,
          businessName: bizName,
          website: sr.url,
          notes: sr.snippet,
          _needsDeepScrape: true
        });
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      // continue with other queries
    }
  }

  // Deduplicate by domain
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    try {
      const domain = new URL(r.website).hostname.replace('www.', '');
      if (seen.has(domain)) continue;
      seen.add(domain);
      unique.push(r);
    } catch (e) {
      unique.push(r);
    }
  }

  // Deep-scrape each business website for contact info (parallel, batched)
  const batch = 5;
  const enriched = [];
  for (let i = 0; i < unique.length; i += batch) {
    const chunk = unique.slice(i, i + batch);
    const details = await Promise.allSettled(chunk.map(r => deepScrape(r.website)));

    for (let j = 0; j < chunk.length; j++) {
      const r = chunk[j];
      const d = details[j].status === 'fulfilled' ? details[j].value : {};

      enriched.push(makeProspect({
        name: r.name,
        businessName: r.businessName,
        website: r.website,
        phone: d.phone || '',
        email: d.email || '',
        instagram: d.instagram || '',
        address: d.address || '',
        neighborhood: d.neighborhood || '',
        permitType: d.permitType || '',
        permitNumber: d.permitNumber || '',
        products: d.products || [],
        notes: r.notes + (d.description ? ' | ' + d.description : '')
      }, 'duckduckgo', r.website));
    }

    if (i + batch < unique.length) await new Promise(r => setTimeout(r, 1000));
  }

  return enriched;
}

// ── Source: Shef.com ─────────────────────────────────────────────────────────

async function scrapeShef() {
  const results = [];

  try {
    // Shef has a public API for browsing cooks by metro
    const html = await fetchPage('https://shef.com/homemade-food-delivery/los-angeles-metro', { timeout: 12000 });
    const $ = cheerio.load(html);

    // Look for embedded Next.js data or cook cards
    $('script#__NEXT_DATA__').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const pageProps = data?.props?.pageProps || {};

        // Shef embeds cook/menu data in page props
        const cooks = pageProps.chefs || pageProps.cooks || pageProps.shefs || [];
        if (Array.isArray(cooks)) {
          cooks.forEach(cook => {
            results.push(makeProspect({
              name: cook.name || cook.firstName || '',
              businessName: cook.businessName || cook.name || cook.firstName || '',
              neighborhood: cook.neighborhood || cook.area || '',
              website: cook.slug ? `https://shef.com/chef/${cook.slug}` : '',
              products: (cook.dishes || cook.menuItems || []).map(d => d.name || d.title || '').filter(Boolean).slice(0, 5),
              notes: cook.bio || cook.description || `Home cook on Shef.com`
            }, 'shef', 'https://shef.com/homemade-food-delivery/los-angeles-metro'));
          });
        }

        // Also try menu-level data
        const menus = pageProps.menus || pageProps.dishes || [];
        if (Array.isArray(menus) && results.length === 0) {
          const cookNames = new Set();
          menus.forEach(dish => {
            const cookName = dish.chefName || dish.shefName || dish.cookName || '';
            if (cookName && !cookNames.has(cookName)) {
              cookNames.add(cookName);
              results.push(makeProspect({
                name: cookName,
                businessName: cookName,
                website: dish.chefSlug ? `https://shef.com/chef/${dish.chefSlug}` : '',
                products: [dish.name || dish.title || ''],
                notes: `Found on Shef.com LA metro`
              }, 'shef', 'https://shef.com/homemade-food-delivery/los-angeles-metro'));
            }
          });
        }
      } catch (e) { /* skip */ }
    });

    // Fallback: parse HTML cook cards if no __NEXT_DATA__
    if (results.length === 0) {
      $('[class*="chef"], [class*="cook"], [class*="shef"], [data-testid*="chef"]').each((_, el) => {
        const card = $(el);
        const name = clean(card.find('h2, h3, h4, [class*="name"]').first().text());
        const link = card.find('a').first().attr('href');

        if (name && name.length > 2 && name.length < 60) {
          results.push(makeProspect({
            name,
            businessName: name,
            website: link?.startsWith('/') ? `https://shef.com${link}` : link || '',
            notes: 'Home cook on Shef.com'
          }, 'shef', 'https://shef.com/homemade-food-delivery/los-angeles-metro'));
        }
      });
    }

    // Also try to parse JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'ItemList' && data.itemListElement) {
          data.itemListElement.forEach(item => {
            const r = item.item || item;
            if (r.name && !results.find(p => p.businessName === r.name)) {
              results.push(makeProspect({
                name: r.name,
                businessName: r.name,
                website: r.url || '',
                notes: r.description || 'Listed on Shef.com'
              }, 'shef', 'https://shef.com/homemade-food-delivery/los-angeles-metro'));
            }
          });
        }
      } catch (e) { /* skip */ }
    });

  } catch (e) {
    results.push(makeProspect({
      name: 'Shef.com LA Metro',
      businessName: 'Shef.com LA Metro',
      website: 'https://shef.com/homemade-food-delivery/los-angeles-metro',
      notes: `Platform exists but scrape failed: ${e.message}. Manual review recommended — contains hundreds of LA home cooks.`
    }, 'shef-platform', 'https://shef.com/homemade-food-delivery/los-angeles-metro'));
  }

  return results;
}

// ── Source: CottageMadeMarket ────────────────────────────────────────────────

async function scrapeCottageMade() {
  const results = [];

  try {
    const html = await fetchPage('https://cottagemademarket.com/', { timeout: 12000 });
    const $ = cheerio.load(html);

    // Check for embedded data
    $('script#__NEXT_DATA__, script#__NUXT_DATA__').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const sellers = data?.props?.pageProps?.sellers || data?.props?.pageProps?.vendors || [];
        if (Array.isArray(sellers)) {
          sellers.forEach(s => {
            results.push(makeProspect({
              name: s.name || s.businessName || '',
              businessName: s.businessName || s.name || '',
              neighborhood: s.location || s.city || '',
              website: s.website || s.url || '',
              products: (s.products || []).map(p => p.name || p).filter(Boolean).slice(0, 5),
              notes: s.description || 'Listed on CottageMadeMarket.com'
            }, 'cottagemade', 'https://cottagemademarket.com/'));
          });
        }
      } catch (e) { /* skip */ }
    });

    // HTML fallback: parse seller cards
    if (results.length === 0) {
      $('[class*="seller"], [class*="vendor"], [class*="producer"], [class*="card"], article').each((_, el) => {
        const card = $(el);
        const name = clean(card.find('h2, h3, h4, [class*="name"]').first().text());
        const link = card.find('a').first().attr('href');
        const desc = clean(card.find('p, [class*="desc"]').first().text());

        if (name && name.length > 2 && name.length < 80) {
          results.push(makeProspect({
            name,
            businessName: name,
            website: link?.startsWith('/') ? `https://cottagemademarket.com${link}` : link || '',
            notes: desc || 'Listed on CottageMadeMarket.com'
          }, 'cottagemade', 'https://cottagemademarket.com/'));
        }
      });
    }

    // JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data.itemListElement) {
          data.itemListElement.forEach(item => {
            const r = item.item || item;
            if (r.name && !results.find(p => p.businessName === r.name)) {
              results.push(makeProspect({
                name: r.name,
                businessName: r.name,
                website: r.url || '',
                notes: r.description || 'CottageMadeMarket listing'
              }, 'cottagemade', 'https://cottagemademarket.com/'));
            }
          });
        }
      } catch (e) { /* skip */ }
    });

  } catch (e) {
    // Note the platform exists even if scrape fails
  }

  return results;
}

// ── Source: LA County DPH ────────────────────────────────────────────────────

async function scrapeLACounty() {
  const results = [];

  try {
    const html = await fetchPage('http://www.publichealth.lacounty.gov/eh/business/home-based-cottage-food.htm', { timeout: 12000 });
    const $ = cheerio.load(html);

    $('script, style, noscript').remove();
    const bodyText = clean($('body').text());

    // Look for links to operator lists, PDFs, or registration databases
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = clean($(el).text());
      if (href && (text.toLowerCase().includes('registered') || text.toLowerCase().includes('operator') || text.toLowerCase().includes('list') || text.toLowerCase().includes('directory') || href.includes('.pdf') || href.includes('.csv') || href.includes('.xlsx'))) {
        links.push({ href: href.startsWith('http') ? href : `http://www.publichealth.lacounty.gov${href.startsWith('/') ? '' : '/'}${href}`, text });
      }
    });

    // Extract any useful regulatory info
    const permitInfo = bodyText.match(/Class\s*[AB].*?(?:\.|$)/gi) || [];

    results.push(makeProspect({
      name: 'LA County DPH Cottage Food Program',
      businessName: 'LA County Homebased Food Program',
      website: 'http://www.publichealth.lacounty.gov/eh/business/home-based-cottage-food.htm',
      notes: `Official registry page. ${links.length} resource links found. ${permitInfo.length ? 'Permit types: ' + permitInfo.slice(0, 3).join('; ') : ''} ${links.map(l => l.text).join(', ').slice(0, 500)}`
    }, 'la-county', 'http://www.publichealth.lacounty.gov/eh/business/home-based-cottage-food.htm'));

    // Try to scrape any linked operator lists
    for (const link of links.slice(0, 3)) {
      try {
        if (link.href.endsWith('.pdf')) {
          results.push(makeProspect({
            name: link.text || 'LA County PDF Resource',
            businessName: link.text || 'LA County Cottage Food Resource',
            website: link.href,
            notes: `PDF document from LA County DPH: ${link.text}`
          }, 'la-county', link.href));
        } else {
          const subHtml = await fetchPage(link.href, { timeout: 10000 });
          const $sub = cheerio.load(subHtml);
          const subTitle = clean($sub('title').text());

          $sub('table tr').each((i, el) => {
            if (i === 0) return; // skip header
            const cells = [];
            $(el).find('td, th').each((_, td) => cells.push(clean($(td).text())));
            if (cells.length >= 2 && cells[0].length > 2 && cells[0].length < 100) {
              results.push(makeProspect({
                name: cells[0],
                businessName: cells[0],
                address: cells[1] || '',
                phone: cells[2] || '',
                permitNumber: cells[3] || '',
                notes: `From LA County DPH: ${subTitle}`
              }, 'la-county', link.href));
            }
          });
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) {
    // fallback
  }

  return results;
}

// ── Generic Webpage Scraper ──────────────────────────────────────────────────

async function scrapeWebpage(url) {
  const details = await deepScrape(url);
  if (details.error) {
    return [makeProspect({ name: url, businessName: url, website: url, notes: `Scrape failed: ${details.error}` }, 'webpage', url)];
  }

  const $ = cheerio.load(await fetchPage(url));
  const title = clean($('title').text()) || clean($('h1').first().text());
  const bizName = title.replace(/\s*[-|–—].*/g, '').trim() || url;

  return [makeProspect({
    name: bizName,
    businessName: bizName,
    website: url,
    ...details
  }, 'webpage', url)];
}

// ── Main Orchestrator ────────────────────────────────────────────────────────

async function scrapeAll(options = {}) {
  const { source, url } = options;
  const log = [];
  let allProspects = [];

  const runSource = async (name, fn) => {
    const start = Date.now();
    log.push({ source: name, status: 'started', time: new Date().toISOString() });
    try {
      const results = await fn();
      const elapsed = Date.now() - start;
      log.push({ source: name, status: 'done', count: results.length, elapsed: `${elapsed}ms` });
      return results;
    } catch (e) {
      const elapsed = Date.now() - start;
      log.push({ source: name, status: 'error', error: e.message, elapsed: `${elapsed}ms` });
      return [];
    }
  };

  if (source && source !== 'all') {
    switch (source) {
      case 'duckduckgo':
        allProspects = await runSource('duckduckgo', scrapeDuckDuckGo);
        break;
      case 'shef':
        allProspects = await runSource('shef', scrapeShef);
        break;
      case 'cottagemade':
        allProspects = await runSource('cottagemade', scrapeCottageMade);
        break;
      case 'la-county':
        allProspects = await runSource('la-county', scrapeLACounty);
        break;
      case 'webpage':
        if (!url) throw new Error('URL required for webpage scraper');
        allProspects = await runSource('webpage', () => scrapeWebpage(url));
        break;
      default:
        throw new Error(`Unknown source: ${source}. Valid: duckduckgo, shef, cottagemade, la-county, webpage`);
    }
  } else {
    // Run all sources in parallel
    const [ddg, shef, cottagemade, laCounty] = await Promise.allSettled([
      runSource('duckduckgo', scrapeDuckDuckGo),
      runSource('shef', scrapeShef),
      runSource('cottagemade', scrapeCottageMade),
      runSource('la-county', scrapeLACounty)
    ]);

    allProspects = [
      ...(ddg.status === 'fulfilled' ? ddg.value : []),
      ...(shef.status === 'fulfilled' ? shef.value : []),
      ...(cottagemade.status === 'fulfilled' ? cottagemade.value : []),
      ...(laCounty.status === 'fulfilled' ? laCounty.value : [])
    ];
  }

  // Deduplicate by business name (case-insensitive)
  const seen = new Map();
  const deduped = [];
  for (const p of allProspects) {
    const key = (p.businessName || p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length < 2) continue;
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (!existing.phone && p.phone) existing.phone = p.phone;
      if (!existing.email && p.email) existing.email = p.email;
      if (!existing.website && p.website) existing.website = p.website;
      if (!existing.instagram && p.instagram) existing.instagram = p.instagram;
      if (!existing.address && p.address) existing.address = p.address;
      if (!existing.neighborhood && p.neighborhood) existing.neighborhood = p.neighborhood;
      if (!existing.permitNumber && p.permitNumber) existing.permitNumber = p.permitNumber;
      if (!existing.permitType && p.permitType) existing.permitType = p.permitType;
      if (p.products?.length && !existing.products?.length) existing.products = p.products;
      if (p.notes && !existing.notes.includes(p.notes.slice(0, 50))) {
        existing.notes = (existing.notes + ' | ' + p.notes).slice(0, 2000);
      }
    } else {
      seen.set(key, p);
      deduped.push(p);
    }
  }

  return { prospects: deduped, log, total: deduped.length };
}

module.exports = { scrapeAll, scrapeDuckDuckGo, scrapeShef, scrapeCottageMade, scrapeLACounty, scrapeWebpage };
