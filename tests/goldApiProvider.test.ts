/**
 * Automated Test Suite for AllFinConverter M2.3
 *
 * Gold-API Precious Metals Rate Provider Adapter.
 *
 * Verifies:
 * 1. Correct normalization and mathematical inversion from USD/troy-oz to troy-oz/USD
 * 2. All four canonical precious metals (XAU, XAG, XPT, XPD) and asset model compatibility
 * 3. Strict validation against zero, negative, NaN, Infinity, non-numeric, and non-USD rates
 * 4. Preservation of publication timestamps from updatedAt (not Date.now())
 * 5. Robust HTTP error, network failure, timeout, and partial failure handling
 * 6. RateEngine integration and last-known-good (LKG) fault tolerance
 * 7. Composite assembly and orchestrator integration with per-asset provenance
 * 8. Offline isolation from default mock provider and zero network calls on instantiation
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  GoldApiRateProvider,
  GoldApiProviderError,
  normalizeGoldApiPriceResponse,
  normalizeGoldApiResponses,
  GOLD_API_SUPPORTED_METALS,
  DEFAULT_GOLD_API_BASE_URL,
} from '../src/lib/providers/goldApiProvider.ts';

import { validateRatePayload, RateEngine, defaultRateEngine } from '../src/lib/rateEngine.ts';
import { mergeSourceDatasets } from '../src/lib/compositeRates.ts';
import { RateOrchestrator } from '../src/lib/rateOrchestrator.ts';
import { MockRateProvider, MOCK_DATASET_TIMESTAMP } from '../src/lib/providers/mockProvider.ts';
import { calculateConversion } from '../src/lib/converter.ts';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Sample responses matching official gold-api.com schema */
const SAMPLE_GOLD_RESPONSE = {
  currency: 'USD',
  currencySymbol: '$',
  exchangeRate: 1,
  name: 'Gold',
  price: 2400.0,
  symbol: 'XAU',
  updatedAt: '2026-07-03T16:08:54Z',
  updatedAtReadable: 'a few seconds ago',
};

const SAMPLE_SILVER_RESPONSE = {
  currency: 'USD',
  currencySymbol: '$',
  exchangeRate: 1,
  name: 'Silver',
  price: 30.0,
  symbol: 'XAG',
  updatedAt: '2026-07-03T16:08:50Z',
  updatedAtReadable: 'a few seconds ago',
};

const SAMPLE_PLATINUM_RESPONSE = {
  currency: 'USD',
  currencySymbol: '$',
  exchangeRate: 1,
  name: 'Platinum',
  price: 1000.0,
  symbol: 'XPT',
  updatedAt: '2026-07-03T16:08:45Z',
  updatedAtReadable: 'a few seconds ago',
};

const SAMPLE_PALLADIUM_RESPONSE = {
  currency: 'USD',
  currencySymbol: '$',
  exchangeRate: 1,
  name: 'Palladium',
  price: 1000.0,
  symbol: 'XPD',
  updatedAt: '2026-07-03T16:08:40Z',
  updatedAtReadable: 'a few seconds ago',
};

/** Mock Response helper for custom fetch injection */
function createMockFetch(
  handler: (url: string) => { status: number; body: unknown; statusText?: string }
): typeof globalThis.fetch {
  return async (url) => {
    const { status, body, statusText = 'OK' } = handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: async () => {
        if (typeof body === 'string' && body === '__INVALID_JSON__') {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        }
        return body;
      },
    } as unknown as Response;
  };
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe('M2.3 — Normalization & USD-Base Mathematical Inversion', () => {
  it('should invert USD/troy-oz spot price into troy-oz/USD normalized rate', () => {
    // Spot price: $2400 per troy oz
    // Normalized rate (1 USD in troy oz): 1 / 2400 ≈ 0.00041666666666666667
    const result = normalizeGoldApiPriceResponse(SAMPLE_GOLD_RESPONSE);

    assert.equal(result.code, 'XAU');
    const expectedRate = new Big(1).div(new Big('2400')).toFixed();
    assert.equal(result.rate, expectedRate);

    // Exact UTC timestamp parsed from 2026-07-03T16:08:54Z
    const expectedTimestamp = Date.parse('2026-07-03T16:08:54Z');
    assert.equal(result.timestamp, expectedTimestamp);
    assert.notEqual(result.timestamp, Date.now(), 'Timestamp must reflect updatedAt, not fetch time');
  });

  it('should normalize all 4 metals into a valid RawRatePayload with USD = 1', () => {
    const responses = [
      SAMPLE_GOLD_RESPONSE,
      SAMPLE_SILVER_RESPONSE,
      SAMPLE_PLATINUM_RESPONSE,
      SAMPLE_PALLADIUM_RESPONSE,
    ];

    const payload = normalizeGoldApiResponses(responses);

    assert.equal(payload.providerId, 'goldapi');
    assert.equal(payload.providerName, 'Gold API');
    assert.equal(payload.isMock, false);

    // Oldest (minimum) timestamp among contributing metals to ensure no rate appears newer
    const expectedTimestamp = Date.parse('2026-07-03T16:08:40Z');
    assert.equal(payload.timestamp, expectedTimestamp);

    const rates = payload.rates as Record<string, string>;
    // Base USD rate injected
    assert.equal(rates['USD'], '1');

    // Rates inverted correctly
    assert.ok(new Big(rates['XAU']).eq(new Big(1).div(2400)));
    assert.ok(new Big(rates['XAG']).eq(new Big(1).div(30)));
    assert.ok(new Big(rates['XPT']).eq(new Big(1).div(1000)));
    assert.ok(new Big(rates['XPD']).eq(new Big(1).div(1000)));
  });

  it('should select the oldest (earliest) timestamp among contributing metals to ensure no rate appears newer', () => {
    const responses = [
      SAMPLE_GOLD_RESPONSE, // 16:08:54Z
      SAMPLE_SILVER_RESPONSE, // 16:08:50Z
      SAMPLE_PLATINUM_RESPONSE, // 16:08:45Z
      SAMPLE_PALLADIUM_RESPONSE, // 16:08:40Z
    ];
    const payload = normalizeGoldApiResponses(responses);
    assert.equal(payload.timestamp, Date.parse('2026-07-03T16:08:40Z'));
  });

  it('should pass strict validateRatePayload without errors', () => {
    const payload = normalizeGoldApiResponses([SAMPLE_GOLD_RESPONSE, SAMPLE_SILVER_RESPONSE]);
    const validation = validateRatePayload(payload);

    assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join('; ')}`);
    assert.ok(validation.dataset);
    assert.equal(validation.dataset!.baseAsset, 'USD');
    assert.ok(validation.dataset!.rates.get('USD')!.eq(1));
    assert.ok(validation.dataset!.rates.get('XAU')!.eq(new Big(1).div(2400)));
  });

  it('should produce mathematically exact conversion from spot price', () => {
    const payload = normalizeGoldApiResponses([SAMPLE_GOLD_RESPONSE]);
    const validation = validateRatePayload(payload);
    assert.ok(validation.dataset);

    // Spot price is $2400 / troy oz. At rate = 1/2400 troy oz per 1 USD:
    // 2400 USD * (1 / 2400) = exactly 1 troy oz of Gold
    const xauRate = validation.dataset!.rates.get('XAU')!;
    const troyOzFor2400Usd = new Big('2400').times(xauRate);
    assert.ok(
      troyOzFor2400Usd.minus(1).abs().lt(new Big('0.000000000001')),
      `Expected 1 troy oz, got ${troyOzFor2400Usd.toFixed()}`
    );
  });
});

describe('M2.3 — Supported Metals & Asset Model Compatibility', () => {
  it('should support the four canonical precious metals XAU, XAG, XPT, XPD', () => {
    assert.equal(GOLD_API_SUPPORTED_METALS.length, 4);
    assert.deepEqual([...GOLD_API_SUPPORTED_METALS], ['XAU', 'XAG', 'XPT', 'XPD']);
  });

  it('should reject non-metal or unsupported symbols', () => {
    const copperResponse = { ...SAMPLE_GOLD_RESPONSE, symbol: 'HG', name: 'Copper' };
    assert.throws(
      () => normalizeGoldApiPriceResponse(copperResponse),
      /Unsupported metal symbol/
    );

    const btcResponse = { ...SAMPLE_GOLD_RESPONSE, symbol: 'BTC', name: 'Bitcoin' };
    assert.throws(
      () => normalizeGoldApiPriceResponse(btcResponse),
      /Unsupported metal symbol/
    );
  });
});

describe('M2.3 — Invalid, Non-Finite, Non-Positive, and Missing Rates', () => {
  it('should reject zero price', () => {
    const zeroPrice = { ...SAMPLE_GOLD_RESPONSE, price: 0 };
    assert.throws(
      () => normalizeGoldApiPriceResponse(zeroPrice),
      /Non-positive price/
    );
  });

  it('should reject negative price', () => {
    const negativePrice = { ...SAMPLE_GOLD_RESPONSE, price: -2400 };
    assert.throws(
      () => normalizeGoldApiPriceResponse(negativePrice),
      /Non-positive price/
    );
  });

  it('should reject NaN, Infinity, and non-numeric price', () => {
    assert.throws(
      () => normalizeGoldApiPriceResponse({ ...SAMPLE_GOLD_RESPONSE, price: NaN }),
      /Invalid or non-numeric price/
    );
    assert.throws(
      () => normalizeGoldApiPriceResponse({ ...SAMPLE_GOLD_RESPONSE, price: Infinity }),
      /Invalid or non-numeric price/
    );
    assert.throws(
      () => normalizeGoldApiPriceResponse({ ...SAMPLE_GOLD_RESPONSE, price: 'invalid' }),
      /Invalid or non-numeric price/
    );
    assert.throws(
      () => normalizeGoldApiPriceResponse({ ...SAMPLE_GOLD_RESPONSE, price: true }),
      /Invalid or non-numeric price/
    );
  });

  it('should reject non-USD currency', () => {
    const eurCurrency = { ...SAMPLE_GOLD_RESPONSE, currency: 'EUR' };
    assert.throws(
      () => normalizeGoldApiPriceResponse(eurCurrency),
      /currency must be 'USD'/
    );
  });

  it('should reject missing or invalid updatedAt timestamp', () => {
    assert.throws(
      () => normalizeGoldApiPriceResponse({ ...SAMPLE_GOLD_RESPONSE, updatedAt: '' }),
      /missing valid updatedAt/
    );
    assert.throws(
      () => normalizeGoldApiPriceResponse({ ...SAMPLE_GOLD_RESPONSE, updatedAt: 'not-a-date' }),
      /Failed to parse valid epoch timestamp/
    );
  });

  it('should reject responses array when no valid metal rates can be extracted', () => {
    assert.throws(
      () => normalizeGoldApiResponses([{ ...SAMPLE_GOLD_RESPONSE, price: -100 }]),
      /No valid precious metal rates found/
    );
    assert.throws(
      () => normalizeGoldApiResponses([]),
      /No valid precious metal rates found/
    );
  });
});

describe('M2.3 — HTTP Errors, Network Failures, and Timeouts', () => {
  it('should fetch all four metals concurrently and normalize', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        if (url.includes('/XAG')) return { status: 200, body: SAMPLE_SILVER_RESPONSE };
        if (url.includes('/XPT')) return { status: 200, body: SAMPLE_PLATINUM_RESPONSE };
        if (url.includes('/XPD')) return { status: 200, body: SAMPLE_PALLADIUM_RESPONSE };
        return { status: 404, body: { message: 'not found' } };
      }),
    });

    const payload = await provider.getRates();
    assert.equal(payload.providerId, 'goldapi');

    const rates = payload.rates as Record<string, string>;
    assert.equal(rates['USD'], '1');
    assert.ok(rates['XAU']);
    assert.ok(rates['XAG']);
    assert.ok(rates['XPT']);
    assert.ok(rates['XPD']);
  });

  it('should reject partial failure by default (requireAll=true) to protect LKG dataset', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        if (url.includes('/XAG')) return { status: 200, body: SAMPLE_SILVER_RESPONSE };
        // XPT and XPD return 500 error
        return { status: 500, body: 'Server Error', statusText: 'Internal Server Error' };
      }),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof GoldApiProviderError);
        assert.match(err.message, /requireAll=true/);
        return true;
      }
    );
  });

  it('should allow partial payload when requireAll=false', async () => {
    const provider = new GoldApiRateProvider({
      requireAll: false,
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        if (url.includes('/XAG')) return { status: 200, body: SAMPLE_SILVER_RESPONSE };
        // XPT and XPD return 500 error
        return { status: 500, body: 'Server Error', statusText: 'Internal Server Error' };
      }),
    });

    const payload = await provider.getRates();
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['USD'], '1');
    assert.ok(rates['XAU']);
    assert.ok(rates['XAG']);
    assert.equal(rates['XPT'], undefined);
    assert.equal(rates['XPD'], undefined);
  });

  it('should throw GoldApiProviderError when all metal requests fail', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch(() => ({
        status: 503,
        body: 'Service Unavailable',
        statusText: 'Service Unavailable',
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof GoldApiProviderError);
        assert.match(err.message, /All Gold-API metal requests failed/);
        return true;
      }
    );
  });

  it('should handle network timeout without unhandled rejection', async () => {
    const provider = new GoldApiRateProvider({
      fetch: async (_url, init) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: async () => SAMPLE_GOLD_RESPONSE,
            } as unknown as Response);
          }, 100);

          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      },
      timeoutMs: 15,
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof GoldApiProviderError);
        assert.match(err.message, /timed out/);
        return true;
      }
    );
  });

  it('should handle malformed JSON response body', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: '__INVALID_JSON__',
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof GoldApiProviderError);
        assert.match(err.message, /Failed to parse Gold-API JSON response/);
        return true;
      }
    );
  });

  it('should provide safe non-throwing getRatesSafe method', async () => {
    const failingProvider = new GoldApiRateProvider({
      fetch: createMockFetch(() => ({
        status: 500,
        body: 'Error',
        statusText: 'Internal Server Error',
      })),
    });

    const failureResult = await failingProvider.getRatesSafe();
    assert.equal(failureResult.payload, null);
    assert.ok(failureResult.error instanceof GoldApiProviderError);

    const goodProvider = new GoldApiRateProvider({
      fetch: createMockFetch(() => ({ status: 200, body: SAMPLE_GOLD_RESPONSE })),
    });

    const successResult = await goodProvider.getRatesSafe();
    assert.equal(successResult.error, null);
    assert.ok(successResult.payload);
  });
});

describe('M2.3 — RateEngine Integration & Fault Tolerance (LKG)', () => {
  it('should load Gold-API rates asynchronously into RateEngine', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        return { status: 200, body: SAMPLE_SILVER_RESPONSE };
      }),
    });

    const engine = new RateEngine(new MockRateProvider());
    const validation = await engine.loadFromProviderAsync(provider);

    assert.equal(validation.valid, true);
    assert.ok(engine.getRate('XAU').eq(new Big(1).div(2400)));
  });

  it('should retain last-known-good dataset when Gold-API encounters an outage', async () => {
    let shouldFail = false;
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch(() => {
        if (shouldFail) {
          return { status: 503, body: 'Unavailable', statusText: 'Service Unavailable' };
        }
        return { status: 200, body: SAMPLE_GOLD_RESPONSE };
      }),
    });

    const engine = new RateEngine(new MockRateProvider());

    // 1. Initial success establishes LKG
    await engine.loadFromProviderAsync(provider);
    assert.ok(engine.getRate('XAU').eq(new Big(1).div(2400)));

    // 2. Outage triggers graceful fallback
    shouldFail = true;
    const failedResult = await engine.loadFromProviderAsync(provider);

    assert.equal(failedResult.valid, false);
    assert.equal(engine.isAvailable(), true);
    assert.ok(engine.getRate('XAU').eq(new Big(1).div(2400)), 'LKG rate retained');
    assert.equal(engine.getStatus().isLastKnownGood, true);
  });
});

describe('M2.3 — Composite Assembly & Orchestrator Integration', () => {
  it('should merge Gold-API metal rates with fiat into a multi-provider composite', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        if (url.includes('/XAG')) return { status: 200, body: SAMPLE_SILVER_RESPONSE };
        return { status: 200, body: SAMPLE_PLATINUM_RESPONSE };
      }),
    });

    const payload = await provider.getRates();
    const validation = validateRatePayload(payload);
    assert.ok(validation.dataset);

    // Simulated fiat dataset
    const fiatDataset = {
      providerId: 'frankfurter',
      providerName: 'Frankfurter FX',
      baseAsset: 'USD',
      timestamp: 1775700000000,
      rates: new Map([
        ['USD', new Big(1)],
        ['EUR', new Big('0.92')],
        ['GBP', new Big('0.79')],
      ]),
      isMock: false,
    };

    const composite = mergeSourceDatasets([
      { dataset: fiatDataset },
      { dataset: validation.dataset! },
    ]);

    assert.ok(composite.dataset);
    assert.equal(composite.contributingSources.length, 2);
    assert.ok(composite.contributingSources.includes('goldapi'));
    assert.ok(composite.contributingSources.includes('frankfurter'));

    // Provenance tracks Gold API for metals
    const xauProv = composite.provenance.get('XAU')!;
    assert.equal(xauProv.sourceId, 'goldapi');
    assert.equal(xauProv.sourceName, 'Gold API');
    assert.equal(xauProv.timestamp, Date.parse('2026-07-03T16:08:45Z'));

    // Provenance tracks Frankfurter for fiat
    const eurProv = composite.provenance.get('EUR')!;
    assert.equal(eurProv.sourceId, 'frankfurter');
    assert.equal(eurProv.timestamp, 1775700000000);
  });

  it('should register and refresh GoldApiRateProvider in RateOrchestrator', async () => {
    const provider = new GoldApiRateProvider({
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        return { status: 200, body: SAMPLE_SILVER_RESPONSE };
      }),
    });

    const orchestrator = new RateOrchestrator();
    orchestrator.registerProvider(provider);

    const result = await orchestrator.refreshAll();
    assert.equal(result.success, true);
    assert.equal(result.successfulRefreshes, 1);
    assert.ok(result.composite.dataset!.rates.has('XAU'));
  });

  it('should retain all 4 metals in LKG when a subsequent refresh encounters a partial metal failure', async () => {
    let failPlatinum = false;
    const provider = new GoldApiRateProvider({
      // requireAll: true by default preserves LKG
      fetch: createMockFetch((url) => {
        if (url.includes('/XAU')) return { status: 200, body: SAMPLE_GOLD_RESPONSE };
        if (url.includes('/XAG')) return { status: 200, body: SAMPLE_SILVER_RESPONSE };
        if (url.includes('/XPT')) {
          if (failPlatinum) return { status: 500, body: 'XPT failure' };
          return { status: 200, body: SAMPLE_PLATINUM_RESPONSE };
        }
        if (url.includes('/XPD')) return { status: 200, body: SAMPLE_PALLADIUM_RESPONSE };
        return { status: 404, body: 'Not Found' };
      }),
    });

    const orchestrator = new RateOrchestrator();
    orchestrator.registerProvider(provider);

    // Initial full refresh succeeds with all 4 metals
    const initialResult = await orchestrator.refreshAll();
    assert.equal(initialResult.success, true);
    assert.ok(initialResult.composite.dataset!.rates.has('XAU'));
    assert.ok(initialResult.composite.dataset!.rates.has('XAG'));
    assert.ok(initialResult.composite.dataset!.rates.has('XPT'));
    assert.ok(initialResult.composite.dataset!.rates.has('XPD'));

    // Second refresh encounters partial failure (XPT fails)
    failPlatinum = true;
    const secondResult = await orchestrator.refreshAll();
    assert.equal(secondResult.success, false);
    // LKG retains all 4 metals intact
    assert.ok(secondResult.composite.dataset!.rates.has('XAU'));
    assert.ok(secondResult.composite.dataset!.rates.has('XAG'));
    assert.ok(secondResult.composite.dataset!.rates.has('XPT'));
    assert.ok(secondResult.composite.dataset!.rates.has('XPD'));
  });
});

describe('M2.3 — Offline Safety & Zero Network Calls on Import', () => {
  it('should maintain defaultRateEngine on mock-local provider', () => {
    assert.equal(defaultRateEngine.getActiveProviderId(), 'mock-local');
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(defaultRateEngine.getStatus().timestamp, MOCK_DATASET_TIMESTAMP);
  });

  it('should instantiate GoldApiRateProvider with zero network requests', () => {
    let fetchCalled = false;
    const provider = new GoldApiRateProvider({
      fetch: async () => {
        fetchCalled = true;
        throw new Error('Should not be called during instantiation');
      },
    });

    assert.equal(fetchCalled, false, 'Instantiation must not trigger fetch');
    assert.equal(provider.id, 'goldapi');
    assert.equal(provider.name, 'Gold API');
    assert.equal(provider.isMock, false);
  });

  it('should use default base URL https://api.gold-api.com when not specified', () => {
    assert.equal(DEFAULT_GOLD_API_BASE_URL, 'https://api.gold-api.com');
  });
});
