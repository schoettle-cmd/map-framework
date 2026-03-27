/**
 * Image Scraper for Chef Elements
 *
 * Finds images for elements missing imageUrl using three strategies:
 *   1. Deep scrape business websites (externalOrderUrl) — og:image, JSON-LD, logos
 *   2. Instagram profile og:image extraction
 *   3. DuckDuckGo search fallback — result thumbnails + og:image from top results
 *
 * Usage: node scrapers/scrape-images.js
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { deepScrape } = require('./index');

// ── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const ELEMENTS_PATH = path.join(DATA_DIR, 'elements.json');
const PROSPECTS_PATH = path.join(DATA_DIR, 'prospects.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 10000;
const RATE_LIMIT_MS = 1000;  // 1 request per second
const BATCH_SIZE = 5;        // max concurrent requests

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...opts.headers
    },
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Rate-limited fetch — ensures minimum delay between calls.
 * Tracks global last-request time.
 */
let lastRequestTime = 0;
async function rateLimitedFetch(url, opts = {}) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();
  return fetchPage(url, opts);
}

function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  // Filter out tiny tracking pixels, SVG placeholders, generic platform images
  const blacklist = [
    'pixel', 'spacer', '1x1', 'blank.gif', 'transparent.png',
    'facebook.com/tr', 'google-analytics', 'doubleclick',
    'static.xx.fbcdn.net/rsrc',  // Facebook platform assets
    'platform-lookaside.fbsbx.com',  // Facebook platform
    'scontent-', // Instagram CDN — often ephemeral
    'static.cdninstagram.com/rsrc', // Instagram generic placeholder
  ];
  const lower = url.toLowerCase();
  if (blacklist.some(b => lower.includes(b))) return false;
  return true;
}

// ── Strategy 1: Deep Scrape Website ─────────────────────────────────────────

async function scrapeWebsiteImage(url) {
  const result = await deepScrape(url);
  if (result.error) throw new Error(result.error);
  if (isValidImageUrl(result.imageUrl)) return result.imageUrl;
  throw new Error('No image found on website');
}

// ── Strategy 2: Instagram Profile og:image ──────────────────────────────────

async function scrapeInstagramImage(handle) {
  const username = handle.replace(/^@/, '').trim();
  if (!username) throw new Error('Empty Instagram handle');

  const url = `https://www.instagram.com/${username}/`;
  const html = await rateLimitedFetch(url, { timeout: TIMEOUT });
  const $ = cheerio.load(html);

  // Try og:image
  let imageUrl = $('meta[property="og:image"]').attr('content') || '';
  if (isValidImageUrl(imageUrl)) return imageUrl;

  // Try twitter:image
  imageUrl = $('meta[name="twitter:image"]').attr('content') || '';
  if (isValidImageUrl(imageUrl)) return imageUrl;

  throw new Error('No og:image from Instagram');
}

// ── Strategy 3: DuckDuckGo Search Fallback ──────────────────────────────────

async function scrapeDuckDuckGoImage(businessName, neighborhood) {
  const query = `${businessName} ${neighborhood || ''} food`.trim();
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const html = await rateLimitedFetch(searchUrl, { timeout: TIMEOUT });
  const $ = cheerio.load(html);

  // Attempt 1: Look for result thumbnails / image URLs in the search page
  const resultImages = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (isValidImageUrl(src) && !src.includes('duckduckgo.com')) {
      resultImages.push(src);
    }
  });

  if (resultImages.length > 0) return resultImages[0];

  // Attempt 2: Fetch og:image from the first few search result URLs
  const resultUrls = [];
  $('a.result__a, a.result__url').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('http') && !href.includes('duckduckgo.com')) {
      resultUrls.push(href);
    }
  });

  // Also try extracting URLs from the uddg parameter (DuckDuckGo redirect format)
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/uddg=([^&]+)/);
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1]);
        if (decoded.startsWith('http')) resultUrls.push(decoded);
      } catch (_) {}
    }
  });

  // De-duplicate
  const uniqueUrls = [...new Set(resultUrls)].slice(0, 3);

  for (const resultUrl of uniqueUrls) {
    try {
      const pageHtml = await rateLimitedFetch(resultUrl, { timeout: TIMEOUT });
      const $page = cheerio.load(pageHtml);
      const ogImage = $page('meta[property="og:image"]').attr('content') || '';
      if (isValidImageUrl(ogImage)) return ogImage;

      // Try twitter:image as fallback
      const twImage = $page('meta[name="twitter:image"]').attr('content') || '';
      if (isValidImageUrl(twImage)) return twImage;
    } catch (_) {
      // Failed to fetch this result, try the next
      continue;
    }
  }

  throw new Error('No image found via DuckDuckGo');
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

async function processElement(element, index, total) {
  const label = `[${index + 1}/${total}]`;
  const name = element.title || element.businessName || 'Unknown';

  // Strategy 1: Website deep scrape
  if (element.externalOrderUrl) {
    try {
      const imageUrl = await scrapeWebsiteImage(element.externalOrderUrl);
      console.log(`${label} OK (website): ${name} - ${imageUrl}`);
      return imageUrl;
    } catch (e) {
      console.log(`${label} WARN (website): ${name} - ${e.message}, trying next strategy...`);
    }
  }

  // Strategy 2: Instagram
  if (element.instagram) {
    try {
      const imageUrl = await scrapeInstagramImage(element.instagram);
      console.log(`${label} OK (instagram): ${name} - ${imageUrl}`);
      return imageUrl;
    } catch (e) {
      console.log(`${label} WARN (instagram): ${name} - ${e.message}, trying DuckDuckGo...`);
    }
  }

  // Strategy 3: DuckDuckGo search
  try {
    const neighborhood = element.subtitle || '';
    const imageUrl = await scrapeDuckDuckGoImage(name, neighborhood);
    console.log(`${label} OK (duckduckgo): ${name} - ${imageUrl}`);
    return imageUrl;
  } catch (e) {
    console.log(`${label} FAIL: ${name} - ${e.message}`);
    return null;
  }
}

async function runBatch(items, batchSize, processFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processFn(item))
    );
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  console.log('=== Chef Element Image Scraper ===\n');

  // Load data
  const elementsData = JSON.parse(fs.readFileSync(ELEMENTS_PATH, 'utf-8'));
  const prospectsData = JSON.parse(fs.readFileSync(PROSPECTS_PATH, 'utf-8'));

  const elements = elementsData.elements;
  const prospects = prospectsData.prospects;

  // Build prospect lookup by business name (for syncing results back)
  const prospectByName = new Map();
  for (const p of prospects) {
    const key = (p.businessName || p.name || '').toLowerCase().trim();
    if (key) prospectByName.set(key, p);
  }

  // Also build prospect lookup by prospectId from element metadata
  const prospectById = new Map();
  for (const p of prospects) {
    prospectById.set(p.id, p);
  }

  // Filter to elements missing imageUrl
  const needImages = elements.filter(e => !e.imageUrl);

  console.log(`Total elements: ${elements.length}`);
  console.log(`Already have images: ${elements.length - needImages.length}`);
  console.log(`Need images: ${needImages.length}`);
  console.log(`  - With website (externalOrderUrl): ${needImages.filter(e => e.externalOrderUrl).length}`);
  console.log(`  - With Instagram (no website): ${needImages.filter(e => e.instagram && !e.externalOrderUrl).length}`);
  console.log(`  - No web presence: ${needImages.filter(e => !e.externalOrderUrl && !e.instagram).length}`);
  console.log(`\nStarting scrape...\n`);

  // Process in batches
  let found = 0;
  let attempted = 0;
  const total = needImages.length;

  for (let i = 0; i < needImages.length; i += BATCH_SIZE) {
    const batch = needImages.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map((element, batchIdx) => {
      const globalIdx = i + batchIdx;
      return processElement(element, globalIdx, total);
    });

    const results = await Promise.all(batchPromises);

    for (let j = 0; j < batch.length; j++) {
      attempted++;
      const imageUrl = results[j];
      if (imageUrl) {
        found++;
        const element = batch[j];
        element.imageUrl = imageUrl;

        // Sync to matching prospect
        const prospectId = element.metadata?.prospectId;
        let prospect = prospectId ? prospectById.get(prospectId) : null;
        if (!prospect) {
          const key = (element.title || '').toLowerCase().trim();
          prospect = prospectByName.get(key);
        }
        if (prospect) {
          prospect.imageUrl = imageUrl;
        }
      }
    }

    // Small breathing room between batches
    if (i + BATCH_SIZE < needImages.length) {
      await sleep(500);
    }
  }

  // Save updated data
  console.log('\nSaving results...');
  fs.writeFileSync(ELEMENTS_PATH, JSON.stringify(elementsData, null, 2), 'utf-8');
  fs.writeFileSync(PROSPECTS_PATH, JSON.stringify(prospectsData, null, 2), 'utf-8');

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Attempted: ${attempted}`);
  console.log(`Found:     ${found}`);
  console.log(`Failed:    ${attempted - found}`);
  console.log(`Success rate: ${((found / attempted) * 100).toFixed(1)}%`);
  console.log(`\nTotal elements with images now: ${elements.filter(e => e.imageUrl).length} / ${elements.length}`);
  console.log(`\nFiles updated:`);
  console.log(`  ${ELEMENTS_PATH}`);
  console.log(`  ${PROSPECTS_PATH}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
