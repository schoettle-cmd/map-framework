#!/usr/bin/env node
/**
 * Scrape images from chef websites that have externalOrderUrl but no imageUrl.
 * Extracts og:image, twitter:image, JSON-LD image/logo, apple-touch-icon.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DATA_DIR = path.join(__dirname, '..', 'data');

async function extractImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(10000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Priority 1: og:image
  let img = $('meta[property="og:image"]').attr('content') || '';
  // Priority 2: twitter:image
  if (!img) img = $('meta[name="twitter:image"]').attr('content') || '';
  // Priority 3: JSON-LD
  if (!img) {
    $('script[type="application/ld+json"]').each((_, s) => {
      if (img) return;
      try {
        const ld = JSON.parse($(s).html());
        const items = Array.isArray(ld) ? ld : [ld];
        for (const item of items) {
          if (item.image && !img) {
            const i = Array.isArray(item.image) ? item.image[0] : item.image;
            img = typeof i === 'string' ? i : (i && i.url) || '';
          }
          if (item.logo && !img) {
            img = typeof item.logo === 'string' ? item.logo : (item.logo && item.logo.url) || '';
          }
        }
      } catch (_) {}
    });
  }
  // Priority 4: apple-touch-icon
  if (!img) img = $('link[rel="apple-touch-icon"]').attr('href') || '';
  // Priority 5: first large img tag
  if (!img) {
    $('img').each((_, el) => {
      if (img) return;
      const src = $(el).attr('src') || '';
      const width = parseInt($(el).attr('width') || '0', 10);
      if (src && (width >= 200 || src.includes('hero') || src.includes('banner') || src.includes('logo'))) {
        img = src;
      }
    });
  }

  // Make absolute
  if (img && !img.startsWith('http')) {
    try { img = new URL(img, url).href; } catch (_) { img = ''; }
  }

  // Validate
  if (!img || !img.startsWith('http')) throw new Error('No image found');
  const lower = img.toLowerCase();
  if (['pixel', 'spacer', '1x1', 'blank.gif', 'transparent'].some(b => lower.includes(b))) {
    throw new Error('Only tracking pixel found');
  }

  return img;
}

async function main() {
  const elData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'elements.json'), 'utf-8'));
  const prosData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prospects.json'), 'utf-8'));

  // All elements without images that have ANY web presence
  const withWebsite = elData.elements.filter(e => !e.imageUrl && e.externalOrderUrl);
  const withIG = elData.elements.filter(e => !e.imageUrl && !e.externalOrderUrl && e.instagram);
  const noPresence = elData.elements.filter(e => !e.imageUrl && !e.externalOrderUrl && !e.instagram);

  console.log(`=== Website Image Scraper ===`);
  console.log(`Already have images: ${elData.elements.filter(e => e.imageUrl).length}`);
  console.log(`With website, need image: ${withWebsite.length}`);
  console.log(`With Instagram only: ${withIG.length}`);
  console.log(`No web presence: ${noPresence.length}\n`);

  let found = 0;

  // Scrape websites
  for (let i = 0; i < withWebsite.length; i++) {
    const el = withWebsite[i];
    try {
      const img = await extractImage(el.externalOrderUrl);
      el.imageUrl = img;
      const p = prosData.prospects.find(pr => pr.id === (el.metadata && el.metadata.prospectId));
      if (p) p.imageUrl = img;
      found++;
      console.log(`[${i + 1}/${withWebsite.length}] OK: ${el.title} — ${img.slice(0, 80)}`);
    } catch (e) {
      console.log(`[${i + 1}/${withWebsite.length}] FAIL: ${el.title} — ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  // Try Instagram profiles
  console.log(`\n--- Instagram profiles ---`);
  let igFound = 0;
  for (let i = 0; i < withIG.length; i++) {
    const el = withIG[i];
    const username = el.instagram.replace(/^@/, '').trim();
    if (!username) { console.log(`[${i + 1}/${withIG.length}] SKIP: ${el.title} — empty handle`); continue; }
    try {
      const img = await extractImage(`https://www.instagram.com/${username}/`);
      el.imageUrl = img;
      const p = prosData.prospects.find(pr => pr.id === (el.metadata && el.metadata.prospectId));
      if (p) p.imageUrl = img;
      igFound++;
      found++;
      console.log(`[${i + 1}/${withIG.length}] OK: ${el.title} — ${img.slice(0, 80)}`);
    } catch (e) {
      console.log(`[${i + 1}/${withIG.length}] FAIL: ${el.title} — ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1100));
  }

  // Save
  fs.writeFileSync(path.join(DATA_DIR, 'elements.json'), JSON.stringify(elData, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'prospects.json'), JSON.stringify(prosData, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Website images found: ${found - igFound}/${withWebsite.length}`);
  console.log(`Instagram images found: ${igFound}/${withIG.length}`);
  console.log(`Total with images now: ${elData.elements.filter(e => e.imageUrl).length}/${elData.elements.length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
