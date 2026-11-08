/**
 * Automated Test Suite for Production Snapshot Client Hydration & Activation
 *
 * Verifies:
 * 1. Root cause bug: constructing RateEngine with an asynchronous SnapshotRateProvider does not throw.
 * 2. Successful production snapshot activation with isMock: false across all 30 canonical assets.
 * 3. RateEngine synchronization and cross-asset conversion calculations using live snapshot rates.
 * 4. Fallback to demo rates when snapshot is mock, stale (>24h), future (>5m skew), or fails to fetch.
 * 5. Preservation of 24h freshness limit and 5m clock-skew tolerance.
 * 6. Live rate vs Demo rate badges and conversion explanations.
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  validateRateSnapshot,
  isLiveSnapshotAcceptable,
  MAX_SNAPSHOT_AGE_MS,
  type RateSnapshotPayload,
} from '../src/lib/rateSnapshot.ts';
import { SnapshotRateProvider } from '../src/lib/providers/snapshotProvider.ts';
import { RateEngine, defaultRateEngine } from '../src/lib/rateEngine.ts';
import { getSupportedAssets } from '../src/lib/assets.ts';
import { calculateConversion } from '../src/lib/converter.ts';
import { FICTIONAL_MOCK_RATES } from '../src/lib/providers/mockProvider.ts';

/**
 * Creates a valid 30-asset production snapshot payload for testing.
 */
function createProductionSnapshot(
  nowMs: number = Date.now(),
  overrides?: Partial<RateSnapshotPayload>
): RateSnapshotPayload {
  const assets = getSupportedAssets();
  const rates: Record<string, string> = {};
  const provenance: Record<string, any> = {};

  for (const asset of assets) {
    if (asset.code === 'USD') {
      rates['USD'] = '1';
      provenance['USD'] = {
        sourceId: 'fixed-peg',
        sourceName: 'Fixed Peg Reference (USD)',
        timestamp: nowMs,
      };
    } else if (asset.code === 'AED') {
      rates['AED'] = '3.6725';
      provenance['AED'] = {
        sourceId: 'fixed-peg',
        sourceName: 'Fixed Peg Reference (USD)',
        timestamp: nowMs,
      };
    } else if (asset.category === 'fiat') {
      // Realistic live rates
      rates[asset.code] = asset.code === 'EUR' ? '0.89' : '1.50';
      provenance[asset.code] = {
        sourceId: 'frankfurter',
        sourceName: 'Frankfurter FX',
        timestamp: nowMs,
      };
    } else if (asset.category === 'crypto') {
      rates[asset.code] = '0.000015';
      provenance[asset.code] = {
        sourceId: 'coinmarketcap',
        sourceName: 'CoinMarketCap',
        timestamp: nowMs,
      };
    } else {
      rates[asset.code] = '0.0004';
      provenance[asset.code] = {
        sourceId: 'goldapi',
        sourceName: 'Gold API',
        timestamp: nowMs,
      };
    }
  }

  return {
    version: 1,
    providerId: 'allfin-live',
    providerName: 'AllFinConverter Live Composite',
    baseAsset: 'USD',
    timestamp: nowMs,
    isMock: false,
    rates: Object.freeze(rates),
    provenance: Object.freeze(provenance),
    ...overrides,
  };
}

describe('CRITICAL: Production Snapshot Hydration & Activation', () => {
  it('should instantiate RateEngine with an async SnapshotRateProvider without throwing', () => {
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () => new Response(JSON.stringify(createProductionSnapshot())),
    });

    // In the old implementation, `new RateEngine(provider)` threw:
    // "RateEngineError: Asynchronous provider loading must use loadFromProviderAsync."
    // With the fix, constructor handles async provider gracefully, initializing with safe mock LKG.
    const engine = new RateEngine(provider);
    assert.ok(engine instanceof RateEngine);
    assert.equal(engine.isMock(), true, 'Initially mock before async loading');
  });

  it('should NOT call getRates() during RateEngine construction with an async provider (no double-fetch)', () => {
    let callCount = 0;
    const asyncProvider = {
      id: 'test-async',
      name: 'Test Async Provider',
      isMock: false,
      async getRates() {
        callCount++;
        return {
          providerId: 'test-async',
          providerName: 'Test Async Provider',
          timestamp: Date.now(),
          isMock: false,
          rates: { USD: '1' },
        };
      },
    };

    const engine = new RateEngine(asyncProvider);
    assert.equal(callCount, 0, 'Constructor must not invoke getRates() on async provider');
    assert.equal(engine.isMock(), true, 'Engine has valid mock fallback dataset');
    assert.ok(engine.getRate('USD').eq(1));
    assert.ok(engine.getRate('EUR').gt(0));
  });

  it('should maintain robust mock fallback even if an async provider has id mock-local', async () => {
    let callCount = 0;
    const asyncMockLocalProvider = {
      id: 'mock-local',
      name: 'Async Custom Mock Local',
      isMock: false,
      async getRates() {
        callCount++;
        return {
          providerId: 'mock-local',
          providerName: 'Async Custom Mock Local',
          timestamp: Date.now(),
          isMock: false,
          rates: { USD: '1', EUR: '0.85' },
        };
      },
    };

    const engine = new RateEngine(asyncMockLocalProvider);
    assert.equal(callCount, 0, 'getRates not called in constructor');
    assert.equal(engine.isMock(), true, 'Engine initializes on mock fallback dataset');
    assert.ok(engine.getRate('USD').eq(1));
    assert.ok(engine.getRate('EUR').gt(0), 'Fallback dataset EUR rate is available');

    // Async provider can still be activated asynchronously under its id
    const result = await engine.setActiveProviderAsync('mock-local');
    assert.equal(result.valid, true);
    assert.equal(callCount, 1, 'getRates called upon explicit async activation');
    assert.equal(engine.isMock(), false, 'Engine reflects updated provider rates');
    assert.ok(engine.getRate('EUR').eq(new Big('0.85')));
  });

  it('should activate a valid production snapshot with isMock: false in RateEngine', async () => {
    const now = Date.now();
    const liveSnapshot = createProductionSnapshot(now);

    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () =>
        new Response(JSON.stringify(liveSnapshot), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const engine = new RateEngine();
    engine.registerProvider(provider);
    const activation = await engine.setActiveProviderAsync(provider.id);

    assert.equal(activation.valid, true, 'Activation must be valid');
    assert.equal(engine.isMock(), false, 'Engine must now reflect live rates');
    assert.equal(engine.getActiveProviderId(), 'snapshot');

    // Snapshot is acceptable for live mode
    const snapshot = provider.getLatestSnapshot();
    assert.ok(snapshot);
    assert.equal(isLiveSnapshotAcceptable(snapshot), true);
    assert.equal(snapshot.isMock, false);

    // Verify rate conversion uses the live snapshot rates
    const conversion = calculateConversion('100', 'USD', 'EUR', { rateEngine: engine });
    assert.ok(conversion.targetAmount.eq(89), '100 USD should equal 89 EUR with live snapshot rate 0.89');
  });

  it('should support conversions for all 11 new fiat currencies using activated RateEngine', async () => {
    const now = Date.now();
    const liveSnapshot = createProductionSnapshot(now, {
      rates: {
        ...createProductionSnapshot(now).rates,
        CNY: '7.25',
        HKD: '7.85',
        SGD: '1.34',
        NZD: '1.68',
        KRW: '1380.0',
        MXN: '18.25',
        BRL: '5.45',
        SEK: '10.20',
        NOK: '10.50',
        DKK: '6.85',
        PLN: '3.95',
      },
    });

    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () => new Response(JSON.stringify(liveSnapshot)),
    });

    const engine = new RateEngine();
    engine.registerProvider(provider);
    await engine.setActiveProviderAsync(provider.id);

    // Verify conversions work accurately for new currencies
    const cnyResult = calculateConversion('100', 'USD', 'CNY', { rateEngine: engine });
    assert.ok(cnyResult.targetAmount.eq(725));

    const krwResult = calculateConversion('10', 'USD', 'KRW', { rateEngine: engine });
    assert.ok(krwResult.targetAmount.eq(13800));

    const sekResult = calculateConversion('100', 'SEK', 'USD', { rateEngine: engine });
    assert.ok(sekResult.unitRate.gt(0));
  });

  it('should reject mock snapshots from live mode activation', async () => {
    const mockSnapshot = createProductionSnapshot(Date.now(), { isMock: true });

    assert.equal(
      isLiveSnapshotAcceptable(mockSnapshot),
      false,
      'isLiveSnapshotAcceptable must strictly reject snapshots with isMock: true'
    );
  });

  it('should reject stale snapshots older than 24 hours from live mode activation', async () => {
    const oldTimestamp = Date.now() - MAX_SNAPSHOT_AGE_MS - 60_000;
    const staleSnapshot = createProductionSnapshot(oldTimestamp);

    assert.equal(
      isLiveSnapshotAcceptable(staleSnapshot),
      false,
      'isLiveSnapshotAcceptable must reject snapshots older than 24h'
    );
  });

  it('should reject future snapshots beyond 5 minutes clock skew from live mode activation', async () => {
    const futureTimestamp = Date.now() + 6 * 60 * 1000; // 6 minutes ahead
    const futureSnapshot = createProductionSnapshot(futureTimestamp);

    assert.equal(
      isLiveSnapshotAcceptable(futureSnapshot),
      false,
      'isLiveSnapshotAcceptable must reject snapshots >5m in future'
    );
  });

  it('should accept snapshots within 5 minutes future tolerance', async () => {
    const skewTimestamp = Date.now() + 2 * 60 * 1000; // 2 minutes ahead
    const skewSnapshot = createProductionSnapshot(skewTimestamp);

    assert.equal(
      isLiveSnapshotAcceptable(skewSnapshot),
      true,
      'isLiveSnapshotAcceptable must accept snapshots within 5m future skew tolerance'
    );
  });

  it('should safely fall back to demo mock rates when fetch fails', async () => {
    const failingProvider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const engine = new RateEngine();
    engine.registerProvider(failingProvider);
    const result = await engine.setActiveProviderAsync(failingProvider.id);

    assert.equal(result.valid, false, 'Fetch failure returns invalid result');
    assert.equal(engine.isMock(), true, 'Engine stays on mock data');
    assert.equal(engine.getRate('USD').toFixed(), '1');
    assert.equal(engine.getRate('EUR').toFixed(), FICTIONAL_MOCK_RATES['EUR']);

    // The converter remains neutral until the failed request selects demo mode.
    let clientEngine: RateEngine | undefined = undefined;
    let badge = 'Checking rates…';
    if (result.valid) {
      clientEngine = engine;
      badge = 'Live rates';
    } else {
      badge = 'Demo rates';
    }

    assert.equal(clientEngine, undefined);
    assert.equal(badge, 'Demo rates');
  });

  it('should simulate exact Converter.astro hydration flow and activate live mode', async () => {
    const now = Date.now();
    const liveSnapshot = createProductionSnapshot(now);

    // Simulate loadClientSnapshot function from Converter.astro
    let clientEngine: RateEngine | undefined = undefined;
    let activeSnapshotTimestamp: number | null = null;
    let badgeText = 'Checking rates…';
    let subtextSuffix = '';

    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () => new Response(JSON.stringify(liveSnapshot)),
      maxAgeMs: 24 * 60 * 60 * 1000,
      timeoutMs: 5000,
    });

    const engine = new RateEngine();
    engine.registerProvider(provider);
    const activation = await engine.setActiveProviderAsync(provider.id);

    const snapshot = provider.getLatestSnapshot();
    if (
      activation.valid &&
      snapshot &&
      typeof snapshot.timestamp === 'number' &&
      isLiveSnapshotAcceptable(snapshot)
    ) {
      clientEngine = engine;
      activeSnapshotTimestamp = snapshot.timestamp;
      badgeText = 'Live rates';
      subtextSuffix = ` • Live rates as of ${new Date(snapshot.timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
    }

    assert.ok(clientEngine !== undefined, 'clientEngine must be activated');
    assert.equal(activeSnapshotTimestamp, now);
    assert.equal(badgeText, 'Live rates');
    assert.ok(!subtextSuffix.includes('fictional development rates'));
    assert.ok(subtextSuffix.includes('Live rates as of'));
  });

  it('should switch from checking to demo when a fetched snapshot fails live validation', async () => {
    const invalidSnapshot = createProductionSnapshot(Date.now(), { isMock: true });
    const provider = new SnapshotRateProvider({
      snapshotUrl: '/api/rates.json',
      fetch: async () => new Response(JSON.stringify(invalidSnapshot)),
    });

    const engine = new RateEngine();
    engine.registerProvider(provider);
    const activation = await engine.setActiveProviderAsync(provider.id);
    const snapshot = provider.getLatestSnapshot();
    let badgeText = 'Checking rates…';

    if (
      activation.valid &&
      snapshot &&
      typeof snapshot.timestamp === 'number' &&
      isLiveSnapshotAcceptable(snapshot)
    ) {
      badgeText = 'Live rates';
    } else {
      badgeText = 'Demo rates';
    }

    assert.equal(badgeText, 'Demo rates');
  });

  it('keeps browser status non-live after the static snapshot expiry', () => {
    const now = Date.now();
    const expiredSnapshot: RateSnapshotPayload = {
      ...createProductionSnapshot(now),
      staticMetadata: {
        generationTimestamp: now,
        expiryTimestamp: now + MAX_SNAPSHOT_AGE_MS,
        deliveryMode: 'static',
        revalidatesAtRequestTime: false,
      },
    };

    let clientEngine: RateEngine | undefined = new RateEngine();
    let badgeText = 'Live rates';
    if (!isLiveSnapshotAcceptable(expiredSnapshot, { now: now + MAX_SNAPSHOT_AGE_MS + 1 })) {
      clientEngine = undefined;
      badgeText = 'Demo rates';
    }

    assert.equal(clientEngine, undefined);
    assert.equal(badgeText, 'Demo rates');
  });
});
