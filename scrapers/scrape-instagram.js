#!/usr/bin/env node
/**
 * Instagram Scraper — Extracts profile pics and bio data for chef listings.
 * Instagram serves profile pictures and some metadata without auth.
 * Post images require authentication so we only get the profile photo.
 *
 * Usage: node scrapers/scrape-instagram.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeProfile(username) {
  const url = `https://www.instagram.com/${username}/`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extract profile pic — CDN JPG in the t51.2885-19 path (profile images)
  const cdnMatches = [...html.matchAll(/https?:\\?\/?\\?\/?scontent[^"'\s<>]*\.jpg[^"'\s<>]*/g)]
    .map(m => m[0].replace(/\\/g, '').replace(/&amp;/g, '&'))
    .filter(u => u.includes('t51.2885-19') && !u.includes('rsrc.php'));

  let profilePic = cdnMatches[0] || '';
  // Upscale from 100x100 to 320x320
  if (profilePic) {
    profilePic = profilePic.replace(/s\d+x\d+/, 's320x320');
  }

  // Extract biography — find in the embedded JSON data
  let bio = '';
  const bioMatch = html.match(/"biography":"([^"]{0,500})"/);
  if (bioMatch) {
    bio = bioMatch[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, ' ')
      .trim();
  }

  // Extract full name
  let fullName = '';
  const nameMatch = html.match(/"full_name":"([^"]{0,200})"/);
  if (nameMatch) fullName = nameMatch[1];

  // External URL from IG bio
  let externalUrl = '';
  const urlMatch = html.match(/"external_url":"(https?:[^"]+)"/);
  if (urlMatch) {
    externalUrl = urlMatch[1].replace(/\\/g, '').replace(/\\u0026/g, '&');
  }

  // Follower count
  let followers = 0;
  const followMatch = html.match(/"edge_followed_by":\{"count":(\d+)\}/);
  if (followMatch) followers = parseInt(followMatch[1], 10);

  if (!profilePic) throw new Error('No profile pic found');

  return { profilePic, bio, fullName, externalUrl, followers };
}

async function main() {
  const elData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'elements.json'), 'utf-8'));
  const prosData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prospects.json'), 'utf-8'));

  const withIG = elData.elements.filter(e => e.instagram);
  const needImage = withIG.filter(e => !e.imageUrl || e.imageUrl.includes('unsplash.com'));

  console.log(`=== Instagram Profile Scraper ===`);
  console.log(`Total with Instagram: ${withIG.length}`);
  console.log(`Need image (no image or Unsplash placeholder): ${needImage.length}\n`);

  let found = 0, failed = 0, bioUpdated = 0, urlUpdated = 0;

  for (let i = 0; i < needImage.length; i++) {
    const el = needImage[i];
    const handle = el.instagram.replace(/^@/, '').trim();
    if (!handle) { console.log(`[${i+1}/${needImage.length}] SKIP: ${el.title} — empty handle`); continue; }

    try {
      const data = await scrapeProfile(handle);
      el.imageUrl = data.profilePic;
      found++;

      // Update bio if we got one and element has no description
      if (data.bio && (!el.description || el.description.length < 20)) {
        el.description = data.bio;
        bioUpdated++;
      }

      // Update external URL if element doesn't have one
      if (data.externalUrl && !el.externalOrderUrl) {
        el.externalOrderUrl = data.externalUrl;
        urlUpdated++;
      }

      // Sync to prospect
      const p = prosData.prospects.find(pr => pr.id === (el.metadata && el.metadata.prospectId));
      if (p) {
        p.imageUrl = data.profilePic;
        if (data.bio && (!p.notes || p.notes.length < 20)) p.notes = data.bio;
      }

      const extras = [];
      if (data.bio) extras.push('bio');
      if (data.externalUrl) extras.push('url');
      if (data.followers) extras.push(`${data.followers} followers`);
      console.log(`[${i+1}/${needImage.length}] OK: ${el.title} — pic${extras.length ? ' + ' + extras.join(', ') : ''}`);
    } catch (e) {
      failed++;
      console.log(`[${i+1}/${needImage.length}] FAIL: ${el.title} (@${handle}) — ${e.message}`);
    }

    // Rate limit: ~1.2s between requests
    await sleep(1200);
  }

  // Save
  fs.writeFileSync(path.join(DATA_DIR, 'elements.json'), JSON.stringify(elData, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'prospects.json'), JSON.stringify(prosData, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Profile pics found: ${found}/${needImage.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Bios updated: ${bioUpdated}`);
  console.log(`External URLs added: ${urlUpdated}`);
  console.log(`Total with images: ${elData.elements.filter(e => e.imageUrl).length}/${elData.elements.length}`);
  console.log(`  Real images: ${elData.elements.filter(e => e.imageUrl && !e.imageUrl.includes('unsplash.com')).length}`);
  console.log(`  Unsplash placeholders: ${elData.elements.filter(e => e.imageUrl && e.imageUrl.includes('unsplash.com')).length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
