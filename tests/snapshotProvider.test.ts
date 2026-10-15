/**
 * Automated Test Suite for AllFinConverter M3.0
 *
 * Rate Snapshot & Client Delivery Architecture Foundation (Offline / Mock-Only).
 *
 * Verifies:
 * 1. Snapshot serialization and round-trip precision (Big.js string encoding)
 * 2. All 19 canonical assets, USD = 1, per-asset provenance
 * 3. Snapshot schema validation (version, baseAsset, timestamps, rates, provenance)
 * 4. Stale snapshot rejection (24-hour threshold), future timestamp rejection
 * 5. Invalid / malformed / incomplete payloads
 * 6. SnapshotRateProvider with in-memory and URL-based sources
 * 7. HTTP errors, network failures, timeouts, malformed JSON
 * 8. RateEngine integration and fallback behaviour
 * 9. Static endpoint output validation
 * 10. Offline safety: zero external network calls, defaultRateEngine unchanged
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  validateRateSnapshot,
  serializeRateSnapshot,
  createDefaultMockSnapshot,
  RateSnapshotError,
  CURRENT_SNAPSHOT_VERSION,
  MAX_SNAPSHOT_AGE_MS,
  type RateSnapshotPayload,
} from '../src/lib/rateSnapshot.ts';

import {
  SnapshotRateProvider,
  SnapshotProviderError,
} from '../src/lib/providers/snapshotProvider.ts';

import {
  RateEngine,
  defaultRateEngine,
} from '../src/lib/rateEngine.ts';

import {
  MockRateProvider,
  MOCK_DATASET_TIMESTAMP,
  FICTIONAL_MOCK_RATES,
} from '../src/lib/providers/mockProvider.ts';

import { getSupportedAssets } from '../src/lib/assets.ts';
import { calculateConversion } from '../src/lib/converter.ts';

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

/** Creates a valid snapshot timestamped at "now" with mock data. */
function createFreshMockSnapshot(
  nowMs: number = Date.now()
): RateSnapshotPayload {
  return createDefaultMockSnapshot(nowMs);
}

/** Creates a snapshot JSON string from a fresh mock snapshot. */
function createFreshSnapshotJson(nowMs: number = Date.now()): string {
  return JSON.stringify(createFreshMockSnapshot(nowMs));
}

/** Mock fetch that serves a fresh snapshot JSON. */
function createMockSnapshotFetch(
  nowMs: number = Date.now(),
  overrides?: {
    fail?: boolean;
    status?: number;
    malformed?: boolean;
    timeout?: boolean;
    body?: string;
  }
): typeof globalThis.fetch {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    if (overrides?.timeout) {
      // Simulate timeout by aborting
      if (init?.signal) {
        return new Promise<Response>((_, reject) => {
          const checkAbort = setInterval(() => {
            if (init.signal?.aborted) {
              clearInterval(checkAbort);
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            }
          }, 5);
        });
      }
      await new Promise((r) => setTimeout(r, 60000));
      throw new Error('Timeout');
    }

    if (overrides?.fail) {
      throw new TypeError('fetch failed');
    }

    const status = overrides?.status ?? 200;
    const ok = status >= 200 && status < 300;

    let body: string;
    if (overrides?.malformed) {
      body = '{not valid json!!!';
    } else if (overrides?.body !== undefined) {
      body = overrides.body;
    } else {
      body = createFreshSnapshotJson(nowMs);
    }

    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => {
        if (overrides?.malformed) {
          throw new SyntaxError('Unexpected token');
        }
        return JSON.parse(body);
      },
    } as unknown as Response;
  };
}

// ===========================================================================
// Test Suites
// ===========================================================================

describe('M3.0 — Snapshot Serialization & Round-Trip Precision', () => {
  it('should serialize a NormalizedRateDataset preserving exact Big.js decimal strings', () => {
    const mockProvider = new MockRateProvider();
    const engine = new RateEngine(mockProvider);

    // Use getRate to verify the engine loaded, then serialize from mock provider's raw payload
    assert.ok(engine.hasRate('USD'));

    // Build a NormalizedRateDataset from the engine's known rates
    const rates = new Map<string, Big>();
    for (const asset of getSupportedAssets()) {
      rates.set(asset.code, engine.getRate(asset.code));
    }
    const dataset = {
      providerId: 'mock-local',
      providerName: 'Local Mock Provider',
      timestamp: MOCK_DATASET_TIMESTAMP,
      isMock: true,
      rates: rates as ReadonlyMap<string, Big>,
    };

    const snapshot = serializeRateSnapshot(dataset);

    assert.equal(snapshot.version, CURRENT_SNAPSHOT_VERSION);
    assert.equal(snapshot.baseAsset, 'USD');
    assert.equal(snapshot.rates['USD'], '1');
    assert.equal(snapshot.isMock, true);
    assert.equal(snapshot.providerId, 'mock-local');

    // Verify all 19 supported assets present
    const supported = getSupportedAssets();
    assert.equal(supported.length, 19);
    for (const asset of supported) {
      assert.ok(
        snapshot.rates[asset.code] !== undefined,
        `Rate for ${asset.code} must be present`
      );
    }
  });

  it('should round-trip serialize and deserialize with zero precision loss', () => {
    const mockProvider = new MockRateProvider();
    const engine = new RateEngine(mockProvider);

    const rates = new Map<string, Big>();
    for (const asset of getSupportedAssets()) {
      rates.set(asset.code, engine.getRate(asset.code));
    }
    const dataset = {
      providerId: 'mock-local',
      providerName: 'Local Mock Provider',
      timestamp: MOCK_DATASET_TIMESTAMP,
      isMock: true,
      rates: rates as ReadonlyMap<string, Big>,
    };

    const snapshot = serializeRateSnapshot(dataset);

    // Simulate JSON round-trip
    const jsonStr = JSON.stringify(snapshot);
    const restored = JSON.parse(jsonStr);
    const validated = validateRateSnapshot(restored, { maxAgeMs: 0 });

    // Compare each rate string precisely
    for (const asset of getSupportedAssets()) {
      const original = rates.get(asset.code)!;
      const roundTripped = new Big(validated.rates[asset.code]);
      assert.ok(
        original.eq(roundTripped),
        `Round-trip precision loss for ${asset.code}: original=${original.toString()} restored=${roundTripped.toString()}`
      );
    }
  });

  it('should include per-asset provenance in serialized snapshot', () => {
    const mockProvider = new MockRateProvider();
    const engine = new RateEngine(mockProvider);

    const rates = new Map<string, Big>();
    for (const asset of getSupportedAssets()) {
      rates.set(asset.code, engine.getRate(asset.code));
    }
    const dataset = {
      providerId: 'mock-local',
      providerName: 'Local Mock Provider',
      timestamp: MOCK_DATASET_TIMESTAMP,
      isMock: true,
      rates: rates as ReadonlyMap<string, Big>,
    };

    const snapshot = serializeRateSnapshot(dataset);

    for (const asset of getSupportedAssets()) {
      const prov = snapshot.provenance[asset.code];
      assert.ok(prov, `Provenance for ${asset.code} must exist`);
      assert.equal(prov.sourceId, 'mock-local');
      assert.equal(prov.sourceName, 'Local Mock Provider');
      assert.equal(typeof prov.timestamp, 'number');
      assert.ok(prov.timestamp > 0);
    }
  });
});

describe('M3.0 — Snapshot Validation (Schema & Freshness)', () => {
  it('should accept a valid fresh snapshot', () => {
    const now = Date.now();
    const snapshot = createFreshMockSnapshot(now);
    const result = validateRateSnapshot(snapshot, { now });

    assert.equal(result.version, 1);
    assert.equal(result.baseAsset, 'USD');
    assert.equal(result.rates['USD'], '1');
    assert.equal(result.timestamp, now);
  });

  it('should reject a snapshot with missing version', () => {
    const snapshot = createFreshMockSnapshot();
    const broken = { ...snapshot, version: undefined };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('version')
    );
  });

  it('should reject a snapshot with wrong version', () => {
    const snapshot = createFreshMockSnapshot();
    const broken = { ...snapshot, version: 99 };

    assert.throws(
      () => validateRateSnapshot(broken as unknown, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('version')
    );
  });

  it('should reject a snapshot with baseAsset !== USD', () => {
    const snapshot = createFreshMockSnapshot();
    const broken = { ...snapshot, baseAsset: 'EUR' };

    assert.throws(
      () => validateRateSnapshot(broken as unknown, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('USD')
    );
  });

  it('should reject a snapshot with negative timestamp', () => {
    const snapshot = createFreshMockSnapshot();
    const broken = { ...snapshot, timestamp: -100 };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('timestamp')
    );
  });

  it('should reject a stale snapshot (older than 24 hours)', () => {
    const now = Date.now();
    const old = now - MAX_SNAPSHOT_AGE_MS - 60_000; // 24h + 1 minute
    const snapshot = createFreshMockSnapshot(old);

    assert.throws(
      () => validateRateSnapshot(snapshot, { now }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('stale')
    );
  });

  it('should reject a snapshot from the future (>5 min clock skew)', () => {
    const now = Date.now();
    const future = now + 600_000; // 10 minutes in the future
    const snapshot = createFreshMockSnapshot(future);

    assert.throws(
      () => validateRateSnapshot(snapshot, { now }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('future')
    );
  });

  it('should accept a snapshot within 5-minute clock skew tolerance', () => {
    const now = Date.now();
    const slightlyFuture = now + 200_000; // 3.3 min
    const snapshot = createFreshMockSnapshot(slightlyFuture);

    const result = validateRateSnapshot(snapshot, { now });
    assert.equal(result.timestamp, slightlyFuture);
  });

  it('should reject a snapshot with USD rate !== 1', () => {
    const snapshot = createFreshMockSnapshot();
    const rates = { ...snapshot.rates, USD: '2' };
    const broken = { ...snapshot, rates };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('USD')
    );
  });

  it('should reject a snapshot missing a canonical asset', () => {
    const snapshot = createFreshMockSnapshot();
    const rates = { ...snapshot.rates };
    delete (rates as Record<string, string>)['BTC'];
    const broken = { ...snapshot, rates };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('BTC')
    );
  });

  it('should reject a snapshot with non-positive rate', () => {
    const snapshot = createFreshMockSnapshot();
    const rates = { ...snapshot.rates, ETH: '0' };
    const broken = { ...snapshot, rates };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('ETH')
    );
  });

  it('should reject a snapshot with non-numeric rate string', () => {
    const snapshot = createFreshMockSnapshot();
    const rates = { ...snapshot.rates, SOL: 'not-a-number' };
    const broken = { ...snapshot, rates };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('SOL')
    );
  });

  it('should reject a snapshot with missing provenance entry', () => {
    const snapshot = createFreshMockSnapshot();
    const provenance = { ...snapshot.provenance };
    delete (provenance as Record<string, unknown>)['XAU'];
    const broken = { ...snapshot, provenance };

    assert.throws(
      () => validateRateSnapshot(broken, { maxAgeMs: 0 }),
      (err: unknown) => err instanceof RateSnapshotError && err.message.includes('XAU')
    );
  });

  it('should reject null / undefined / array / primitive payloads', () => {
    for (const bad of [null, undefined, [], 42, 'string']) {
      assert.throws(
        () => validateRateSnapshot(bad, { maxAgeMs: 0 }),
        (err: unknown) => err instanceof RateSnapshotError
      );
    }
  });
});

describe('M3.0 — SnapshotRateProvider (In-Memory)', () => {
  it('should supply rates from an in-memory snapshot via getRates()', async () => {
    const now = Date.now();
    const snapshot = createFreshMockSnapshot(now);

    const provider = new SnapshotRateProvider({
      snapshot,
      maxAgeMs: MAX_SNAPSHOT_AGE_MS,
    });

    assert.equal(provider.id, 'snapshot');

    const payload = await provider.getRates();
    assert.equal(payload.providerId, 'mock-snapshot');
    assert.equal(payload.timestamp, now);
    assert.equal(payload.rates['USD'], '1');
    assert.ok(payload.rates['BTC']);
  });

  it('should expose provenance after getRates()', async () => {
    const snapshot = createFreshMockSnapshot();

    const provider = new SnapshotRateProvider({
      snapshot,
      maxAgeMs: 0, // bypass age for test
    });

    await provider.getRates();

    const prov = provider.getProvenance();
    assert.ok(prov.has('EUR'));
    assert.equal(prov.get('EUR')!.sourceId, 'mock-local');
  });

  it('should reject a stale in-memory snapshot', async () => {
    const old = Date.now() - MAX_SNAPSHOT_AGE_MS - 60_000;
    const snapshot = createFreshMockSnapshot(old);

    const provider = new SnapshotRateProvider({
      snapshot,
      maxAgeMs: MAX_SNAPSHOT_AGE_MS,
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('stale')
    );
  });

  it('should return success from getRatesSafe() with a valid snapshot', async () => {
    const snapshot = createFreshMockSnapshot();
    const provider = new SnapshotRateProvider({ snapshot, maxAgeMs: 0 });

    const result = await provider.getRatesSafe();
    assert.equal(result.success, true);
    if (result.success) {
      assert.ok(result.payload.rates['USD']);
      assert.ok(result.snapshot);
    }
  });

  it('should return failure from getRatesSafe() with invalid snapshot', async () => {
    const old = Date.now() - MAX_SNAPSHOT_AGE_MS - 60_000;
    const snapshot = createFreshMockSnapshot(old);
    const provider = new SnapshotRateProvider({ snapshot });

    const result = await provider.getRatesSafe();
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error instanceof SnapshotProviderError);
    }
  });

  it('should throw SnapshotProviderError when neither snapshot nor URL is configured', async () => {
    const provider = new SnapshotRateProvider({});
    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('requires')
    );
  });
});

describe('M3.0 — SnapshotRateProvider (URL Fetch)', () => {
  it('should fetch and validate a snapshot from URL via injected fetch', async () => {
    const now = Date.now();
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(now),
      maxAgeMs: MAX_SNAPSHOT_AGE_MS,
    });

    const payload = await provider.getRates();
    assert.equal(payload.rates['USD'], '1');
    assert.ok(payload.rates['BTC']);
    assert.equal(payload.timestamp, now);
  });

  it('should handle HTTP 404 error', async () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), { status: 404 }),
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('404')
    );
  });

  it('should handle HTTP 500 error', async () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), { status: 500 }),
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('500')
    );
  });

  it('should handle network failure', async () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), { fail: true }),
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('network')
    );
  });

  it('should handle malformed JSON response', async () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), { malformed: true }),
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('Malformed')
    );
  });

  it('should handle fetch timeout without unhandled rejection', async () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), { timeout: true }),
      timeoutMs: 50,
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('timed out')
    );
  });

  it('should reject a stale snapshot fetched from URL', async () => {
    const old = Date.now() - MAX_SNAPSHOT_AGE_MS - 60_000;
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(old),
      maxAgeMs: MAX_SNAPSHOT_AGE_MS,
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('stale')
    );
  });

  it('should reject a snapshot with invalid schema from URL', async () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), {
        body: JSON.stringify({ version: 1, providerId: 'test', providerName: 'Test' }),
      }),
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => err instanceof SnapshotProviderError && err.message.includes('validation')
    );
  });
});

describe('M3.0 — RateEngine Integration & Fallback', () => {
  it('should load snapshot rates into RateEngine via registerProvider + loadFromProviderAsync', async () => {
    const now = Date.now();
    const snapshot = createFreshMockSnapshot(now);
    const provider = new SnapshotRateProvider({ snapshot, maxAgeMs: 0 });

    const engine = new RateEngine(new MockRateProvider());
    assert.equal(engine.getActiveProviderId(), 'mock-local');

    engine.registerProvider(provider);
    await engine.loadFromProviderAsync(provider);

    // Engine now has snapshot rates
    assert.equal(engine.hasRate('BTC'), true);
    assert.equal(engine.hasRate('EUR'), true);
    assert.equal(engine.hasRate('XAU'), true);

    // Rates match mock fixture values
    assert.ok(engine.getRate('EUR').eq(new Big(FICTIONAL_MOCK_RATES['EUR'])));
    assert.ok(engine.getRate('BTC').eq(new Big(FICTIONAL_MOCK_RATES['BTC'])));
  });

  it('should support cross-asset conversion using snapshot-loaded RateEngine', async () => {
    const now = Date.now();
    const snapshot = createFreshMockSnapshot(now);
    const provider = new SnapshotRateProvider({ snapshot, maxAgeMs: 0 });

    const engine = new RateEngine(new MockRateProvider());
    engine.registerProvider(provider);
    await engine.loadFromProviderAsync(provider);

    // Use the M2.5 rateEngine option for conversion
    const result = calculateConversion('100', 'USD', 'EUR', { rateEngine: engine });
    assert.ok(result.targetAmount.eq(92), '100 USD should equal 92 EUR with mock rates');
  });

  it('should retain mock-local LKG when snapshot provider fails', async () => {
    const engine = new RateEngine(new MockRateProvider());
    const initialRate = engine.getRate('EUR');

    // Create a provider that will fail
    const badProvider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: createMockSnapshotFetch(Date.now(), { fail: true }),
    });

    engine.registerProvider(badProvider);

    const result = await engine.loadFromProviderAsync(badProvider);
    assert.equal(result.valid, false);

    // Engine retains original mock rates
    assert.ok(engine.getRate('EUR').eq(initialRate));
  });
});

describe('M3.0 — createDefaultMockSnapshot & Endpoint', () => {
  it('should generate a valid mock snapshot covering all 19 canonical assets', () => {
    const now = Date.now();
    const snapshot = createDefaultMockSnapshot(now);

    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.baseAsset, 'USD');
    assert.equal(snapshot.providerId, 'mock-snapshot');
    assert.equal(snapshot.isMock, true);
    assert.equal(snapshot.timestamp, now);
    assert.equal(snapshot.rates['USD'], '1');

    const supported = getSupportedAssets();
    for (const asset of supported) {
      assert.ok(snapshot.rates[asset.code], `Missing rate for ${asset.code}`);
      assert.ok(snapshot.provenance[asset.code], `Missing provenance for ${asset.code}`);
      assert.equal(snapshot.provenance[asset.code].sourceId, 'mock-local');
    }
  });

  it('should produce rates matching FICTIONAL_MOCK_RATES exactly', () => {
    const snapshot = createDefaultMockSnapshot();

    for (const [code, rate] of Object.entries(FICTIONAL_MOCK_RATES)) {
      assert.equal(
        snapshot.rates[code],
        rate,
        `Rate for ${code} should match FICTIONAL_MOCK_RATES`
      );
    }
  });

  it('should produce JSON that validates via validateRateSnapshot()', () => {
    const now = Date.now();
    const snapshot = createDefaultMockSnapshot(now);

    // Simulate JSON round-trip
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    const validated = validateRateSnapshot(parsed, { now });

    assert.equal(validated.version, 1);
    assert.equal(validated.baseAsset, 'USD');
    assert.equal(Object.keys(validated.rates).length, 19);
  });
});

describe('M3.0 — Offline Safety Invariants', () => {
  it('should keep defaultRateEngine strictly on mock-local provider', () => {
    assert.equal(defaultRateEngine.getActiveProviderId(), 'mock-local');
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(defaultRateEngine.getStatus().timestamp, MOCK_DATASET_TIMESTAMP);
  });

  it('should preserve defaultRateEngine behavior when calculateConversion omits rateEngine', () => {
    const result = calculateConversion('100', 'USD', 'EUR');
    assert.ok(result.targetAmount.eq(92));
  });

  it('should instantiate SnapshotRateProvider with zero network calls', () => {
    let networkCallMade = false;
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () => {
        networkCallMade = true;
        throw new Error('No network calls permitted during instantiation');
      },
    });

    assert.equal(networkCallMade, false, 'Instantiation must perform zero network calls');
    assert.ok(provider);
  });
});
