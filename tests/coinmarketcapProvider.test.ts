/**
 * Automated Test Suite for CoinMarketCap Rate Provider Adapter
 *
 * Verifies:
 * 1. normalizeCoinMarketCapResponse parses all 5 crypto assets (BTC, ETH, SOL, XRP, DOGE)
 * 2. Exact reciprocal rate normalization: 1 USD = 1/P crypto units
 * 3. Base USD rate = 1 injection
 * 4. Oldest timestamp selection among contributing coins
 * 5. Error code handling (status.error_code !== 0 throws CoinMarketCapProviderError)
 * 6. Missing API key detection (throws clearly without contacting network)
 * 7. Injected fetch handling for HTTP 401, 403, 429, 500, timeouts, and network failures
 * 8. requireAll: true throws on missing coin; requireAll: false allows partial
 * 9. Offline invariant: zero network requests during instantiation
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  CoinMarketCapRateProvider,
  CoinMarketCapProviderError,
  normalizeCoinMarketCapResponse,
  CMC_SUPPORTED_CRYPTO,
} from '../src/lib/providers/coinmarketcapProvider.ts';

import { validateRatePayload } from '../src/lib/rateEngine.ts';

/** Mock standard CMC response fixture covering all 5 canonical crypto assets */
const MOCK_CMC_RESPONSE = {
  status: {
    timestamp: '2026-10-28T14:30:00.000Z',
    error_code: 0,
    error_message: null,
    elapsed: 10,
    credit_count: 1,
  },
  data: {
    BTC: {
      id: 1,
      name: 'Bitcoin',
      symbol: 'BTC',
      last_updated: '2026-10-28T14:29:50.000Z',
      quote: {
        USD: {
          price: 65000.0,
          last_updated: '2026-10-28T14:29:50.000Z',
        },
      },
    },
    ETH: {
      id: 1027,
      name: 'Ethereum',
      symbol: 'ETH',
      last_updated: '2026-10-28T14:29:40.000Z',
      quote: {
        USD: {
          price: 3500.0,
          last_updated: '2026-10-28T14:29:40.000Z',
        },
      },
    },
    SOL: {
      id: 5426,
      name: 'Solana',
      symbol: 'SOL',
      last_updated: '2026-10-28T14:29:30.000Z', // oldest timestamp
      quote: {
        USD: {
          price: 150.0,
          last_updated: '2026-10-28T14:29:30.000Z',
        },
      },
    },
    XRP: {
      id: 52,
      name: 'XRP',
      symbol: 'XRP',
      last_updated: '2026-10-28T14:29:45.000Z',
      quote: {
        USD: {
          price: 0.55,
          last_updated: '2026-10-28T14:29:45.000Z',
        },
      },
    },
    DOGE: {
      id: 74,
      name: 'Dogecoin',
      symbol: 'DOGE',
      last_updated: '2026-10-28T14:29:55.000Z',
      quote: {
        USD: {
          price: 0.12,
          last_updated: '2026-10-28T14:29:55.000Z',
        },
      },
    },
  },
};

function createStalledBodyResponse(signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('The operation was aborted', 'AbortError')),
        { once: true }
      );
    },
  });
  return new Response(body, { status: 200 });
}

describe('CoinMarketCapRateProvider & Normalization', () => {
  it('should normalize a standard CoinMarketCap response successfully', () => {
    const payload = normalizeCoinMarketCapResponse(MOCK_CMC_RESPONSE);

    assert.equal(payload.providerId, 'coinmarketcap');
    assert.equal(payload.providerName, 'CoinMarketCap');
    assert.equal(payload.isMock, false);
    assert.equal(payload.rates['USD'], '1');

    // Expected reciprocal rates (1 / price)
    const expectedBtcRate = new Big(1).div(65000).toFixed();
    const expectedEthRate = new Big(1).div(3500).toFixed();
    const expectedSolRate = new Big(1).div(150).toFixed();
    const expectedXrpRate = new Big(1).div(0.55).toFixed();
    const expectedDogeRate = new Big(1).div(0.12).toFixed();

    assert.equal(payload.rates['BTC'], expectedBtcRate);
    assert.equal(payload.rates['ETH'], expectedEthRate);
    assert.equal(payload.rates['SOL'], expectedSolRate);
    assert.equal(payload.rates['XRP'], expectedXrpRate);
    assert.equal(payload.rates['DOGE'], expectedDogeRate);

    // Oldest timestamp (SOL: 14:29:30.000Z)
    const expectedTimestamp = Date.parse('2026-10-28T14:29:30.000Z');
    assert.equal(payload.timestamp, expectedTimestamp);

    // Payload passes rate engine validation
    const validation = validateRatePayload(payload);
    assert.equal(validation.valid, true);
  });

  it('should throw CoinMarketCapProviderError if status.error_code !== 0', () => {
    const errorResponse = {
      status: {
        timestamp: '2026-10-28T14:30:00.000Z',
        error_code: 1001,
        error_message: 'This API Key is invalid.',
      },
      data: {},
    };

    assert.throws(
      () => normalizeCoinMarketCapResponse(errorResponse),
      (err: unknown) => {
        assert.ok(err instanceof CoinMarketCapProviderError);
        assert.match((err as Error).message, /This API Key is invalid/);
        return true;
      }
    );
  });

  it('should throw if missing a required coin when requireAll is true', () => {
    const partialResponse = {
      status: { error_code: 0 },
      data: {
        BTC: MOCK_CMC_RESPONSE.data.BTC,
        ETH: MOCK_CMC_RESPONSE.data.ETH,
        // SOL, XRP, DOGE omitted
      },
    };

    assert.throws(
      () => normalizeCoinMarketCapResponse(partialResponse, CMC_SUPPORTED_CRYPTO, true),
      (err: unknown) => {
        assert.ok(err instanceof CoinMarketCapProviderError);
        assert.match((err as Error).message, /missing required coin 'SOL'/);
        return true;
      }
    );
  });

  it('should accept partial coins when requireAll is false', () => {
    const partialResponse = {
      status: { error_code: 0 },
      data: {
        BTC: MOCK_CMC_RESPONSE.data.BTC,
        ETH: MOCK_CMC_RESPONSE.data.ETH,
      },
    };

    const payload = normalizeCoinMarketCapResponse(partialResponse, CMC_SUPPORTED_CRYPTO, false);
    assert.ok(payload.rates['BTC']);
    assert.ok(payload.rates['ETH']);
    assert.equal(payload.rates['SOL'], undefined);
  });

  it('should reject non-positive or non-numeric prices', () => {
    const badPriceResponse = {
      status: { error_code: 0 },
      data: {
        BTC: {
          symbol: 'BTC',
          quote: { USD: { price: -500, last_updated: '2026-10-28T14:00:00Z' } },
        },
      },
    };

    assert.throws(
      () => normalizeCoinMarketCapResponse(badPriceResponse, ['BTC'], true),
      /Non-positive price for 'BTC'/
    );
  });

  it('should throw immediately if API key is missing', async () => {
    const provider = new CoinMarketCapRateProvider({ apiKey: '' });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinMarketCapProviderError);
        assert.match((err as Error).message, /CoinMarketCap API key is missing/);
        return true;
      }
    );
  });

  it('should query API via injected fetch with X-CMC_PRO_API_KEY header', async () => {
    let capturedUrl = '';
    let capturedHeader = '';

    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      const headers = init?.headers as Record<string, string>;
      capturedHeader = headers?.['X-CMC_PRO_API_KEY'] || '';

      return new Response(JSON.stringify(MOCK_CMC_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-cmc-key-12345',
      fetch: mockFetch,
    });

    const payload = await provider.getRates();
    assert.ok(capturedUrl.includes('cryptocurrency/quotes/latest'));
    assert.ok(capturedUrl.includes('symbol=BTC,ETH,SOL,XRP,DOGE'));
    assert.equal(capturedHeader, 'test-cmc-key-12345');
    assert.ok(payload.rates['BTC']);
  });

  it('should recover from HTTP 429', async () => {
    let attempts = 0;
    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      fetch: async () => {
        attempts++;
        if (attempts === 1) return new Response('Rate limited', { status: 429 });
        return new Response(JSON.stringify(MOCK_CMC_RESPONSE), { status: 200 });
      },
    });

    const payload = await provider.getRates();
    assert.equal(attempts, 2);
    assert.ok(payload.rates['BTC']);
  });

  it('should stop after three transient network failures', async () => {
    let attempts = 0;
    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      fetch: async () => {
        attempts++;
        const error = new TypeError('fetch failed');
        Object.defineProperty(error, 'cause', { value: { code: 'ECONNRESET' } });
        throw error;
      },
    });

    await assert.rejects(() => provider.getRates(), /network request failed/);
    assert.equal(attempts, 3);
  });

  it('should not retry unrelated programming errors', async () => {
    let attempts = 0;
    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      fetch: async () => {
        attempts++;
        throw new Error('programming error');
      },
    });

    await assert.rejects(() => provider.getRates(), /programming error/);
    assert.equal(attempts, 1);
  });

  it('should cancel a retryable HTTP response body before retrying', async () => {
    let attempts = 0;
    let cancellations = 0;
    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
            },
          }), { status: 503 });
        }
        return new Response(JSON.stringify(MOCK_CMC_RESPONSE), { status: 200 });
      },
    });

    await provider.getRates();
    assert.equal(attempts, 2);
    assert.equal(cancellations, 1);
  });

  it('should retry a timeout while downloading the response body', async () => {
    let attempts = 0;
    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      timeoutMs: 15,
      fetch: async (_url, init) => {
        attempts++;
        if (attempts === 1) return createStalledBodyResponse(init?.signal);
        return new Response(JSON.stringify(MOCK_CMC_RESPONSE), { status: 200 });
      },
    });

    const payload = await provider.getRates();
    assert.equal(attempts, 2);
    assert.ok(payload.rates['BTC']);
  });

  it('should handle HTTP 401 error with informative error', async () => {
    let attempts = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      attempts++;
      return new Response(
        JSON.stringify({
          status: { error_code: 1001, error_message: 'Invalid API Key' },
        }),
        { status: 401, statusText: 'Unauthorized' }
      );
    };

    const provider = new CoinMarketCapRateProvider({
      apiKey: 'bad-key',
      fetch: mockFetch,
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinMarketCapProviderError);
        assert.match((err as Error).message, /401/);
        return true;
      }
    );
    assert.equal(attempts, 1);
  });

  it('should not retry invalid response data', async () => {
    let attempts = 0;
    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      fetch: async () => {
        attempts++;
        return new Response(JSON.stringify({ status: { error_code: 0 }, data: {} }), {
          status: 200,
        });
      },
    });

    await assert.rejects(() => provider.getRates(), /missing required coin/);
    assert.equal(attempts, 1);
  });

  it('should handle network timeout safely', async () => {
    let attempts = 0;
    const mockFetch: typeof globalThis.fetch = async (url, init) => {
      attempts++;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };

    const provider = new CoinMarketCapRateProvider({
      apiKey: 'test-key',
      fetch: mockFetch,
      timeoutMs: 30,
    });

    await assert.rejects(
      () => provider.getRates(),
      (err: unknown) => {
        assert.ok(err instanceof CoinMarketCapProviderError);
        assert.match((err as Error).message, /timed out/);
        return true;
      }
    );
    assert.equal(attempts, 3);
  });

  it('should instantiate CoinMarketCapRateProvider with zero network requests', () => {
    let called = false;
    new CoinMarketCapRateProvider({
      apiKey: 'key',
      fetch: async () => {
        called = true;
        throw new Error('Network prohibited on instantiation');
      },
    });
    assert.equal(called, false);
  });
});
