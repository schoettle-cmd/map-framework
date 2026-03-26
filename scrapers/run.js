#!/usr/bin/env node
/**
 * Standalone runner — execute the MEHKO scraper and dump results
 * Usage: node scrapers/run.js [source] [--skip-enrich]
 */

const { scrapeAll } = require('./index');

(async () => {
  const args = process.argv.slice(2);
  const source = args.find(a => !a.startsWith('--')) || 'all';
  const skipEnrich = args.includes('--skip-enrich');

  console.log(`\n🔍 Starting MEHKO scrape — source: ${source}${skipEnrich ? ' (skip enrichment)' : ''}\n`);
  const start = Date.now();

  try {
    const result = await scrapeAll({ source, skipEnrich });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n✅ Scraping complete in ${elapsed}s`);
    console.log(`   Total prospects: ${result.total}`);

    // Stats
    const withPhone = result.prospects.filter(p => p.phone).length;
    const withEmail = result.prospects.filter(p => p.email).length;
    const withIG = result.prospects.filter(p => p.instagram).length;
    const withSite = result.prospects.filter(p => p.website).length;
    const withCoords = result.prospects.filter(p => p.lat).length;

    console.log(`   With coordinates: ${withCoords}`);
    console.log(`   With website: ${withSite}`);
    console.log(`   With Instagram: ${withIG}`);
    console.log(`   With phone: ${withPhone}`);
    console.log(`   With email: ${withEmail}`);

    // Cuisine breakdown
    const cuisines = {};
    result.prospects.forEach(p => {
      const c = p.cuisineType || 'Unknown';
      cuisines[c] = (cuisines[c] || 0) + 1;
    });
    console.log('\n── Cuisine Types ────────────────────────────────');
    Object.entries(cuisines).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
      console.log(`   ${c}: ${n}`);
    });

    // City breakdown (top 15)
    const cities = {};
    result.prospects.forEach(p => {
      const c = p.neighborhood || 'Unknown';
      cities[c] = (cities[c] || 0) + 1;
    });
    console.log('\n── Top Cities/Neighborhoods ─────────────────────');
    Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([c, n]) => {
      console.log(`   ${c}: ${n}`);
    });

    console.log('\n── Log ──────────────────────────────────────────');
    result.log.forEach(l => {
      console.log(`   [${l.source}] ${l.status}${l.count !== undefined ? ` — ${l.count} results` : ''}${l.elapsed ? ` (${l.elapsed})` : ''}${l.error ? ` — ${l.error}` : ''}${l.note ? ` — ${l.note}` : ''}`);
    });

    // Show enriched entries (ones with contact info)
    const enriched = result.prospects.filter(p => p.phone || p.email || p.instagram || p.website);
    console.log(`\n── Enriched Prospects (${enriched.length} with contact info) ──`);
    enriched.slice(0, 30).forEach((p, i) => {
      console.log(`\n${i + 1}. ${p.businessName}${p.cuisineType ? ` [${p.cuisineType}]` : ''}`);
      if (p.address) console.log(`   📍 ${p.address}`);
      if (p.phone) console.log(`   📞 ${p.phone}`);
      if (p.email) console.log(`   📧 ${p.email}`);
      if (p.website) console.log(`   🌐 ${p.website}`);
      if (p.instagram) console.log(`   📸 ${p.instagram}`);
      if (p.permitNumber) console.log(`   📋 ${p.permitNumber}`);
      if (p.tags) console.log(`   🏷️  ${p.tags}`);
    });

    // Save results
    const fs = require('fs');
    const outPath = require('path').join(__dirname, '..', 'data', 'scrape_results.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\n📁 Raw JSON saved to data/scrape_results.json`);

  } catch (e) {
    console.error(`\n❌ Error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
})();
