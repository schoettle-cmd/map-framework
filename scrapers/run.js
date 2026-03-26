#!/usr/bin/env node
/**
 * Standalone runner — execute the scraper and dump results to stdout
 * Usage: node scrapers/run.js [source] [query]
 */

const { scrapeAll } = require('./index');

(async () => {
  const source = process.argv[2] || 'all';
  const query = process.argv[3] || undefined;

  console.log(`\n🔍 Starting scrape — source: ${source}${query ? `, query: "${query}"` : ''}\n`);
  const start = Date.now();

  try {
    const result = await scrapeAll({ source, query });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n✅ Scraping complete in ${elapsed}s`);
    console.log(`   Total prospects found: ${result.total}`);
    console.log('\n── Log ──────────────────────────────────────────');
    result.log.forEach(l => {
      console.log(`   [${l.source}] ${l.status}${l.count !== undefined ? ` — ${l.count} results` : ''}${l.elapsed ? ` (${l.elapsed})` : ''}${l.error ? ` — ${l.error}` : ''}`);
    });

    if (result.prospects.length > 0) {
      console.log('\n── Prospects ────────────────────────────────────');
      result.prospects.forEach((p, i) => {
        console.log(`\n${i + 1}. ${p.businessName || p.name}`);
        if (p.neighborhood) console.log(`   📍 ${p.neighborhood}`);
        if (p.address) console.log(`   📍 ${p.address}`);
        if (p.phone) console.log(`   📞 ${p.phone}`);
        if (p.email) console.log(`   📧 ${p.email}`);
        if (p.website) console.log(`   🌐 ${p.website}`);
        if (p.instagram) console.log(`   📸 ${p.instagram}`);
        if (p.products?.length) console.log(`   🍞 ${p.products.join(', ')}`);
        if (p.notes) console.log(`   📝 ${p.notes.slice(0, 200)}`);
        console.log(`   [source: ${p.source}]`);
      });
    }

    // Also write raw JSON for reference
    const fs = require('fs');
    const outPath = require('path').join(__dirname, '..', 'data', 'scrape_results.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\n📁 Raw JSON saved to data/scrape_results.json`);

  } catch (e) {
    console.error(`\n❌ Error: ${e.message}`);
    process.exit(1);
  }
})();
