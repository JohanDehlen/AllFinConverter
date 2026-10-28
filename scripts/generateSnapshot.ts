/**
 * AllFinConverter Production Rate Snapshot Generator CLI Script
 *
 * Standalone script to explicitly query real rate providers (Frankfurter, Fixed Peg AED,
 * CoinMarketCap, Gold-API), assemble the 19-asset canonical composite dataset, validate it,
 * and atomically update the application's latest rate snapshot.
 *
 * Usage:
 *   node scripts/generateSnapshot.ts
 *   or:
 *   npm run snapshot:generate
 *
 * Environment Variables:
 *   COINMARKETCAP_API_KEY (Required): CoinMarketCap API key for cryptocurrency quotes.
 */

import { runProductionSnapshotPipeline } from '../src/lib/generateSnapshotCore.ts';

async function main() {
  console.log('====================================================');
  console.log(' AllFinConverter — Production Rate Snapshot Generator');
  console.log('====================================================');

  const apiKey = process.env.COINMARKETCAP_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n[ERROR] Missing CoinMarketCap API Key.');
    console.error('The environment variable COINMARKETCAP_API_KEY is required to fetch real cryptocurrency quotes.');
    console.error('\nTo provide your key:');
    console.error('  PowerShell: $env:COINMARKETCAP_API_KEY="your_api_key_here"; node scripts/generateSnapshot.ts');
    console.error('  Bash/Zsh:   COINMARKETCAP_API_KEY="your_api_key_here" node scripts/generateSnapshot.ts\n');
    process.exit(1);
  }

  console.log('\n[1/3] Fetching rates from real production sources...');
  console.log('  - Fiat Currencies:    Frankfurter (European Central Bank reference rates)');
  console.log('  - UAE Dirham (AED):   Official USD Fixed Peg (1 USD = 3.6725 AED)');
  console.log('  - Cryptocurrencies:   CoinMarketCap (BTC, ETH, SOL, XRP, DOGE)');
  console.log('  - Precious Metals:    Gold-API (XAU, XAG, XPT, XPD)');

  try {
    const startTime = Date.now();
    const { snapshot, writeResult } = await runProductionSnapshotPipeline();
    const elapsed = Date.now() - startTime;

    console.log(`\n[2/3] Validation passed successfully in ${elapsed}ms:`);
    console.log(`  - Version:       ${snapshot.version}`);
    console.log(`  - Base Asset:    ${snapshot.baseAsset}`);
    console.log(`  - Timestamp:     ${new Date(snapshot.timestamp).toISOString()} (${snapshot.timestamp})`);
    console.log(`  - Is Mock:       ${snapshot.isMock} (verified live)`);
    console.log(`  - Assets:        ${Object.keys(snapshot.rates).length} canonical assets present`);

    console.log('\n[3/3] Atomically wrote snapshot:');
    console.log(`  - Primary File:  ${writeResult.primaryPath} (${writeResult.primaryBytes} bytes)`);
    if (writeResult.distPath) {
      console.log(`  - Dist Mirror:   ${writeResult.distPath} (${writeResult.distBytes} bytes)`);
    }

    console.log('\nAsset Summary:');
    for (const [code, rate] of Object.entries(snapshot.rates)) {
      const prov = snapshot.provenance[code];
      const sourceName = prov ? prov.sourceName : 'Unknown';
      console.log(`  ${code.padEnd(5)} = ${rate.padEnd(20)} [Source: ${sourceName}]`);
    }

    console.log('\n[SUCCESS] Production rate snapshot successfully generated and verified.\n');
  } catch (err) {
    console.error('\n[FAILED] Production rate snapshot generation failed.');
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\nThe existing snapshot was left completely untouched.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[UNEXPECTED ERROR]', err);
  process.exit(1);
});
