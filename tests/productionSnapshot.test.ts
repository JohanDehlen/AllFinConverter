/**
 * Automated Test Suite for Production Rate Snapshot Generation & Pipeline
 *
 * Verifies:
 * 1. Successful snapshot generation using mocked provider responses (Frankfurter, Fixed Peg AED, CMC, Gold-API)
 * 2. All 30 canonical assets present in output snapshot
 * 3. Exact AED fixed peg integration (1 USD = 3.6725 AED) with correct provenance
 * 4. Correct provenance / source identification across all 4 asset source categories
 * 5. Missing CoinMarketCap API key throws and prevents snapshot generation
 * 6. Provider failure (e.g. Gold-API down or Frankfurter network fail) aborts snapshot generation
 * 7. Incomplete data (missing canonical coin) is rejected
 * 8. Existing snapshot file remains untouched after a failed generation
 * 9. Mock/demo data is never published as live (isMock: false enforced)
 * 10. Schema validation via validateRateSnapshot
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  generateProductionSnapshot,
  writeProductionSnapshot,
  runProductionSnapshotPipeline,
  SnapshotGenerationError,
} from '../src/lib/generateSnapshotCore.ts';

import { validateRateSnapshot, isLiveSnapshotAcceptable } from '../src/lib/rateSnapshot.ts';
import { getSupportedAssets } from '../src/lib/assets.ts';

// ---------------------------------------------------------------------------
// Mock Provider Response Fixtures
// ---------------------------------------------------------------------------

const MOCK_RATE_TIME = Date.now();
const MOCK_RATE_DATE = new Date(MOCK_RATE_TIME).toISOString().slice(0, 10);
const MOCK_RATE_ISO = new Date(MOCK_RATE_TIME - 60_000).toISOString();

const MOCK_FRANKFURTER_FIAT = {
  amount: 1,
  base: 'USD',
  date: MOCK_RATE_DATE,
  rates: {
    EUR: 0.92,
    GBP: 0.79,
    JPY: 155.0,
    CHF: 0.9,
    CAD: 1.36,
    AUD: 1.52,
    ZAR: 18.25,
    INR: 83.5,
    CNY: 7.25,
    HKD: 7.8,
    SGD: 1.35,
    NZD: 1.65,
    KRW: 1350.0,
    MXN: 18.0,
    BRL: 5.2,
    SEK: 10.5,
    NOK: 10.8,
    DKK: 6.9,
    PLN: 4.0,
    // Note: AED intentionally absent from Frankfurter, supplied by FixedPegRateProvider
  },
};

const MOCK_CMC_CRYPTO = {
  status: { error_code: 0 },
  data: {
    BTC: { symbol: 'BTC', quote: { USD: { price: 65000, last_updated: MOCK_RATE_ISO } } },
    ETH: { symbol: 'ETH', quote: { USD: { price: 3500, last_updated: MOCK_RATE_ISO } } },
    SOL: { symbol: 'SOL', quote: { USD: { price: 150, last_updated: MOCK_RATE_ISO } } },
    XRP: { symbol: 'XRP', quote: { USD: { price: 0.55, last_updated: MOCK_RATE_ISO } } },
    DOGE: { symbol: 'DOGE', quote: { USD: { price: 0.12, last_updated: MOCK_RATE_ISO } } },
  },
};

const MOCK_GOLD_METALS: Record<string, unknown> = {
  XAU: { symbol: 'XAU', name: 'Gold', price: 2400.0, currency: 'USD', updatedAt: MOCK_RATE_ISO },
  XAG: { symbol: 'XAG', name: 'Silver', price: 30.0, currency: 'USD', updatedAt: MOCK_RATE_ISO },
  XPT: { symbol: 'XPT', name: 'Platinum', price: 1000.0, currency: 'USD', updatedAt: MOCK_RATE_ISO },
  XPD: { symbol: 'XPD', name: 'Palladium', price: 950.0, currency: 'USD', updatedAt: MOCK_RATE_ISO },
};

function createMockFetch(overrides?: {
  failFrankfurter?: boolean;
  failCmc?: boolean;
  failGold?: boolean;
  omitCmcCoin?: string;
  staleCmc?: boolean;
}): typeof globalThis.fetch {
  return async (url: string | URL | Request) => {
    const urlStr = String(url);

    if (urlStr.includes('api.frankfurter.dev')) {
      if (overrides?.failFrankfurter) {
        throw new Error('Frankfurter network error simulated');
      }
      return new Response(JSON.stringify(MOCK_FRANKFURTER_FIAT), { status: 200 });
    }

    if (urlStr.includes('coinmarketcap.com')) {
      if (overrides?.failCmc) {
        return new Response(
          JSON.stringify({ status: { error_code: 1001, error_message: 'Invalid key' } }),
          { status: 401 }
        );
      }
      if (overrides?.omitCmcCoin) {
        const copyData = { ...MOCK_CMC_CRYPTO.data };
        delete (copyData as Record<string, unknown>)[overrides.omitCmcCoin];
        return new Response(JSON.stringify({ status: { error_code: 0 }, data: copyData }), { status: 200 });
      }
      if (overrides?.staleCmc) {
        const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const staleData = JSON.parse(JSON.stringify(MOCK_CMC_CRYPTO)) as typeof MOCK_CMC_CRYPTO;
        for (const coin of Object.values(staleData.data)) {
          coin.quote.USD.last_updated = staleTime;
        }
        return new Response(JSON.stringify(staleData), { status: 200 });
      }
      return new Response(JSON.stringify(MOCK_CMC_CRYPTO), { status: 200 });
    }

    if (urlStr.includes('api.gold-api.com')) {
      if (overrides?.failGold) {
        throw new Error('Gold-API service outage');
      }
      for (const [sym, data] of Object.entries(MOCK_GOLD_METALS)) {
        if (urlStr.includes(`/price/${sym}`)) {
          return new Response(JSON.stringify(data), { status: 200 });
        }
      }
      return new Response('Not found', { status: 404 });
    }

    return new Response('Unhandled URL in mock fetch', { status: 500 });
  };
}

describe('Production Rate Snapshot Generator Pipeline', () => {
  it('should generate a valid production snapshot covering all 30 canonical assets with correct provenance', async () => {
    const mockFetch = createMockFetch();

    const snapshot = await generateProductionSnapshot({
      orchestratorOptions: {
        fetch: mockFetch,
        coinMarketCapOptions: {
          apiKey: 'test-api-key',
        },
      },
    });

    // 1. Structural schema validity
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.baseAsset, 'USD');
    assert.equal(snapshot.isMock, false);
    assert.equal(typeof snapshot.timestamp, 'number');

    // 2. All canonical assets present
    const supported = getSupportedAssets();
    assert.equal(supported.length, 30);
    for (const asset of supported) {
      assert.ok(snapshot.rates[asset.code], `Missing canonical rate for ${asset.code}`);
      assert.ok(snapshot.provenance[asset.code], `Missing provenance for ${asset.code}`);
    }

    // 3. Exact AED peg validation
    assert.equal(snapshot.rates['AED'], '3.6725');
    assert.equal(snapshot.provenance['AED'].sourceId, 'fixed-peg');
    assert.ok(snapshot.provenance['AED'].sourceName.includes('Fixed Peg'));

    // 4. Fiat provenance check (Frankfurter / ECB)
    assert.equal(snapshot.provenance['EUR'].sourceId, 'frankfurter');
    assert.equal(snapshot.provenance['EUR'].sourceName, 'Frankfurter FX');

    // 5. Crypto provenance check (CoinMarketCap)
    assert.equal(snapshot.provenance['BTC'].sourceId, 'coinmarketcap');
    assert.equal(snapshot.provenance['BTC'].sourceName, 'CoinMarketCap');

    // 6. Precious metals provenance check (Gold-API)
    assert.equal(snapshot.provenance['XAU'].sourceId, 'goldapi');
    assert.equal(snapshot.provenance['XAU'].sourceName, 'Gold API');

    // 7. Passes strict schema validation
    const validated = validateRateSnapshot(snapshot, { maxAgeMs: 0 });
    assert.equal(validated.isMock, false);
    assert.equal(validated.rates['USD'], '1');
  });

  it('should fail clearly when CoinMarketCap API key is missing', async () => {
    const mockFetch = createMockFetch();

    await assert.rejects(
      () =>
        generateProductionSnapshot({
          orchestratorOptions: {
            fetch: mockFetch,
            coinMarketCapOptions: {
              apiKey: '', // explicitly empty
            },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotGenerationError);
        assert.match((err as Error).message, /CoinMarketCap API key is missing/);
        return true;
      }
    );
  });

  it('should abort snapshot generation if Frankfurter fails', async () => {
    const mockFetch = createMockFetch({ failFrankfurter: true });

    await assert.rejects(
      () =>
        generateProductionSnapshot({
          orchestratorOptions: {
            fetch: mockFetch,
            coinMarketCapOptions: { apiKey: 'test-key' },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotGenerationError);
        assert.match((err as Error).message, /frankfurter/i);
        return true;
      }
    );
  });

  it('should abort snapshot generation if Gold-API fails', async () => {
    const mockFetch = createMockFetch({ failGold: true });

    await assert.rejects(
      () =>
        generateProductionSnapshot({
          orchestratorOptions: {
            fetch: mockFetch,
            coinMarketCapOptions: { apiKey: 'test-key' },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotGenerationError);
        assert.match((err as Error).message, /gold-api/i);
        return true;
      }
    );
  });

  it('should abort snapshot generation if CoinMarketCap response is incomplete', async () => {
    const mockFetch = createMockFetch({ omitCmcCoin: 'SOL' });

    await assert.rejects(
      () =>
        generateProductionSnapshot({
          orchestratorOptions: {
            fetch: mockFetch,
            coinMarketCapOptions: { apiKey: 'test-key' },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotGenerationError);
        assert.match((err as Error).message, /coinmarketcap/i);
        return true;
      }
    );
  });

  it('should reject mock data from being written as a production live snapshot', () => {
    const mockSnapshot = {
      version: 1 as const,
      providerId: 'mock-snapshot',
      providerName: 'Build-Time Mock Snapshot',
      baseAsset: 'USD' as const,
      timestamp: Date.now(),
      isMock: true, // mock!
      rates: { USD: '1' } as Record<string, string>,
      provenance: {} as Record<string, any>,
    };

    assert.throws(
      () => writeProductionSnapshot(mockSnapshot as any),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotGenerationError);
        assert.match((err as Error).message, /Mock data cannot be written/);
        return true;
      }
    );
  });

  it('should leave existing snapshot file untouched when generation fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allfin-snapshot-test-'));
    const targetFile = path.join(tempDir, 'latestSnapshot.json');

    // Create existing valid snapshot file
    const initialContent = JSON.stringify({
      version: 1,
      providerId: 'existing-snapshot',
      content: 'PRESERVE_ME_EXACTLY',
    });

    fs.writeFileSync(targetFile, initialContent, 'utf8');

    const mockFetch = createMockFetch({ failGold: true });

    // Run pipeline with failing provider
    await assert.rejects(
      () =>
        runProductionSnapshotPipeline({
          orchestratorOptions: {
            fetch: mockFetch,
            coinMarketCapOptions: { apiKey: 'test-key' },
          },
          targetPath: targetFile,
          updateDistIfPresent: false,
        }),
      SnapshotGenerationError
    );

    // Verify existing file is completely unchanged
    const afterContent = fs.readFileSync(targetFile, 'utf8');
    assert.equal(afterContent, initialContent);

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should preserve the existing snapshot when a provider returns stale rates', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allfin-stale-snapshot-test-'));
    const targetFile = path.join(tempDir, 'latestSnapshot.json');
    const initialContent = JSON.stringify({ preserved: true });
    fs.writeFileSync(targetFile, initialContent, 'utf8');

    await assert.rejects(
      () =>
        runProductionSnapshotPipeline({
          orchestratorOptions: {
            fetch: createMockFetch({ staleCmc: true }),
            coinMarketCapOptions: { apiKey: 'test-key' },
          },
          targetPath: targetFile,
          updateDistIfPresent: false,
        }),
      SnapshotGenerationError
    );

    assert.equal(fs.readFileSync(targetFile, 'utf8'), initialContent);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should atomically write valid snapshot to target path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allfin-snapshot-write-'));
    const targetFile = path.join(tempDir, 'latestSnapshot.json');

    const mockFetch = createMockFetch();

    const { snapshot, writeResult } = await runProductionSnapshotPipeline({
      orchestratorOptions: {
        fetch: mockFetch,
        coinMarketCapOptions: { apiKey: 'test-key' },
      },
      targetPath: targetFile,
      updateDistIfPresent: false,
    });

    assert.equal(writeResult.primaryPath, targetFile);
    assert.ok(fs.existsSync(targetFile));

    const content = fs.readFileSync(targetFile, 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.isMock, false);
    assert.equal(parsed.rates['BTC'], snapshot.rates['BTC']);
    assert.equal(parsed.rates['AED'], '3.6725');

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Fix 1 — Client Snapshot Mode Activation Invariants', () => {
    it('should accept a valid, fresh, live snapshot (isMock: false)', async () => {
      const mockFetch = createMockFetch();
      const liveSnapshot = await generateProductionSnapshot({
        orchestratorOptions: {
          fetch: mockFetch,
          coinMarketCapOptions: { apiKey: 'test-key' },
        },
      });

      assert.equal(liveSnapshot.isMock, false);
      const acceptable = isLiveSnapshotAcceptable(liveSnapshot);
      assert.equal(acceptable, true, 'Valid live snapshot should be accepted for snapshot mode');
    });

    it('should strictly reject mock data (isMock: true) from enabling snapshot mode', () => {
      // Build-time default mock snapshot
      const mockSnapshot = {
        version: 1,
        providerId: 'mock-snapshot',
        providerName: 'Build-Time Mock Snapshot',
        baseAsset: 'USD',
        timestamp: Date.now(), // fresh!
        isMock: true, // mock!
        rates: {
          USD: '1', EUR: '0.92', GBP: '0.79', JPY: '155.0', CHF: '0.90',
          CAD: '1.36', AUD: '1.52', ZAR: '18.25', INR: '83.50', AED: '3.67',
          BTC: '0.000015', ETH: '0.00038', SOL: '0.0068', XRP: '1.85', DOGE: '8.33',
          XAU: '0.000416', XAG: '0.0357', XPT: '0.00104', XPD: '0.00102',
        },
        provenance: {} as Record<string, any>,
      };
      for (const k of Object.keys(mockSnapshot.rates)) {
        mockSnapshot.provenance[k] = { sourceId: 'mock', sourceName: 'Mock', timestamp: Date.now() };
      }

      const acceptable = isLiveSnapshotAcceptable(mockSnapshot);
      assert.equal(acceptable, false, 'Mock snapshot must NEVER be accepted as live snapshot mode');
    });

    it('should reject stale snapshots older than 24 hours', async () => {
      const mockFetch = createMockFetch();
      const liveSnapshot = await generateProductionSnapshot({
        orchestratorOptions: {
          fetch: mockFetch,
          coinMarketCapOptions: { apiKey: 'test-key' },
        },
      });

      const now = Date.now();
      // Age is 25 hours (exceeds 24 hours)
      const staleSnapshot = {
        ...liveSnapshot,
        timestamp: now - 25 * 60 * 60 * 1000,
      };

      const acceptable = isLiveSnapshotAcceptable(staleSnapshot, { now });
      assert.equal(acceptable, false, 'Stale snapshot (>24h) must be rejected');
    });

    it('should reject snapshots from the future (>5 minutes clock skew)', async () => {
      const mockFetch = createMockFetch();
      const liveSnapshot = await generateProductionSnapshot({
        orchestratorOptions: {
          fetch: mockFetch,
          coinMarketCapOptions: { apiKey: 'test-key' },
        },
      });

      const now = Date.now();
      // Future timestamp (10 minutes in the future)
      const futureSnapshot = {
        ...liveSnapshot,
        timestamp: now + 10 * 60 * 1000,
      };

      const acceptable = isLiveSnapshotAcceptable(futureSnapshot, { now });
      assert.equal(acceptable, false, 'Snapshot from the future (>5m) must be rejected');
    });

    it('should accept snapshot within 5-minute clock skew tolerance', async () => {
      const mockFetch = createMockFetch();
      const liveSnapshot = await generateProductionSnapshot({
        orchestratorOptions: {
          fetch: mockFetch,
          coinMarketCapOptions: { apiKey: 'test-key' },
        },
      });

      const now = Date.now();
      // 2 minutes in future (tolerated clock skew)
      const nearFutureSnapshot = {
        ...liveSnapshot,
        timestamp: now + 2 * 60 * 1000,
      };

      const acceptable = isLiveSnapshotAcceptable(nearFutureSnapshot, { now });
      assert.equal(acceptable, true, 'Snapshot within 5m clock skew should be accepted');
    });

    it('should reject null, undefined, or malformed payloads safely', () => {
      assert.equal(isLiveSnapshotAcceptable(null), false);
      assert.equal(isLiveSnapshotAcceptable(undefined), false);
      assert.equal(isLiveSnapshotAcceptable({}), false);
      assert.equal(isLiveSnapshotAcceptable({ version: 1 }), false);
    });
  });
});
