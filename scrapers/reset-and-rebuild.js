#!/usr/bin/env node
/**
 * Reset & Rebuild — Clears all converted data and re-runs bulk-make-live
 * 1. Resets all prospects to status=prospect (clears convertedAt, convertedUserId)
 * 2. Empties elements.json, users.json, products.json
 * 3. Starts server on port 4180
 * 4. Calls admin login + bulk-make-live
 * 5. Kills server and prints results
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  console.log('\n============================================================');
  console.log('  Reset & Rebuild — Re-converting all prospects');
  console.log('============================================================\n');

  // Step 1: Reset all prospect statuses
  console.log('Step 1: Resetting all prospect statuses to "prospect"...');
  const prospectsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prospects.json'), 'utf-8'));
  let resetCount = 0;
  for (const p of prospectsData.prospects) {
    if (p.status === 'approved' || p.convertedUserId) {
      p.status = 'prospect';
      p.convertedAt = null;
      p.convertedUserId = null;
      resetCount++;
    }
  }
  fs.writeFileSync(path.join(DATA_DIR, 'prospects.json'), JSON.stringify(prospectsData, null, 2));
  console.log(`  Reset ${resetCount} prospects to "prospect" status`);

  // Step 2: Empty data files
  console.log('\nStep 2: Clearing elements, users, and products...');
  fs.writeFileSync(path.join(DATA_DIR, 'elements.json'), JSON.stringify({ elements: [] }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'users.json'), JSON.stringify({ users: [] }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), JSON.stringify({ products: [] }, null, 2));
  console.log('  Cleared elements.json, users.json, products.json');

  // Step 3: Start server on port 4180
  console.log('\nStep 3: Starting server on port 4180...');
  const serverProcess = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProcess.stdout.on('data', d => serverOutput += d.toString());
  serverProcess.stderr.on('data', d => serverOutput += d.toString());

  // Wait for server to be ready
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch('http://localhost:4180/api/config', {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) {
        ready = true;
        console.log('  Server is ready');
        break;
      }
    } catch (_) {}
  }

  if (!ready) {
    console.error('  ERROR: Server did not start in time');
    console.error('  Server output:', serverOutput);
    serverProcess.kill('SIGTERM');
    process.exit(1);
  }

  // Step 4: Login and bulk-make-live
  try {
    console.log('\nStep 4: Admin login...');
    const loginRes = await fetch('http://localhost:4180/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'kinseb-admin-2026' }),
      signal: AbortSignal.timeout(5000)
    });
    const loginData = await loginRes.json();
    if (!loginData.ok) {
      throw new Error('Admin login failed: ' + JSON.stringify(loginData));
    }
    console.log('  Logged in successfully');

    // Extract the cookie
    const setCookie = loginRes.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.split(';')[0] : '';
    console.log('  Got admin cookie');

    console.log('\nStep 5: Running bulk-make-live...');
    const bulkRes = await fetch('http://localhost:4180/api/admin/prospects/bulk-make-live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60000)
    });
    const bulkData = await bulkRes.json();
    console.log('  Response:', JSON.stringify(bulkData, null, 2).slice(0, 500));

    if (bulkData.ok) {
      console.log(`\n  Converted: ${bulkData.converted} / ${bulkData.total}`);

      // Count results
      const skipped = (bulkData.results || []).filter(r => r.skipped);
      const converted = (bulkData.results || []).filter(r => r.converted);
      const noCoords = skipped.filter(r => r.reason === 'no coordinates');
      const alreadyConverted = skipped.filter(r => r.reason === 'already converted');

      console.log(`  Successfully converted: ${converted.length}`);
      console.log(`  Skipped (no coordinates): ${noCoords.length}`);
      console.log(`  Skipped (already converted): ${alreadyConverted.length}`);
    } else {
      console.error('  Bulk make live failed:', bulkData.error);
    }

  } catch (e) {
    console.error('  Error during API calls:', e.message);
  }

  // Step 6: Kill server
  console.log('\nStep 6: Shutting down server...');
  serverProcess.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));

  // Final summary
  console.log('\n============================================================');
  console.log('  REBUILD COMPLETE');
  console.log('============================================================');

  const finalElements = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'elements.json'), 'utf-8'));
  const finalUsers = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf-8'));
  const finalProducts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'products.json'), 'utf-8'));
  const finalProspects = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prospects.json'), 'utf-8'));

  console.log(`  Elements (map pins):    ${finalElements.elements.length}`);
  console.log(`  Users (sellers):        ${finalUsers.users.length}`);
  console.log(`  Products (menu items):  ${finalProducts.products.length}`);
  console.log(`  Prospects total:        ${finalProspects.prospects.length}`);
  console.log(`  Prospects converted:    ${finalProspects.prospects.filter(p => p.status === 'approved').length}`);
  console.log(`  Prospects remaining:    ${finalProspects.prospects.filter(p => p.status === 'prospect').length}`);

  // Show product breakdown
  const sellersWithProducts = {};
  for (const prod of finalProducts.products) {
    sellersWithProducts[prod.sellerName] = (sellersWithProducts[prod.sellerName] || 0) + 1;
  }
  const topSellers = Object.entries(sellersWithProducts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topSellers.length > 0) {
    console.log('\n  Top sellers by product count:');
    topSellers.forEach(([name, count]) => console.log(`    ${name}: ${count} products`));
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
