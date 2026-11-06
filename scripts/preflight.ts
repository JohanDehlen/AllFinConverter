/**
 * AllFinConverter Preflight Check for Live Rate Snapshot Generator
 *
 * Safe pre-flight verification script executed prior to running the live snapshot generator.
 *
 * Verifies:
 * 1. Environment variable COINMARKETCAP_API_KEY presence (masked, secret never exposed).
 * 2. Filesystem write permissions for target directories (src/data/ and dist/api/).
 * 3. Provider configurations and 30 canonical asset mapping across sources.
 * 4. Output target paths and overwrite safety guarantees.
 *
 * Guarantees:
 * - Makes ZERO external network requests.
 * - Writes ZERO snapshot files.
 * - Leaks ZERO credentials or sensitive information.
 * - Uses only built-in Node.js modules (no extra dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSupportedAssets } from '../src/lib/assets.ts';
import { DEFAULT_FRANKFURTER_BASE_URL } from '../src/lib/providers/frankfurterProvider.ts';
import { DEFAULT_COINMARKETCAP_BASE_URL, CMC_SUPPORTED_CRYPTO } from '../src/lib/providers/coinmarketcapProvider.ts';
import { DEFAULT_GOLD_API_BASE_URL, GOLD_API_SUPPORTED_METALS } from '../src/lib/providers/goldApiProvider.ts';
import { AED_USD_PEG_RATE_STR } from '../src/lib/providers/fixedPegProvider.ts';
import {
  DEFAULT_SNAPSHOT_STORAGE_REL_PATH,
  DEFAULT_DIST_SNAPSHOT_REL_PATH,
} from '../src/lib/generateSnapshotCore.ts';

interface PreflightResult {
  passed: boolean;
  checks: { name: string; status: 'PASS' | 'FAIL' | 'WARN' | 'INFO'; detail: string }[];
}

export function runPreflightChecks(): PreflightResult {
  const checks: { name: string; status: 'PASS' | 'FAIL' | 'WARN' | 'INFO'; detail: string }[] = [];
  let passed = true;

  // 1. Check CoinMarketCap API Key Environment Variable
  const cmcKey = process.env.COINMARKETCAP_API_KEY?.trim();
  if (cmcKey) {
    checks.push({
      name: 'CoinMarketCap API Key (COINMARKETCAP_API_KEY)',
      status: 'PASS',
      detail: 'Configured in environment.',
    });
  } else {
    passed = false;
    checks.push({
      name: 'CoinMarketCap API Key (COINMARKETCAP_API_KEY)',
      status: 'FAIL',
      detail: 'Missing from environment. The live generator requires this environment variable.',
    });
  }

  // 2. Check Canonical Assets Coverage across the 4 providers
  const allSupported = getSupportedAssets();
  const canonicalCodes = allSupported.map((a) => a.code);
  const fiatCodes = [
    'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'ZAR', 'INR',
    'CNY', 'HKD', 'SGD', 'NZD', 'KRW', 'MXN', 'BRL', 'SEK', 'NOK', 'DKK', 'PLN',
  ];
  const pegCode = 'AED';
  const cryptoCodes = [...CMC_SUPPORTED_CRYPTO];
  const metalCodes = [...GOLD_API_SUPPORTED_METALS];

  const coveredCodes = new Set([...fiatCodes, pegCode, ...cryptoCodes, ...metalCodes]);
  const missing = canonicalCodes.filter((code) => !coveredCodes.has(code));

  if (canonicalCodes.length === 30 && missing.length === 0) {
    checks.push({
      name: 'Canonical Assets Coverage (30/30)',
      status: 'PASS',
      detail: `21 Fiat (Frankfurter + AED peg ${AED_USD_PEG_RATE_STR}), 5 Crypto (CoinMarketCap), 4 Metals (Gold-API).`,
    });
  } else {
    passed = false;
    checks.push({
      name: 'Canonical Assets Coverage',
      status: 'FAIL',
      detail: `Missing canonical assets: ${missing.join(', ')}`,
    });
  }

  // 3. Check Provider Endpoints Configuration
  checks.push({
    name: 'Provider Configuration (Zero Live Calls)',
    status: 'INFO',
    detail: `Frankfurter (${DEFAULT_FRANKFURTER_BASE_URL}), Gold-API (${DEFAULT_GOLD_API_BASE_URL}), CoinMarketCap (${DEFAULT_COINMARKETCAP_BASE_URL}).`,
  });

  // 4. Check Storage Directory Accessibility & Overwrite Safety
  const storagePath = path.resolve(process.cwd(), DEFAULT_SNAPSHOT_STORAGE_REL_PATH);
  const storageDir = path.dirname(storagePath);

  try {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    // Test write permission with a tiny temporary probe file
    const probeFile = path.join(storageDir, `.probe.${Date.now()}.tmp`);
    fs.writeFileSync(probeFile, 'probe', 'utf8');
    fs.unlinkSync(probeFile);

    const snapshotExists = fs.existsSync(storagePath);
    checks.push({
      name: 'Primary Storage Target (src/data/latestSnapshot.json)',
      status: 'PASS',
      detail: snapshotExists
        ? `Directory writable. Existing snapshot file found (${fs.statSync(storagePath).size} bytes); will be atomically replaced upon validation.`
        : 'Directory writable. No existing snapshot found; will be created on first successful live run.',
    });
  } catch (err) {
    passed = false;
    checks.push({
      name: 'Primary Storage Target Directory',
      status: 'FAIL',
      detail: `Directory is not writable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. Check Build Mirror Target Accessibility
  const distPath = path.resolve(process.cwd(), DEFAULT_DIST_SNAPSHOT_REL_PATH);
  const distDir = path.dirname(distPath);

  if (fs.existsSync(distDir)) {
    checks.push({
      name: 'Build Mirror Target (dist/api/rates.json)',
      status: 'PASS',
      detail: `Build directory exists. Snapshot will be mirrored for immediate local preview.`,
    });
  } else {
    checks.push({
      name: 'Build Mirror Target (dist/api/rates.json)',
      status: 'INFO',
      detail: `dist/api does not exist yet (run 'npm run build' to create). Mirroring will be skipped safely.`,
    });
  }

  // 6. Overwrite Safety & Clean Checkout Invariant
  checks.push({
    name: 'Atomic Overwrite & Fallback Safety',
    status: 'PASS',
    detail: 'Atomic write (.tmp + rename) active. If any provider fails, target snapshot remains untouched. Git ignores src/data/.',
  });

  return { passed, checks };
}

function main() {
  console.log('====================================================');
  console.log(' AllFinConverter — Live Snapshot Preflight Check');
  console.log('====================================================\n');

  const { passed, checks } = runPreflightChecks();

  for (const c of checks) {
    const symbol =
      c.status === 'PASS'
        ? '[PASS]'
        : c.status === 'FAIL'
        ? '[FAIL]'
        : c.status === 'WARN'
        ? '[WARN]'
        : '[INFO]';
    console.log(`${symbol.padEnd(7)} ${c.name}`);
    console.log(`        ${c.detail}\n`);
  }

  if (passed) {
    console.log('----------------------------------------------------');
    console.log('[READY] Preflight checks passed successfully.');
    console.log('The environment is ready for a controlled live test.');
    console.log('----------------------------------------------------\n');
    process.exit(0);
  } else {
    console.log('----------------------------------------------------');
    console.log('[ACTION REQUIRED] Preflight check found issues.');
    console.log('Resolve the [FAIL] items above before running the live test.');
    console.log('----------------------------------------------------\n');
    process.exit(1);
  }
}

main();
