/**
 * Automated Integration Test Suite for AllFinConverter M2.5
 *
 * Multi-Provider Composite Orchestrator Integration (Offline / Mock-Only).
 *
 * Verifies:
 * 1. createAllFinRateOrchestrator factory assembling Frankfurter, Gold-API, and CoinGecko
 * 2. Complete 19 canonical asset coverage in a single coordinated refresh
 * 3. Exact reciprocal rate normalization across fiat, metals, and crypto
 * 4. Per-asset provenance tracking (sourceId, sourceName, timestamp)
 * 5. Independent provider failure handling and Last-Known-Good (LKG) retention
 * 6. RateEngine synchronization and cross-asset conversion calculations:
 *    - BTC <-> XAU (crypto to precious metal, unit toggle support)
 *    - EUR <-> SOL (fiat to crypto)
 *    - XAG <-> JPY (precious metal to fiat)
 * 7. Provider priority conflict resolution and custom option merging
 * 8. Offline invariant: defaultRateEngine is unchanged on mock-local, zero live network requests
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  createAllFinRateOrchestrator,
  RateOrchestrator,
} from '../src/lib/rateOrchestrator.ts';

import {
  RateEngine,
  defaultRateEngine,
  type RateEngineError,
} from '../src/lib/rateEngine.ts';

import {
  calculateConversion,
  GRAMS_PER_TROY_OUNCE,
} from '../src/lib/converter.ts';

import {
  MockRateProvider,
  MOCK_DATASET_TIMESTAMP,
} from '../src/lib/providers/mockProvider.ts';

import { ASSETS, getSupportedAssets } from '../src/lib/assets.ts';

// ---------------------------------------------------------------------------
// Mock Response Fixtures
// ---------------------------------------------------------------------------

/** Frankfurter response providing 9 fiat currencies against USD (base = USD) */
const MOCK_FRANKFURTER_RESPONSE = {
  amount: 1,
  base: 'USD',
  date: '2026-07-03',
  rates: {
    EUR: 0.92,
    GBP: 0.79,
    JPY: 155.0,
    CHF: 0.9,
    CAD: 1.36,
    AUD: 1.52,
    ZAR: 18.25,
    INR: 83.5,
    AED: 3.67,
  },
};

/** Gold-API responses for the four canonical precious metals */
const MOCK_GOLD_API_RESPONSES: Record<string, unknown> = {
  XAU: {
    symbol: 'XAU',
    name: 'Gold',
    price: 2400.0,
    currency: 'USD',
    updatedAt: '2026-07-03T16:08:50Z',
  },
  XAG: {
    symbol: 'XAG',
    name: 'Silver',
    price: 30.0,
    currency: 'USD',
    updatedAt: '2026-07-03T16:08:45Z',
  },
  XPT: {
    symbol: 'XPT',
    name: 'Platinum',
    price: 1000.0,
    currency: 'USD',
    updatedAt: '2026-07-03T16:08:40Z',
  },
  XPD: {
    symbol: 'XPD',
    name: 'Palladium',
    price: 950.0,
    currency: 'USD',
    updatedAt: '2026-07-03T16:08:35Z', // oldest metal timestamp
  },
};

/** CoinGecko response providing all 5 canonical crypto assets */
const MOCK_COINGECKO_RESPONSE = {
  bitcoin: { usd: 65000.0, last_updated_at: 1783094930 },
  ethereum: { usd: 3500.0, last_updated_at: 1783094925 },
  solana: { usd: 150.0, last_updated_at: 1783094920 },
  ripple: { usd: 0.55, last_updated_at: 1783094915 },
  dogecoin: { usd: 0.12, last_updated_at: 1783094910 }, // oldest crypto timestamp
};

/**
 * Universal mock fetch router dispatching to Frankfurter, Gold-API, or CoinGecko.
 */
function createMockFetchRouter(overrides?: {
  frankfurterFail?: boolean;
  goldApiFail?: boolean;
  goldApiFailSymbol?: string;
  coinGeckoFail?: boolean;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof globalThis.fetch {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(url);
    overrides?.onCall?.(urlStr, init);

    // 1. Frankfurter endpoint
    if (urlStr.includes('api.frankfurter.dev') || urlStr.includes('/v1/latest')) {
      if (overrides?.frankfurterFail) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ message: 'Frankfurter outage' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => MOCK_FRANKFURTER_RESPONSE,
      } as unknown as Response;
    }

    // 2. Gold-API endpoints (/price/{symbol})
    if (urlStr.includes('api.gold-api.com') || urlStr.includes('/price/')) {
      if (overrides?.goldApiFail) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ message: 'Gold-API outage' }),
        } as unknown as Response;
      }
      for (const [sym, data] of Object.entries(MOCK_GOLD_API_RESPONSES)) {
        if (urlStr.includes(`/price/${sym}`)) {
          if (overrides?.goldApiFailSymbol === sym) {
            return {
              ok: false,
              status: 500,
              statusText: 'Internal Server Error',
              json: async () => ({ message: `${sym} outage` }),
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => data,
          } as unknown as Response;
        }
      }
    }

    // 3. CoinGecko endpoint (/simple/price)
    if (urlStr.includes('coingecko.com') || urlStr.includes('/simple/price')) {
      if (overrides?.coinGeckoFail) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({ error: 'Rate limit exceeded' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => MOCK_COINGECKO_RESPONSE,
      } as unknown as Response;
    }

    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'Unknown mock route' }),
    } as unknown as Response;
  };
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe('M2.5 — Factory Assembly & Configurable Precedence', () => {
  it('should assemble all three providers with createAllFinRateOrchestrator', () => {
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
    });

    assert.ok(orchestrator instanceof RateOrchestrator);
    const statuses = orchestrator.getAllProviderStates();
    assert.equal(statuses.length, 3);

    const ids = statuses.map((s) => s.provider.id);
    assert.ok(ids.includes('frankfurter'));
    assert.ok(ids.includes('goldapi'));
    assert.ok(ids.includes('coingecko'));
  });

  it('should give provider-specific options precedence over global defaults', async () => {
    let capturedFrankfurterFetch = false;
    let capturedGlobalFetch = false;

    const orchestrator = createAllFinRateOrchestrator({
      // Global fetch
      fetch: async (url, init) => {
        capturedGlobalFetch = true;
        return createMockFetchRouter()(url, init);
      },
      // Provider-specific fetch override for Frankfurter
      frankfurterOptions: {
        fetch: async (url, init) => {
          capturedFrankfurterFetch = true;
          return createMockFetchRouter()(url, init);
        },
      },
    });

    await orchestrator.refreshProvider('frankfurter');
    assert.equal(capturedFrankfurterFetch, true, 'Provider-specific fetch must be called');
    assert.equal(capturedGlobalFetch, false, 'Global fetch must not be called when overridden');
  });

  it('should configure custom priorities and composite metadata', () => {
    const orchestrator = createAllFinRateOrchestrator({
      compositeId: 'custom-composite',
      compositeName: 'Custom Multi-Provider',
      priorities: {
        frankfurter: 15,
        goldApi: 20,
        coinGecko: 25,
      },
    });

    const statusMap = new Map(
      orchestrator.getAllProviderStates().map((s) => [s.provider.id, s])
    );
    assert.equal(statusMap.get('frankfurter')?.priority, 15);
    assert.equal(statusMap.get('goldapi')?.priority, 20);
    assert.equal(statusMap.get('coingecko')?.priority, 25);
  });
});

describe('M2.5 — Full 19-Asset Coordinated Refresh & Provenance Tracking', () => {
  it('should refresh all three providers and assemble a composite containing all 19 supported assets', async () => {
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
    });

    const result = await orchestrator.refreshAll();
    assert.equal(result.success, true);
    assert.equal(result.successfulRefreshes, 3);
    assert.equal(result.failedRefreshes, 0);

    const composite = result.composite;
    assert.ok(composite.dataset);

    // 1. Verify USD base = 1
    assert.equal(composite.dataset!.baseAsset, 'USD');
    assert.ok(composite.dataset!.rates.get('USD')!.eq(1));

    // 2. Verify all 19 canonical supported assets are present
    const supportedAssets = getSupportedAssets();
    assert.equal(supportedAssets.length, 19);

    for (const asset of supportedAssets) {
      assert.ok(
        composite.dataset!.rates.has(asset.code),
        `Composite must contain rate for ${asset.code}`
      );
      const rate = composite.dataset!.rates.get(asset.code)!;
      assert.ok(rate.gt(0), `Rate for ${asset.code} must be strictly positive`);
    }

    // 3. Verify total rate count (19 assets + USD base = 19 unique codes because USD is in supportedAssets)
    assert.equal(composite.dataset!.rates.size, 19);
  });

  it('should preserve distinct per-asset source and timestamp provenance', async () => {
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
    });

    const result = await orchestrator.refreshAll();
    const provenance = result.composite.provenance;

    // Fiat assets -> frankfurter
    const eurProv = provenance.get('EUR')!;
    assert.equal(eurProv.sourceId, 'frankfurter');
    assert.equal(eurProv.sourceName, 'Frankfurter FX');
    assert.equal(eurProv.timestamp, Date.parse('2026-07-03T00:00:00.000Z'));

    const zarProv = provenance.get('ZAR')!;
    assert.equal(zarProv.sourceId, 'frankfurter');

    // Precious metal assets -> goldapi
    const xauProv = provenance.get('XAU')!;
    assert.equal(xauProv.sourceId, 'goldapi');
    assert.equal(xauProv.sourceName, 'Gold API');
    // Gold-API timestamp is the minimum contributing timestamp (XPD at 16:08:35Z)
    assert.equal(xauProv.timestamp, Date.parse('2026-07-03T16:08:35Z'));

    const xagProv = provenance.get('XAG')!;
    assert.equal(xagProv.sourceId, 'goldapi');

    // Crypto assets -> coingecko
    const btcProv = provenance.get('BTC')!;
    assert.equal(btcProv.sourceId, 'coingecko');
    assert.equal(btcProv.sourceName, 'CoinGecko Crypto');
    // CoinGecko timestamp is the minimum contributing timestamp (dogecoin at 1783094910000)
    assert.equal(btcProv.timestamp, 1783094910000);

    const solProv = provenance.get('SOL')!;
    assert.equal(solProv.sourceId, 'coingecko');
  });

  it('should maintain exact mathematical reciprocal rates for each asset class', async () => {
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
    });

    const result = await orchestrator.refreshAll();
    const rates = result.composite.dataset!.rates;

    // Fiat: direct rates from Frankfurter
    assert.ok(rates.get('EUR')!.eq(new Big('0.92')));
    assert.ok(rates.get('GBP')!.eq(new Big('0.79')));
    assert.ok(rates.get('JPY')!.eq(new Big('155.0')));

    // Metals: inverted rates (1 / USD price) from Gold-API
    assert.ok(rates.get('XAU')!.eq(new Big(1).div(new Big('2400.0'))));
    assert.ok(rates.get('XAG')!.eq(new Big(1).div(new Big('30.0'))));
    assert.ok(rates.get('XPT')!.eq(new Big(1).div(new Big('1000.0'))));

    // Crypto: inverted rates (1 / USD price) from CoinGecko
    assert.ok(rates.get('BTC')!.eq(new Big(1).div(new Big('65000.0'))));
    assert.ok(rates.get('ETH')!.eq(new Big(1).div(new Big('3500.0'))));
    assert.ok(rates.get('SOL')!.eq(new Big(1).div(new Big('150.0'))));
    assert.ok(rates.get('DOGE')!.eq(new Big(1).div(new Big('0.12'))));
  });
});

describe('M2.5 — Multi-Source Failure Isolation & LKG Resilience', () => {
  it('should retain LKG data for failing providers while successful providers continue updating', async () => {
    let coinGeckoOutage = false;
    let goldApiOutage = false;

    const orchestrator = createAllFinRateOrchestrator({
      fetch: (url, init) =>
        createMockFetchRouter({
          coinGeckoFail: coinGeckoOutage,
          goldApiFail: goldApiOutage,
        })(url, init),
    });

    // 1. Initial full refresh succeeds, establishing LKG for all 3 providers
    const initialResult = await orchestrator.refreshAll();
    assert.equal(initialResult.success, true);
    assert.equal(initialResult.composite.dataset!.rates.size, 19);

    // 2. CoinGecko encounters an outage (e.g. rate limit 429)
    coinGeckoOutage = true;
    const secondResult = await orchestrator.refreshAll();

    // Partial failure: overall success is false, but 2 providers succeeded
    assert.equal(secondResult.success, false);
    assert.equal(secondResult.successfulRefreshes, 2);
    assert.equal(secondResult.failedRefreshes, 1);
    assert.ok(secondResult.providerErrors.has('coingecko'));

    // Crucial: Composite still retains all 19 assets because CoinGecko LKG was preserved!
    assert.equal(secondResult.composite.dataset!.rates.size, 19);
    assert.ok(secondResult.composite.dataset!.rates.has('BTC'));
    assert.ok(secondResult.composite.dataset!.rates.has('EUR'));
    assert.ok(secondResult.composite.dataset!.rates.has('XAU'));

    // 3. Both CoinGecko and Gold-API encounter outages, only Frankfurter succeeds
    goldApiOutage = true;
    const thirdResult = await orchestrator.refreshAll();

    assert.equal(thirdResult.success, false);
    assert.equal(thirdResult.successfulRefreshes, 1);
    assert.equal(thirdResult.failedRefreshes, 2);

    // Composite still has all 19 assets from LKG!
    assert.equal(thirdResult.composite.dataset!.rates.size, 19);
    assert.ok(thirdResult.composite.dataset!.rates.has('ETH'));
    assert.ok(thirdResult.composite.dataset!.rates.has('XAG'));
  });

  it('should handle partial metal failure with requireAll=true protecting the complete metals LKG dataset', async () => {
    let failXpt = false;

    const orchestrator = createAllFinRateOrchestrator({
      fetch: (url, init) =>
        createMockFetchRouter({
          goldApiFailSymbol: failXpt ? 'XPT' : undefined,
        })(url, init),
    });

    // Initial full refresh succeeds with 4 metals
    await orchestrator.refreshAll();
    assert.ok(orchestrator.getLatestComposite()!.dataset!.rates.has('XPT'));

    // XPT fails on subsequent cycle
    failXpt = true;
    const refreshResult = await orchestrator.refreshAll();

    assert.equal(refreshResult.success, false);
    assert.ok(refreshResult.providerErrors.has('goldapi'));
    // Entire 4-metal LKG is retained intact without dropping XPT
    assert.ok(refreshResult.composite.dataset!.rates.has('XAU'));
    assert.ok(refreshResult.composite.dataset!.rates.has('XPT'));
    assert.ok(refreshResult.composite.dataset!.rates.has('XPD'));
  });
});

describe('M2.5 — RateEngine Synchronization & Cross-Asset Conversions', () => {
  it('should synchronize composite dataset to an attached RateEngine upon refreshAll', async () => {
    const engine = new RateEngine(new MockRateProvider());
    assert.equal(engine.getActiveProviderId(), 'mock-local');

    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
      rateEngine: engine,
    });

    await orchestrator.refreshAll();

    // RateEngine is now synchronized with composite rates
    assert.equal(engine.hasRate('BTC'), true);
    assert.equal(engine.hasRate('EUR'), true);
    assert.equal(engine.hasRate('XAU'), true);

    // Rates in engine match the live provider reciprocal rates
    assert.ok(engine.getRate('BTC').eq(new Big(1).div(65000)));
    assert.ok(engine.getRate('XAU').eq(new Big(1).div(2400)));
    assert.ok(engine.getRate('EUR').eq(new Big('0.92')));
  });

  it('should calculate accurate cross-asset conversion for BTC <-> XAU (crypto to metal)', async () => {
    const engine = new RateEngine(new MockRateProvider());
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
      rateEngine: engine,
    });
    await orchestrator.refreshAll();

    // 1 BTC = $65,000 USD
    // 1 troy oz XAU = $2,400 USD
    // 1 BTC in XAU (troy oz) = 65,000 / 2,400 ≈ 27.083333... troy oz
    const convBtcToXau = calculateConversion('1', 'BTC', 'XAU', { rateEngine: engine });
    const expectedXauOz = new Big('65000').div(new Big('2400'));

    assert.ok(
      convBtcToXau.targetAmount.minus(expectedXauOz).abs().lt('0.0000000001'),
      '1 BTC in XAU troy oz must match exact ratio'
    );
    assert.equal(convBtcToXau.toUnit, 'troy-oz');

    // Test precious metal unit toggle to grams:
    // 1 troy oz = 31.1034768 grams
    // Target grams = (65,000 / 2,400) * 31.1034768
    const convBtcToXauGrams = calculateConversion('1', 'BTC', 'XAU', {
      toUnit: 'g',
      rateEngine: engine,
    });
    const expectedXauGrams = expectedXauOz.times(GRAMS_PER_TROY_OUNCE);
    assert.ok(
      convBtcToXauGrams.targetAmount.minus(expectedXauGrams).abs().lt('0.0000000001'),
      '1 BTC in XAU grams must match exact ratio times grams constant'
    );
    assert.equal(convBtcToXauGrams.toUnit, 'g');

    // Inverse conversion: XAU -> BTC
    const convXauToBtc = calculateConversion('1', 'XAU', 'BTC', { rateEngine: engine });
    const expectedBtcFrom1Xau = new Big('2400').div(new Big('65000'));
    assert.ok(
      convXauToBtc.targetAmount.minus(expectedBtcFrom1Xau).abs().lt('0.0000000001'),
      '1 XAU in BTC must match inverse ratio'
    );
  });

  it('should calculate accurate cross-asset conversion for EUR <-> SOL (fiat to crypto)', async () => {
    const engine = new RateEngine(new MockRateProvider());
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
      rateEngine: engine,
    });
    await orchestrator.refreshAll();

    // 1 USD = 0.92 EUR  =>  1 EUR = (1 / 0.92) USD
    // 1 SOL = $150 USD  =>  1 USD = (1 / 150) SOL
    // 100 EUR in USD = 100 / 0.92 ≈ 108.695652 USD
    // 100 EUR in SOL = (100 / 0.92) / 150 ≈ 0.72463768 SOL
    const convEurToSol = calculateConversion('100', 'EUR', 'SOL', { rateEngine: engine });
    const expectedSol = new Big('100').div(new Big('0.92')).div(new Big('150'));

    assert.ok(
      convEurToSol.targetAmount.minus(expectedSol).abs().lt('0.0000000001'),
      '100 EUR to SOL conversion must be mathematically exact'
    );

    // Inverse: 10 SOL in EUR
    // 10 SOL = $1500 USD => 1500 * 0.92 = 1380 EUR
    const convSolToEur = calculateConversion('10', 'SOL', 'EUR', { rateEngine: engine });
    const expectedEur = new Big('10').times(new Big('150')).times(new Big('0.92'));

    assert.ok(
      convSolToEur.targetAmount.minus(expectedEur).abs().lt('0.0000000001'),
      '10 SOL to EUR conversion must equal exactly 1380 EUR'
    );
  });

  it('should calculate accurate cross-asset conversion for XAG <-> JPY (metal to fiat)', async () => {
    const engine = new RateEngine(new MockRateProvider());
    const orchestrator = createAllFinRateOrchestrator({
      fetch: createMockFetchRouter(),
      rateEngine: engine,
    });
    await orchestrator.refreshAll();

    // 1 troy oz Silver (XAG) = $30 USD
    // 1 USD = 155 JPY
    // 1 troy oz XAG in JPY = 30 * 155 = 4650 JPY
    const convXagToJpy = calculateConversion('1', 'XAG', 'JPY', { rateEngine: engine });
    const expectedJpy = new Big('30').times(new Big('155'));

    assert.ok(
      convXagToJpy.targetAmount.minus(expectedJpy).abs().lt('0.0000000001'),
      '1 troy oz Silver must equal approximately 4650 JPY within division precision'
    );
  });
});

describe('M2.5 — Offline Safety Invariants', () => {
  it('should keep defaultRateEngine strictly on mock-local provider', () => {
    assert.equal(defaultRateEngine.getActiveProviderId(), 'mock-local');
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(defaultRateEngine.getStatus().timestamp, MOCK_DATASET_TIMESTAMP);
  });

  it('should preserve defaultRateEngine behavior when calculateConversion options omit rateEngine', () => {
    // When no rateEngine is passed, calculateConversion uses defaultRateEngine (mock rates)
    const result = calculateConversion('100', 'USD', 'EUR');
    // In mock rates, EUR is 0.92 => 100 USD = 92 EUR
    assert.ok(result.targetAmount.eq(92));
  });

  it('should instantiate createAllFinRateOrchestrator with zero network calls', () => {
    let networkCallMade = false;
    const orchestrator = createAllFinRateOrchestrator({
      fetch: async () => {
        networkCallMade = true;
        throw new Error('No network calls permitted during instantiation');
      },
    });

    assert.equal(networkCallMade, false, 'Instantiation must perform zero network calls');
    assert.ok(orchestrator instanceof RateOrchestrator);
  });
});
