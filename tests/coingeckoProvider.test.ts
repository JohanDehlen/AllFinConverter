/**
 * Automated Test Suite for AllFinConverter M2.4
 *
 * CoinGecko Crypto Rate Provider Adapter.
 *
 * Verifies:
 * 1. Correct normalization and mathematical inversion from USD spot prices to units-per-USD (1 / P)
 * 2. All five canonical cryptocurrencies (BTC, ETH, SOL, XRP, DOGE) fetched in a single batch request
 * 3. Strict validation against zero, negative, NaN, Infinity, and non-numeric rates
 * 4. Conversion of UNIX second timestamps to milliseconds and selection of minimum timestamp
 * 5. Authentication header handling (x-cg-demo-api-key, x-cg-pro-api-key, custom) and offline zero-key operation
 * 6. Robust HTTP error, network failure, timeout, and partial failure handling
 * 7. RateEngine integration and last-known-good (LKG) fault tolerance
 * 8. Composite assembly and orchestrator integration with per-asset provenance
 * 9. Offline isolation from default mock provider and zero network calls on instantiation
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  CoinGeckoRateProvider,
  CoinGeckoProviderError,
  normalizeCoinGeckoResponse,
  COINGECKO_SUPPORTED_CRYPTO,
  DEFAULT_COINGECKO_BASE_URL,
  PRO_COINGECKO_BASE_URL,
  COINGECKO_PRO_HEADER,
  COINGECKO_DEMO_HEADER,
} from '../src/lib/providers/coingeckoProvider.ts';

import { validateRatePayload, RateEngine, defaultRateEngine } from '../src/lib/rateEngine.ts';
import { mergeSourceDatasets } from '../src/lib/compositeRates.ts';
import { RateOrchestrator } from '../src/lib/rateOrchestrator.ts';
import { MockRateProvider, MOCK_DATASET_TIMESTAMP } from '../src/lib/providers/mockProvider.ts';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Sample response matching official CoinGecko /simple/price schema for all 5 coins */
const SAMPLE_COINGECKO_RESPONSE = {
  bitcoin: {
    usd: 65000.0,
    last_updated_at: 1783094934, // 2026-07-03T16:08:54Z
  },
  ethereum: {
    usd: 3500.0,
    last_updated_at: 1783094930, // 2026-07-03T16:08:50Z
  },
  solana: {
    usd: 150.0,
    last_updated_at: 1783094925, // 2026-07-03T16:08:45Z
  },
  ripple: {
    usd: 0.55,
    last_updated_at: 1783094920, // 2026-07-03T16:08:40Z
  },
  dogecoin: {
    usd: 0.12,
    last_updated_at: 1783094915, // 2026-07-03T16:08:35Z (oldest)
  },
};

/** Mock Response helper for custom fetch injection */
function createMockFetch(
  handler: (
    url: string,
    init?: RequestInit
  ) => { status: number; body: unknown; statusText?: string }
): typeof globalThis.fetch {
  return async (url, init) => {
    const { status, body, statusText = 'OK' } = handler(String(url), init);
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

describe('M2.4 — Normalization & USD-Base Mathematical Inversion', () => {
  it('should invert USD spot price into units-per-USD canonical rate', () => {
    const payload = normalizeCoinGeckoResponse({
      bitcoin: { usd: 65000.0, last_updated_at: 1783094934 },
    }, ['BTC']);

    assert.equal(payload.providerId, 'coingecko');
    assert.equal(payload.providerName, 'CoinGecko Crypto');
    assert.equal(payload.isMock, false);

    const rates = payload.rates as Record<string, string>;
    assert.equal(rates['USD'], '1');

    const expectedBtcRate = new Big(1).div(new Big('65000')).toFixed();
    assert.equal(rates['BTC'], expectedBtcRate);
    assert.equal(payload.timestamp, 1783094934000);
  });

  it('should normalize all 5 cryptocurrencies into a valid RawRatePayload with USD = 1', () => {
    const payload = normalizeCoinGeckoResponse(SAMPLE_COINGECKO_RESPONSE);

    assert.equal(payload.providerId, 'coingecko');
    assert.equal(payload.providerName, 'CoinGecko Crypto');
    assert.equal(payload.isMock, false);

    // Oldest timestamp across all 5 coins is dogecoin at 1783094915000
    assert.equal(payload.timestamp, 1783094915000);

    const rates = payload.rates as Record<string, string>;
    assert.equal(rates['USD'], '1');

    assert.ok(new Big(rates['BTC']).eq(new Big(1).div(65000)));
    assert.ok(new Big(rates['ETH']).eq(new Big(1).div(3500)));
    assert.ok(new Big(rates['SOL']).eq(new Big(1).div(150)));
    assert.ok(new Big(rates['XRP']).eq(new Big(1).div(0.55)));
    assert.ok(new Big(rates['DOGE']).eq(new Big(1).div(0.12)));
  });

  it('should pass strict validateRatePayload without errors', () => {
    const payload = normalizeCoinGeckoResponse(SAMPLE_COINGECKO_RESPONSE);
    const validation = validateRatePayload(payload);

    assert.equal(validation.valid, true);
    assert.equal(validation.errors.length, 0);
    assert.ok(validation.dataset);
    assert.equal(validation.dataset!.baseAsset, 'USD');
    assert.equal(validation.dataset!.rates.size, 6); // USD + 5 cryptos
  });

  it('should select the oldest (minimum) timestamp among contributing coins', () => {
    const customResponse = {
      bitcoin: { usd: 60000, last_updated_at: 1700005000 },
      ethereum: { usd: 3000, last_updated_at: 1700001000 }, // minimum
      solana: { usd: 100, last_updated_at: 1700009000 },
      ripple: { usd: 0.5, last_updated_at: 1700006000 },
      dogecoin: { usd: 0.1, last_updated_at: 1700008000 },
    };

    const payload = normalizeCoinGeckoResponse(customResponse);
    assert.equal(payload.timestamp, 1700001000000);
  });
});

describe('M2.4 — CoinGecko API Request & Authentication Headers', () => {
  it('should fetch all 5 coins in a single batch request with proper query parameters', async () => {
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;

    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch((url, init) => {
        capturedUrl = url;
        capturedHeaders = init?.headers;
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    const payload = await provider.getRates();
    assert.equal(payload.providerId, 'coingecko');

    // Verify query parameters
    assert.ok(capturedUrl.includes('/simple/price'));
    assert.ok(capturedUrl.includes('vs_currencies=usd'));
    assert.ok(capturedUrl.includes('include_last_updated_at=true'));
    assert.ok(capturedUrl.includes('bitcoin%2Cethereum%2Csolana%2Cripple%2Cdogecoin') ||
              capturedUrl.includes('bitcoin,ethereum,solana,ripple,dogecoin'));

    // Without apiKey, no auth header is present
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers[COINGECKO_DEMO_HEADER], undefined);
    assert.equal(headers[COINGECKO_PRO_HEADER], undefined);
  });

  it('should attach x-cg-demo-api-key when apiKey is provided with default public base URL', async () => {
    let capturedHeaders: HeadersInit | undefined;

    const provider = new CoinGeckoRateProvider({
      apiKey: 'demo-key-12345',
      fetch: createMockFetch((_, init) => {
        capturedHeaders = init?.headers;
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    await provider.getRates();
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers[COINGECKO_DEMO_HEADER], 'demo-key-12345');
    assert.equal(headers[COINGECKO_PRO_HEADER], undefined);
  });

  it('should attach x-cg-pro-api-key when pro base URL is configured with apiKey', async () => {
    let capturedHeaders: HeadersInit | undefined;

    const provider = new CoinGeckoRateProvider({
      baseUrl: PRO_COINGECKO_BASE_URL,
      apiKey: 'pro-key-67890',
      fetch: createMockFetch((_, init) => {
        capturedHeaders = init?.headers;
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    await provider.getRates();
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers[COINGECKO_PRO_HEADER], 'pro-key-67890');
    assert.equal(headers[COINGECKO_DEMO_HEADER], undefined);
  });

  it('should support explicit apiKeyHeader override', async () => {
    let capturedHeaders: HeadersInit | undefined;

    const provider = new CoinGeckoRateProvider({
      apiKey: 'custom-key-999',
      apiKeyHeader: 'x-custom-auth-header',
      fetch: createMockFetch((_, init) => {
        capturedHeaders = init?.headers;
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    await provider.getRates();
    const headers = capturedHeaders as Record<string, string>;
    assert.equal(headers['x-custom-auth-header'], 'custom-key-999');
  });

  it('should strip trailing slashes from custom baseUrl', async () => {
    let capturedUrl = '';

    const provider = new CoinGeckoRateProvider({
      baseUrl: 'https://custom-proxy.example.com/api///',
      fetch: createMockFetch((url) => {
        capturedUrl = url;
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    await provider.getRates();
    assert.ok(capturedUrl.startsWith('https://custom-proxy.example.com/api/simple/price'));
  });

  it('should support fetching a configured subset of crypto symbols', async () => {
    let capturedUrl = '';

    const provider = new CoinGeckoRateProvider({
      symbols: ['BTC', 'ETH'],
      fetch: createMockFetch((url) => {
        capturedUrl = url;
        return {
          status: 200,
          body: {
            bitcoin: SAMPLE_COINGECKO_RESPONSE.bitcoin,
            ethereum: SAMPLE_COINGECKO_RESPONSE.ethereum,
          },
        };
      }),
    });

    const payload = await provider.getRates();
    assert.ok(capturedUrl.includes('bitcoin') && capturedUrl.includes('ethereum'));
    assert.ok(!capturedUrl.includes('solana'));

    const rates = payload.rates as Record<string, string>;
    assert.ok(rates['BTC']);
    assert.ok(rates['ETH']);
    assert.equal(rates['SOL'], undefined);
  });
});

describe('M2.4 — Validation, Malformed Payloads & Invalid Rates', () => {
  it('should reject non-object or null root payload', () => {
    assert.throws(
      () => normalizeCoinGeckoResponse(null),
      /CoinGecko response is missing or malformed/
    );
    assert.throws(
      () => normalizeCoinGeckoResponse([]),
      /CoinGecko response is missing or malformed/
    );
    assert.throws(
      () => normalizeCoinGeckoResponse('string'),
      /CoinGecko response is missing or malformed/
    );
  });

  it('should reject zero price', () => {
    const invalid = {
      ...SAMPLE_COINGECKO_RESPONSE,
      bitcoin: { usd: 0, last_updated_at: 1783094934 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(invalid),
      /Non-positive price for 'BTC'/
    );
  });

  it('should reject negative price', () => {
    const invalid = {
      ...SAMPLE_COINGECKO_RESPONSE,
      ethereum: { usd: -3500, last_updated_at: 1783094930 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(invalid),
      /Non-positive price for 'ETH'/
    );
  });

  it('should reject NaN, Infinity, and non-numeric price', () => {
    const withNaN = {
      ...SAMPLE_COINGECKO_RESPONSE,
      solana: { usd: NaN, last_updated_at: 1783094925 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(withNaN),
      /Invalid or non-numeric price for 'SOL'/
    );

    const withInfinity = {
      ...SAMPLE_COINGECKO_RESPONSE,
      solana: { usd: Infinity, last_updated_at: 1783094925 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(withInfinity),
      /Invalid or non-numeric price for 'SOL'/
    );

    const withString = {
      ...SAMPLE_COINGECKO_RESPONSE,
      solana: { usd: 'not-a-number', last_updated_at: 1783094925 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(withString),
      /Invalid or non-numeric price for 'SOL'/
    );
  });

  it('should reject missing or invalid last_updated_at timestamp', () => {
    const missingTs = {
      ...SAMPLE_COINGECKO_RESPONSE,
      dogecoin: { usd: 0.12 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(missingTs),
      /missing valid last_updated_at timestamp/
    );

    const invalidTs = {
      ...SAMPLE_COINGECKO_RESPONSE,
      dogecoin: { usd: 0.12, last_updated_at: 'invalid' },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(invalidTs),
      /Failed to parse valid epoch timestamp/
    );

    const nonPositiveTs = {
      ...SAMPLE_COINGECKO_RESPONSE,
      dogecoin: { usd: 0.12, last_updated_at: 0 },
    };
    assert.throws(
      () => normalizeCoinGeckoResponse(nonPositiveTs),
      /Failed to parse valid epoch timestamp/
    );
  });

  it('should reject missing required coins under requireAll=true (default)', () => {
    const partial = {
      bitcoin: { usd: 65000, last_updated_at: 1783094934 },
      // ethereum missing
      solana: { usd: 150, last_updated_at: 1783094925 },
      ripple: { usd: 0.55, last_updated_at: 1783094920 },
      dogecoin: { usd: 0.12, last_updated_at: 1783094915 },
    };

    assert.throws(
      () => normalizeCoinGeckoResponse(partial),
      /missing required coin 'ETH'/
    );
  });
});

describe('M2.4 — Partial Responses & requireAll Option', () => {
  it('should reject partial failure by default (requireAll=true) in getRates()', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: {
          bitcoin: { usd: 65000, last_updated_at: 1783094934 },
          // Missing remaining coins
        },
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /missing required coin/);
        return true;
      }
    );
  });

  it('should allow partial payload when requireAll=false', async () => {
    const provider = new CoinGeckoRateProvider({
      requireAll: false,
      fetch: createMockFetch(() => ({
        status: 200,
        body: {
          bitcoin: { usd: 65000, last_updated_at: 1783094934 },
          ethereum: { usd: 3500, last_updated_at: 1783094920 }, // oldest contributing
          // solana, ripple, dogecoin missing
        },
      })),
    });

    const payload = await provider.getRates();
    const rates = payload.rates as Record<string, string>;

    assert.equal(rates['USD'], '1');
    assert.ok(rates['BTC']);
    assert.ok(rates['ETH']);
    assert.equal(rates['SOL'], undefined);
    assert.equal(rates['XRP'], undefined);
    assert.equal(rates['DOGE'], undefined);

    // Timestamp calculated only from the included coins (1783094920000)
    assert.equal(payload.timestamp, 1783094920000);
  });

  it('should throw CoinGeckoProviderError when all coins fail under requireAll=false', async () => {
    const provider = new CoinGeckoRateProvider({
      requireAll: false,
      fetch: createMockFetch(() => ({
        status: 200,
        body: {},
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /No valid cryptocurrency rates found/);
        return true;
      }
    );
  });
});

describe('M2.4 — HTTP Errors, Network Failures, and Timeouts', () => {
  it('should throw CoinGeckoProviderError on HTTP 401 Unauthorized', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 401,
        body: { error: 'Invalid API Key' },
        statusText: 'Unauthorized',
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /HTTP error: 401/);
        return true;
      }
    );
  });

  it('should throw CoinGeckoProviderError on HTTP 429 Rate Limit Exceeded', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 429,
        body: { error: 'Rate limit exceeded' },
        statusText: 'Too Many Requests',
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /HTTP error: 429/);
        return true;
      }
    );
  });

  it('should throw CoinGeckoProviderError on network failure', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /network request failed/);
        return true;
      }
    );
  });

  it('should handle request timeout cleanly without unhandled rejection', async () => {
    const provider = new CoinGeckoRateProvider({
      timeoutMs: 15,
      fetch: async (_url, init) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /timed out after 15ms/);
        return true;
      }
    );
  });

  it('should throw CoinGeckoProviderError on malformed JSON response', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: '__INVALID_JSON__',
      })),
    });

    await assert.rejects(
      async () => await provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinGeckoProviderError);
        assert.match(err.message, /Failed to parse CoinGecko JSON response/);
        return true;
      }
    );
  });

  it('should provide safe non-throwing getRatesSafe method', async () => {
    const failingProvider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 500,
        body: 'Server Error',
        statusText: 'Internal Server Error',
      })),
    });

    const failureResult = await failingProvider.getRatesSafe();
    assert.equal(failureResult.payload, null);
    assert.ok(failureResult.error instanceof CoinGeckoProviderError);

    const goodProvider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: SAMPLE_COINGECKO_RESPONSE,
      })),
    });

    const successResult = await goodProvider.getRatesSafe();
    assert.equal(successResult.error, null);
    assert.ok(successResult.payload);
  });
});

describe('M2.4 — RateEngine Integration & Fault Tolerance (LKG)', () => {
  it('should load CoinGecko rates asynchronously into RateEngine', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: SAMPLE_COINGECKO_RESPONSE,
      })),
    });

    const engine = new RateEngine(new MockRateProvider());
    const validation = await engine.loadFromProviderAsync(provider);

    assert.equal(validation.valid, true);
    assert.ok(engine.getRate('BTC').eq(new Big(1).div(65000)));
    assert.ok(engine.getRate('ETH').eq(new Big(1).div(3500)));
    assert.ok(engine.getRate('SOL').eq(new Big(1).div(150)));
    assert.ok(engine.getRate('XRP').eq(new Big(1).div(0.55)));
    assert.ok(engine.getRate('DOGE').eq(new Big(1).div(0.12)));
  });

  it('should retain last-known-good dataset when CoinGecko encounters an outage', async () => {
    let shouldFail = false;
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => {
        if (shouldFail) {
          return { status: 503, body: 'Unavailable', statusText: 'Service Unavailable' };
        }
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    const engine = new RateEngine(new MockRateProvider());

    // 1. Initial success establishes LKG
    await engine.loadFromProviderAsync(provider);
    assert.ok(engine.getRate('BTC').eq(new Big(1).div(65000)));

    // 2. Outage triggers graceful fallback
    shouldFail = true;
    const failedResult = await engine.loadFromProviderAsync(provider);

    assert.equal(failedResult.valid, false);
    assert.equal(engine.isAvailable(), true);
    assert.ok(engine.getRate('BTC').eq(new Big(1).div(65000)), 'LKG rate retained');
    assert.equal(engine.getStatus().isLastKnownGood, true);
  });
});

describe('M2.4 — Composite Assembly & Orchestrator Integration', () => {
  it('should merge CoinGecko crypto rates with fiat and metals into a multi-provider composite', async () => {
    const cryptoProvider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: SAMPLE_COINGECKO_RESPONSE,
      })),
    });

    const payload = await cryptoProvider.getRates();
    const validation = validateRatePayload(payload);
    assert.ok(validation.dataset);

    // Simulated fiat dataset (Frankfurter)
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

    // Simulated metals dataset (Gold API)
    const metalsDataset = {
      providerId: 'goldapi',
      providerName: 'Gold API',
      baseAsset: 'USD',
      timestamp: 1783090000000,
      rates: new Map([
        ['USD', new Big(1)],
        ['XAU', new Big('0.000416')],
        ['XAG', new Big('0.0357')],
      ]),
      isMock: false,
    };

    const composite = mergeSourceDatasets([
      { dataset: fiatDataset },
      { dataset: metalsDataset },
      { dataset: validation.dataset! },
    ]);

    assert.ok(composite.dataset);
    assert.equal(composite.contributingSources.length, 3);
    assert.ok(composite.contributingSources.includes('coingecko'));
    assert.ok(composite.contributingSources.includes('frankfurter'));
    assert.ok(composite.contributingSources.includes('goldapi'));

    // Provenance tracks CoinGecko for crypto
    const btcProv = composite.provenance.get('BTC')!;
    assert.equal(btcProv.sourceId, 'coingecko');
    assert.equal(btcProv.sourceName, 'CoinGecko Crypto');
    assert.equal(btcProv.timestamp, 1783094915000);

    // Provenance tracks Frankfurter for fiat
    const eurProv = composite.provenance.get('EUR')!;
    assert.equal(eurProv.sourceId, 'frankfurter');

    // Provenance tracks Gold API for metals
    const xauProv = composite.provenance.get('XAU')!;
    assert.equal(xauProv.sourceId, 'goldapi');
  });

  it('should register and refresh CoinGeckoRateProvider in RateOrchestrator', async () => {
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => ({
        status: 200,
        body: SAMPLE_COINGECKO_RESPONSE,
      })),
    });

    const orchestrator = new RateOrchestrator();
    orchestrator.registerProvider(provider);

    const result = await orchestrator.refreshAll();
    assert.equal(result.success, true);
    assert.equal(result.successfulRefreshes, 1);
    assert.ok(result.composite.dataset!.rates.has('BTC'));
    assert.ok(result.composite.dataset!.rates.has('ETH'));
    assert.ok(result.composite.dataset!.rates.has('SOL'));
    assert.ok(result.composite.dataset!.rates.has('XRP'));
    assert.ok(result.composite.dataset!.rates.has('DOGE'));
  });

  it('should retain all 5 crypto assets in LKG when a subsequent refresh fails', async () => {
    let shouldFail = false;
    const provider = new CoinGeckoRateProvider({
      fetch: createMockFetch(() => {
        if (shouldFail) {
          return { status: 500, body: 'Server Error', statusText: 'Internal Server Error' };
        }
        return { status: 200, body: SAMPLE_COINGECKO_RESPONSE };
      }),
    });

    const orchestrator = new RateOrchestrator();
    orchestrator.registerProvider(provider);

    // Initial full refresh succeeds with 5 crypto assets
    const initialResult = await orchestrator.refreshAll();
    assert.equal(initialResult.success, true);
    assert.ok(initialResult.composite.dataset!.rates.has('BTC'));
    assert.ok(initialResult.composite.dataset!.rates.has('DOGE'));

    // Second refresh encounters failure
    shouldFail = true;
    const secondResult = await orchestrator.refreshAll();
    assert.equal(secondResult.success, false);
    // LKG retains all 5 cryptos intact
    assert.ok(secondResult.composite.dataset!.rates.has('BTC'));
    assert.ok(secondResult.composite.dataset!.rates.has('ETH'));
    assert.ok(secondResult.composite.dataset!.rates.has('SOL'));
    assert.ok(secondResult.composite.dataset!.rates.has('XRP'));
    assert.ok(secondResult.composite.dataset!.rates.has('DOGE'));
  });
});

describe('M2.4 — Offline Safety & Zero Network Calls on Import', () => {
  it('should maintain defaultRateEngine on mock-local provider', () => {
    assert.equal(defaultRateEngine.getActiveProviderId(), 'mock-local');
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(defaultRateEngine.getStatus().timestamp, MOCK_DATASET_TIMESTAMP);
  });

  it('should instantiate CoinGeckoRateProvider with zero network requests', () => {
    let fetchCalled = false;
    const provider = new CoinGeckoRateProvider({
      fetch: async () => {
        fetchCalled = true;
        throw new Error('Should not be called during instantiation');
      },
    });

    assert.equal(fetchCalled, false, 'Instantiation must not trigger fetch');
    assert.equal(provider.id, 'coingecko');
    assert.equal(provider.name, 'CoinGecko Crypto');
    assert.equal(provider.isMock, false);
  });

  it('should use default public base URL when not specified', () => {
    assert.equal(DEFAULT_COINGECKO_BASE_URL, 'https://api.coingecko.com/api/v3');
    assert.equal(PRO_COINGECKO_BASE_URL, 'https://pro-api.coingecko.com/api/v3');
  });
});
