/**
 * Automated Test Suite for AllFinConverter M2.1
 *
 * Frankfurter FX Rate Provider Adapter.
 *
 * Verifies:
 * 1. Correct normalization of Frankfurter response data
 * 2. USD base handling and the ten configured fiat assets
 * 3. Missing, unsupported, zero, negative, non-finite, and malformed rates
 * 4. Invalid JSON and HTTP failure handling (4xx, 5xx, network error, timeout)
 * 5. Preservation of source ID, source name, and actual rate-date provenance
 * 6. RateEngine integration and last-known-good (LKG) preservation
 * 7. Composite assembly with multi-provider provenance tracking
 * 8. Offline isolation from default mock provider and zero network calls on instantiation
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  FrankfurterRateProvider,
  FrankfurterProviderError,
  normalizeFrankfurterResponse,
  FRANKFURTER_SUPPORTED_FIAT_CODES,
  DEFAULT_FRANKFURTER_BASE_URL,
} from '../src/lib/providers/frankfurterProvider.ts';

import { validateRatePayload, RateEngine, defaultRateEngine } from '../src/lib/rateEngine.ts';
import { mergeSourceDatasets } from '../src/lib/compositeRates.ts';
import { MockRateProvider, MOCK_DATASET_TIMESTAMP } from '../src/lib/providers/mockProvider.ts';
import type { NormalizedRateDataset } from '../src/lib/rates.ts';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Realistic Frankfurter response payload (ECB daily reference rates, base=USD) */
const SAMPLE_FRANKFURTER_JSON = {
  amount: 1.0,
  base: 'USD',
  date: '2026-04-10',
  rates: {
    AUD: 1.5234,
    CAD: 1.3652,
    CHF: 0.9012,
    EUR: 0.9245,
    GBP: 0.7891,
    INR: 83.45,
    JPY: 155.23,
    ZAR: 18.32,
    // ECB also tracks other currencies not in our configured assets:
    BGN: 1.8081,
    CZK: 23.15,
    DKK: 6.897,
    HUF: 360.2,
    PLN: 4.012,
    SEK: 10.85,
  },
};

/** Mock Response helper for custom fetch injection */
function createMockFetch(
  status: number,
  body: unknown,
  statusText = 'OK',
  delayMs = 0
): typeof globalThis.fetch {
  return async () => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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

describe('M2.1 — Frankfurter Response Normalization & Provenance', () => {
  it('should normalize a standard Frankfurter response into valid RawRatePayload', () => {
    const payload = normalizeFrankfurterResponse(SAMPLE_FRANKFURTER_JSON);

    assert.equal(payload.providerId, 'frankfurter');
    assert.equal(payload.providerName, 'Frankfurter FX');
    assert.equal(payload.isMock, false);

    // Exact UTC midnight epoch ms for 2026-04-10
    const expectedTimestamp = Date.parse('2026-04-10T00:00:00.000Z');
    assert.equal(payload.timestamp, expectedTimestamp);
    assert.notEqual(payload.timestamp, Date.now(), 'Timestamp must reflect publication date, not fetch time');

    const rates = payload.rates as Record<string, string>;
    // Base USD injected with exactly 1
    assert.equal(rates['USD'], '1');

    // Supported ECB currencies present
    assert.equal(rates['EUR'], '0.9245');
    assert.equal(rates['GBP'], '0.7891');
    assert.equal(rates['JPY'], '155.23');
    assert.equal(rates['CHF'], '0.9012');
    assert.equal(rates['CAD'], '1.3652');
    assert.equal(rates['AUD'], '1.5234');
    assert.equal(rates['ZAR'], '18.32');
    assert.equal(rates['INR'], '83.45');
  });

  it('should pass strict validateRatePayload without errors', () => {
    const payload = normalizeFrankfurterResponse(SAMPLE_FRANKFURTER_JSON);
    const result = validateRatePayload(payload);

    assert.equal(result.valid, true, `Validation failed: ${result.errors.join('; ')}`);
    assert.ok(result.dataset);
    assert.equal(result.dataset!.providerId, 'frankfurter');
    assert.equal(result.dataset!.baseAsset, 'USD');
    assert.ok(result.dataset!.rates.get('USD')!.eq(1));
    assert.ok(result.dataset!.rates.get('EUR')!.eq(new Big('0.9245')));
  });
});

describe('M2.1 — Ten Supported Fiat Assets & Missing Rates', () => {
  it('should support all ten configured fiat asset codes', () => {
    assert.equal(FRANKFURTER_SUPPORTED_FIAT_CODES.length, 10);
    const expected = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'ZAR', 'INR', 'AED'];
    for (const code of expected) {
      assert.ok(
        FRANKFURTER_SUPPORTED_FIAT_CODES.includes(code as (typeof FRANKFURTER_SUPPORTED_FIAT_CODES)[number]),
        `Expected ${code} in supported fiat codes`
      );
    }
  });

  it('should safely omit AED when absent from response without setting it to zero', () => {
    // ECB does not publish AED rates, so AED is omitted from Frankfurter's response
    const payload = normalizeFrankfurterResponse(SAMPLE_FRANKFURTER_JSON);
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['AED'], undefined, 'AED should be absent from rates');
    assert.notEqual(rates['AED'], '0', 'Missing currency must NEVER be set to zero');
    assert.notEqual(rates['AED'], 0, 'Missing currency must NEVER be numeric zero');
  });

  it('should extract AED if provided in the response', () => {
    const jsonWithAed = {
      ...SAMPLE_FRANKFURTER_JSON,
      rates: {
        ...SAMPLE_FRANKFURTER_JSON.rates,
        AED: 3.6725,
      },
    };
    const payload = normalizeFrankfurterResponse(jsonWithAed);
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['AED'], '3.6725');
  });

  it('should discard unsupported currencies returned by Frankfurter', () => {
    const payload = normalizeFrankfurterResponse(SAMPLE_FRANKFURTER_JSON);
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['BGN'], undefined, 'BGN is not in configured assets and should be ignored');
    assert.equal(rates['CZK'], undefined, 'CZK is not in configured assets and should be ignored');
    assert.equal(rates['DKK'], undefined, 'DKK is not in configured assets and should be ignored');
    assert.equal(rates['HUF'], undefined, 'HUF is not in configured assets and should be ignored');
    assert.equal(rates['PLN'], undefined, 'PLN is not in configured assets and should be ignored');
    assert.equal(rates['SEK'], undefined, 'SEK is not in configured assets and should be ignored');
  });
});

describe('M2.1 — Invalid, Zero, Negative, Non-Finite, and Malformed Rates', () => {
  it('should omit zero, negative, NaN, and Infinity rates without converting to zero', () => {
    const jsonWithInvalid = {
      amount: 1.0,
      base: 'USD',
      date: '2026-04-10',
      rates: {
        EUR: 0, // Zero
        GBP: -0.78, // Negative
        JPY: NaN, // NaN
        CHF: Infinity, // Infinity
        CAD: -Infinity, // -Infinity
        AUD: 1.52, // Valid
      },
    };

    const payload = normalizeFrankfurterResponse(jsonWithInvalid);
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['EUR'], undefined, 'Zero rate must be omitted');
    assert.equal(rates['GBP'], undefined, 'Negative rate must be omitted');
    assert.equal(rates['JPY'], undefined, 'NaN rate must be omitted');
    assert.equal(rates['CHF'], undefined, 'Infinity rate must be omitted');
    assert.equal(rates['CAD'], undefined, '-Infinity rate must be omitted');
    assert.equal(rates['AUD'], '1.52', 'Valid rate must be preserved');
  });

  it('should omit non-numeric or malformed rate values', () => {
    const jsonWithMalformed = {
      amount: 1.0,
      base: 'USD',
      date: '2026-04-10',
      rates: {
        EUR: 'not-a-number',
        GBP: true,
        JPY: {},
        CHF: [],
        CAD: '',
        AUD: null,
        ZAR: undefined,
        INR: 83.5, // Valid
      },
    };

    const payload = normalizeFrankfurterResponse(jsonWithMalformed);
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['EUR'], undefined);
    assert.equal(rates['GBP'], undefined);
    assert.equal(rates['JPY'], undefined);
    assert.equal(rates['CHF'], undefined);
    assert.equal(rates['CAD'], undefined);
    assert.equal(rates['AUD'], undefined);
    assert.equal(rates['ZAR'], undefined);
    assert.equal(rates['INR'], '83.5');
  });

  it('should parse valid string rates accurately', () => {
    const jsonWithStringRates = {
      amount: 1.0,
      base: 'USD',
      date: '2026-04-10',
      rates: {
        EUR: '0.9245',
        GBP: ' 0.7891 ',
      },
    };

    const payload = normalizeFrankfurterResponse(jsonWithStringRates);
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['EUR'], '0.9245');
    assert.equal(rates['GBP'], '0.7891');
  });
});

describe('M2.1 — Malformed Payload Structure Validation', () => {
  it('should reject null or primitive inputs', () => {
    assert.throws(() => normalizeFrankfurterResponse(null), FrankfurterProviderError);
    assert.throws(() => normalizeFrankfurterResponse(undefined), FrankfurterProviderError);
    assert.throws(() => normalizeFrankfurterResponse('string'), FrankfurterProviderError);
    assert.throws(() => normalizeFrankfurterResponse(123), FrankfurterProviderError);
    assert.throws(() => normalizeFrankfurterResponse([]), FrankfurterProviderError);
  });

  it('should reject responses where base is not USD', () => {
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, base: 'EUR' }),
      /base must be 'USD'/
    );
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, base: undefined }),
      /base must be 'USD'/
    );
  });

  it('should reject missing or invalid date strings', () => {
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, date: 'invalid-date' }),
      /publication date/
    );
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, date: '' }),
      /publication date/
    );
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, date: undefined }),
      /publication date/
    );
  });

  it('should reject missing or non-object rates', () => {
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, rates: null }),
      /rates object/
    );
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, rates: [] }),
      /rates object/
    );
    assert.throws(
      () => normalizeFrankfurterResponse({ ...SAMPLE_FRANKFURTER_JSON, rates: undefined }),
      /rates object/
    );
  });
});

describe('M2.1 — HTTP Errors, Invalid JSON & Timeouts', () => {
  it('should handle HTTP 404 cleanly', async () => {
    const provider = new FrankfurterRateProvider({
      fetch: createMockFetch(404, { message: 'not found' }, 'Not Found'),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof FrankfurterProviderError);
        assert.match(err.message, /404/);
        return true;
      }
    );
  });

  it('should handle HTTP 500 server error cleanly', async () => {
    const provider = new FrankfurterRateProvider({
      fetch: createMockFetch(500, 'Internal Server Error', 'Internal Server Error'),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof FrankfurterProviderError);
        assert.match(err.message, /500/);
        return true;
      }
    );
  });

  it('should handle HTTP 503 service unavailable cleanly', async () => {
    const provider = new FrankfurterRateProvider({
      fetch: createMockFetch(503, 'Service Unavailable', 'Service Unavailable'),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof FrankfurterProviderError);
        assert.match(err.message, /503/);
        return true;
      }
    );
  });

  it('should handle invalid/malformed JSON body cleanly', async () => {
    const provider = new FrankfurterRateProvider({
      fetch: createMockFetch(200, '__INVALID_JSON__'),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof FrankfurterProviderError);
        assert.match(err.message, /Failed to parse Frankfurter JSON response/);
        return true;
      }
    );
  });

  it('should handle network timeout without crashing', async () => {
    // 50ms delay with 10ms timeout triggers AbortError
    const provider = new FrankfurterRateProvider({
      fetch: async (_url, init) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: async () => SAMPLE_FRANKFURTER_JSON,
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
        assert.ok(err instanceof FrankfurterProviderError);
        assert.match(err.message, /timed out/);
        return true;
      }
    );
  });

  it('should provide safe non-throwing getRatesSafe method', async () => {
    const failingProvider = new FrankfurterRateProvider({
      fetch: createMockFetch(500, 'Server Error', 'Internal Server Error'),
    });

    const result = await failingProvider.getRatesSafe();
    assert.equal(result.payload, null);
    assert.ok(result.error instanceof FrankfurterProviderError);
    assert.match(result.error.message, /500/);

    const successfulProvider = new FrankfurterRateProvider({
      fetch: createMockFetch(200, SAMPLE_FRANKFURTER_JSON),
    });

    const successResult = await successfulProvider.getRatesSafe();
    assert.equal(successResult.error, null);
    assert.ok(successResult.payload);
    assert.equal(successResult.payload.providerId, 'frankfurter');
  });
});

describe('M2.1 — RateEngine Integration & Fault Tolerance (LKG Preservation)', () => {
  it('should ingest valid rates via RateEngine.loadFromProviderAsync()', async () => {
    const provider = new FrankfurterRateProvider({
      fetch: createMockFetch(200, SAMPLE_FRANKFURTER_JSON),
    });

    const engine = new RateEngine(new MockRateProvider());
    const validation = await engine.loadFromProviderAsync(provider);

    assert.equal(validation.valid, true);
    assert.equal(engine.getActiveProviderId(), 'mock-local'); // Provider ID unchanged unless switched
    assert.equal(engine.isMock(), false);
    assert.ok(engine.getRate('USD').eq(1));
    assert.ok(engine.getRate('EUR').eq(new Big('0.9245')));
    assert.ok(engine.getRate('GBP').eq(new Big('0.7891')));
  });

  it('should retain last-known-good dataset when provider fails asynchronously', async () => {
    // 1. Initial success sets last-known-good
    const goodProvider = new FrankfurterRateProvider({
      fetch: createMockFetch(200, SAMPLE_FRANKFURTER_JSON),
    });

    const engine = new RateEngine(new MockRateProvider());
    await engine.loadFromProviderAsync(goodProvider);

    assert.ok(engine.getRate('EUR').eq(new Big('0.9245')));
    assert.equal(engine.getStatus().isLastKnownGood, false);

    // 2. Subsequent failure triggers fallback to LKG without crashing
    const failingProvider = new FrankfurterRateProvider({
      fetch: createMockFetch(503, 'Service Unavailable', 'Service Unavailable'),
    });

    const failedValidation = await engine.loadFromProviderAsync(failingProvider);

    assert.equal(failedValidation.valid, false);
    assert.ok(failedValidation.errors.length > 0);
    assert.match(failedValidation.errors[0], /503/);

    // Engine is STILL available using LKG!
    assert.equal(engine.isAvailable(), true);
    assert.ok(engine.getRate('EUR').eq(new Big('0.9245')), 'Valid rate retained from LKG');
    assert.equal(engine.getStatus().isLastKnownGood, true);
    assert.match(engine.getStatus().message!, /last-known-good/i);
  });
});

describe('M2.1 — Composite Rate Integration & Multi-Provider Provenance', () => {
  it('should combine Frankfurter fiat rates with other providers in composite', async () => {
    const provider = new FrankfurterRateProvider({
      fetch: createMockFetch(200, SAMPLE_FRANKFURTER_JSON),
    });
    const payload = await provider.getRates();
    const fiatValidation = validateRatePayload(payload);
    assert.ok(fiatValidation.valid && fiatValidation.dataset);

    // Simulated crypto dataset
    const cryptoTimestamp = Date.parse('2026-04-10T12:00:00.000Z');
    const cryptoDataset: NormalizedRateDataset = {
      providerId: 'coingecko',
      providerName: 'CoinGecko Crypto',
      baseAsset: 'USD',
      timestamp: cryptoTimestamp,
      rates: new Map([
        ['USD', new Big(1)],
        ['BTC', new Big('0.000014')],
        ['ETH', new Big('0.00035')],
      ]),
      isMock: false,
    };

    // Simulated metals dataset
    const metalsTimestamp = Date.parse('2026-04-10T15:00:00.000Z');
    const metalsDataset: NormalizedRateDataset = {
      providerId: 'goldapi',
      providerName: 'Gold API',
      baseAsset: 'USD',
      timestamp: metalsTimestamp,
      rates: new Map([
        ['USD', new Big(1)],
        ['XAU', new Big('0.000410')],
        ['XAG', new Big('0.035')],
      ]),
      isMock: false,
    };

    const composite = mergeSourceDatasets([
      { dataset: fiatValidation.dataset },
      { dataset: cryptoDataset },
      { dataset: metalsDataset },
    ]);

    assert.ok(composite.dataset);
    assert.equal(composite.contributingSources.length, 3);
    assert.ok(composite.contributingSources.includes('frankfurter'));

    // Provenance accurately tracks Frankfurter for fiat
    const eurProv = composite.provenance.get('EUR')!;
    assert.equal(eurProv.sourceId, 'frankfurter');
    assert.equal(eurProv.sourceName, 'Frankfurter FX');
    assert.equal(eurProv.timestamp, Date.parse('2026-04-10T00:00:00.000Z'));

    // Crypto provenance is distinct
    const btcProv = composite.provenance.get('BTC')!;
    assert.equal(btcProv.sourceId, 'coingecko');
    assert.equal(btcProv.timestamp, cryptoTimestamp);

    // Metals provenance is distinct
    const xauProv = composite.provenance.get('XAU')!;
    assert.equal(xauProv.sourceId, 'goldapi');
    assert.equal(xauProv.timestamp, metalsTimestamp);
  });
});

describe('M2.1 — Offline Isolation & Zero Network Calls on Import', () => {
  it('should maintain mock provider as default in defaultRateEngine', () => {
    assert.equal(defaultRateEngine.getActiveProviderId(), 'mock-local');
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(defaultRateEngine.getStatus().timestamp, MOCK_DATASET_TIMESTAMP);
  });

  it('should instantiate FrankfurterRateProvider with zero network requests', () => {
    let fetchCalled = false;
    const provider = new FrankfurterRateProvider({
      fetch: async () => {
        fetchCalled = true;
        throw new Error('Should not be called during instantiation');
      },
    });

    assert.equal(fetchCalled, false, 'Instantiation must not trigger fetch');
    assert.equal(provider.id, 'frankfurter');
    assert.equal(provider.name, 'Frankfurter FX');
    assert.equal(provider.isMock, false);
  });

  it('should use default Frankfurter base URL when not specified', () => {
    const provider = new FrankfurterRateProvider();
    assert.equal(DEFAULT_FRANKFURTER_BASE_URL, 'https://api.frankfurter.dev/v1');
  });
});
