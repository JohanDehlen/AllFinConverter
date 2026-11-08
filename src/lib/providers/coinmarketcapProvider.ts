/**
 * AllFinConverter CoinMarketCap Crypto Rate Provider
 *
 * Implements the RateProvider interface for CoinMarketCap API
 * (https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest).
 * Fetches spot quotes for configured cryptocurrencies (BTC, ETH, SOL, XRP, DOGE) in a single
 * batch request and normalizes them into canonical USD-base reciprocal rates (1 USD = 1/P units of crypto).
 *
 * Authentication & Configuration:
 * - Requires a valid CoinMarketCap API key passed via options or environment variable COINMARKETCAP_API_KEY.
 * - Header: 'X-CMC_PRO_API_KEY'.
 * - If API key is missing or empty, throws a clear CoinMarketCapProviderError.
 *
 * Rate Normalization Convention:
 * - AllFinConverter rates are normalized to USD base: 1 USD = R asset units.
 * - CoinMarketCap provides spot price P in USD per coin (e.g. P = 65000 USD / BTC).
 * - Therefore, the normalized rate R (units of crypto per 1 USD) is: R = 1 / P.
 * - Base currency USD is explicitly injected with rate '1'.
 * - Timestamps are ISO-8601 strings, parsed to epoch milliseconds UTC.
 * - Dataset timestamp is the minimum (oldest) timestamp among contributing coins,
 *   guaranteeing that no older rate can ever appear newer.
 *
 * Attribution:
 * - “Data provided by CoinMarketCap.com” linked to https://coinmarketcap.com/
 */

import Big from 'big.js';
import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';
import { retryFetch } from './retryFetch.ts';

/**
 * Default base URL for CoinMarketCap Pro API.
 */
export const DEFAULT_COINMARKETCAP_BASE_URL = 'https://pro-api.coinmarketcap.com/v1';

/**
 * Canonical cryptocurrency asset codes supported by AllFinConverter.
 */
export const CMC_SUPPORTED_CRYPTO = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;

export type SupportedCmcCryptoCode = (typeof CMC_SUPPORTED_CRYPTO)[number];

const SUPPORTED_CRYPTO_SET: ReadonlySet<string> = new Set(CMC_SUPPORTED_CRYPTO);

/**
 * Custom error class for CoinMarketCap provider failures (missing key, network, HTTP, parsing, validation).
 */
export class CoinMarketCapProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CoinMarketCapProviderError';
    this.cause = cause;
  }
}

/**
 * Configuration options for CoinMarketCapRateProvider.
 */
export interface CoinMarketCapProviderOptions {
  /** Optional API key for CoinMarketCap. Defaults to process.env.COINMARKETCAP_API_KEY if available. */
  readonly apiKey?: string;
  /** Base URL for CoinMarketCap API. Defaults to DEFAULT_COINMARKETCAP_BASE_URL. */
  readonly baseUrl?: string;
  /** Custom fetch implementation for testing or non-standard runtimes. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Defaults to 10,000ms. */
  readonly timeoutMs?: number;
  /** Crypto symbols to retrieve. Defaults to CMC_SUPPORTED_CRYPTO. */
  readonly symbols?: readonly SupportedCmcCryptoCode[];
  /**
   * If true (default), requires all requested crypto symbols to succeed.
   * If any requested coin is missing or invalid, getRates() throws CoinMarketCapProviderError
   * so that RateOrchestrator and snapshot generation preserve complete data.
   */
  readonly requireAll?: boolean;
}

/**
 * Normalizes a raw JSON response from CoinMarketCap /cryptocurrency/quotes/latest into a canonical RawRatePayload.
 *
 * Rules:
 * - Base asset USD is injected with rate '1'.
 * - Coin prices are inverted into canonical USD-base rates: R = 1 / P.
 * - Dates are converted to epoch milliseconds.
 * - Dataset timestamp is the oldest (earliest) timestamp among contributing coins.
 * - If requireAll is true, any missing coin, invalid price, or missing timestamp throws CoinMarketCapProviderError.
 */
export function normalizeCoinMarketCapResponse(
  rawJson: unknown,
  symbols: readonly SupportedCmcCryptoCode[] = CMC_SUPPORTED_CRYPTO,
  requireAll = true,
  providerId = 'coinmarketcap',
  providerName = 'CoinMarketCap'
): RawRatePayload {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new CoinMarketCapProviderError(
      'CoinMarketCap response is missing or malformed (expected an object).'
    );
  }

  const root = rawJson as Record<string, unknown>;

  // Check API status block for errors
  if (root.status && typeof root.status === 'object') {
    const statusObj = root.status as Record<string, unknown>;
    const errorCode = statusObj.error_code;
    if (typeof errorCode === 'number' && errorCode !== 0) {
      const errorMsg = typeof statusObj.error_message === 'string' ? statusObj.error_message : `Error code ${errorCode}`;
      throw new CoinMarketCapProviderError(`CoinMarketCap API error: ${errorMsg}`);
    }
  }

  if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) {
    throw new CoinMarketCapProviderError('CoinMarketCap response missing valid "data" property.');
  }

  const data = root.data as Record<string, unknown>;
  const rates: Record<string, string> = {
    USD: '1',
  };

  let oldestTimestamp = Infinity;
  let validCoinCount = 0;

  for (const symbol of symbols) {
    if (!SUPPORTED_CRYPTO_SET.has(symbol)) {
      if (requireAll) {
        throw new CoinMarketCapProviderError(`Unsupported cryptocurrency symbol: '${symbol}'`);
      }
      continue;
    }

    const rawCoin = data[symbol];
    if (!rawCoin) {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `CoinMarketCap response missing required coin '${symbol}'.`
        );
      }
      continue;
    }

    // Handle single object or array (if duplicate listings existed)
    const coinObj = Array.isArray(rawCoin) ? rawCoin[0] : rawCoin;
    if (!coinObj || typeof coinObj !== 'object') {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `CoinMarketCap response has invalid format for coin '${symbol}'.`
        );
      }
      continue;
    }

    const quoteObj = (coinObj as Record<string, unknown>).quote;
    if (!quoteObj || typeof quoteObj !== 'object') {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `CoinMarketCap response missing quote block for '${symbol}'.`
        );
      }
      continue;
    }

    const usdQuote = (quoteObj as Record<string, unknown>).USD;
    if (!usdQuote || typeof usdQuote !== 'object') {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `CoinMarketCap response missing USD quote for '${symbol}'.`
        );
      }
      continue;
    }

    const priceRaw = (usdQuote as Record<string, unknown>).price;

    // 1. Price extraction and validation
    let bigPrice: Big;
    try {
      if (typeof priceRaw === 'number') {
        if (!Number.isFinite(priceRaw) || Number.isNaN(priceRaw)) {
          throw new Error('Price is NaN or Infinity');
        }
        bigPrice = new Big(priceRaw);
      } else if (typeof priceRaw === 'string' && priceRaw.trim() !== '') {
        bigPrice = new Big(priceRaw.trim());
      } else {
        throw new Error(`Invalid price type: ${typeof priceRaw}`);
      }
    } catch (err) {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `Invalid or non-numeric price for '${symbol}': '${String(priceRaw)}'`,
          err
        );
      }
      continue;
    }

    if (bigPrice.lte(0)) {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `Non-positive price for '${symbol}': ${bigPrice.toFixed()} (must be strictly positive).`
        );
      }
      continue;
    }

    // Rate normalization: 1 USD = (1 / price) crypto units
    const normalizedRate = new Big(1).div(bigPrice).toFixed();

    // 2. Timestamp extraction (ISO string or unix timestamp)
    const lastUpdatedRaw =
      (usdQuote as Record<string, unknown>).last_updated ||
      (coinObj as Record<string, unknown>).last_updated ||
      (root.status && (root.status as Record<string, unknown>).timestamp);

    let tsNum: number;
    if (typeof lastUpdatedRaw === 'string' && lastUpdatedRaw.trim() !== '') {
      tsNum = Date.parse(lastUpdatedRaw.trim());
    } else if (typeof lastUpdatedRaw === 'number' && Number.isFinite(lastUpdatedRaw)) {
      // If seconds or ms
      tsNum = lastUpdatedRaw < 1e11 ? lastUpdatedRaw * 1000 : lastUpdatedRaw;
    } else {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `CoinMarketCap response for '${symbol}' missing valid last_updated timestamp.`
        );
      }
      continue;
    }

    if (!Number.isFinite(tsNum) || Number.isNaN(tsNum) || tsNum <= 0) {
      if (requireAll) {
        throw new CoinMarketCapProviderError(
          `Failed to parse valid epoch timestamp for '${symbol}': '${String(lastUpdatedRaw)}'.`
        );
      }
      continue;
    }

    rates[symbol] = normalizedRate;
    if (tsNum < oldestTimestamp) {
      oldestTimestamp = tsNum;
    }
    validCoinCount++;
  }

  if (validCoinCount === 0 || !Number.isFinite(oldestTimestamp)) {
    throw new CoinMarketCapProviderError(
      'No valid cryptocurrency rates found in CoinMarketCap response.'
    );
  }

  return {
    providerId,
    providerName,
    timestamp: oldestTimestamp,
    isMock: false,
    rates,
  };
}

/**
 * RateProvider adapter for CoinMarketCap Pro API.
 * Fetches spot quotes for cryptocurrency assets in a single batch request and normalizes them to USD base.
 */
export class CoinMarketCapRateProvider implements RateProvider {
  readonly id = 'coinmarketcap';
  readonly name = 'CoinMarketCap';
  readonly isMock = false;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly symbols: readonly SupportedCmcCryptoCode[];
  private readonly requireAll: boolean;

  constructor(options?: CoinMarketCapProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_COINMARKETCAP_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options?.apiKey?.trim() || (typeof process !== 'undefined' ? process.env?.COINMARKETCAP_API_KEY?.trim() : undefined);
    this.fetchFn = options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.symbols = options?.symbols ?? CMC_SUPPORTED_CRYPTO;
    this.requireAll = options?.requireAll ?? true;
  }

  /**
   * Fetches latest spot quotes from CoinMarketCap and normalizes to USD base.
   * Throws CoinMarketCapProviderError on missing key, network failure, timeout, HTTP error, or missing/invalid rates.
   */
  async getRates(): Promise<RawRatePayload> {
    if (!this.apiKey) {
      throw new CoinMarketCapProviderError(
        'CoinMarketCap API key is missing. Set the COINMARKETCAP_API_KEY environment variable.'
      );
    }

    const symbolsParam = this.symbols.join(',');
    const url = `${this.baseUrl}/cryptocurrency/quotes/latest?symbol=${symbolsParam}&convert=USD`;

    let response: Response;
    let bodyText: string;
    try {
      ({ response, bodyText } = await retryFetch(
        this.fetchFn,
        url,
        {
          method: 'GET',
          headers: {
            'X-CMC_PRO_API_KEY': this.apiKey,
            'Accept': 'application/json',
          },
        },
        this.timeoutMs
      ));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CoinMarketCapProviderError(
          `CoinMarketCap request timed out after ${this.timeoutMs}ms.`,
          err
        );
      }
      throw new CoinMarketCapProviderError(
        `CoinMarketCap network request failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    if (!response.ok) {
      let errorDetail = `${response.status} ${response.statusText}`.trim();
      try {
        const errorJson = JSON.parse(bodyText) as Record<string, unknown>;
        if (errorJson?.status && typeof errorJson.status === 'object') {
          const statusObj = errorJson.status as Record<string, unknown>;
          if (typeof statusObj.error_message === 'string') {
            errorDetail += ` - ${statusObj.error_message}`;
          }
        }
      } catch {
        // Keep response statusText
      }
      throw new CoinMarketCapProviderError(`CoinMarketCap HTTP error: ${errorDetail}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch (err) {
      throw new CoinMarketCapProviderError(
        `Failed to parse CoinMarketCap JSON response: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    return normalizeCoinMarketCapResponse(
      json,
      this.symbols,
      this.requireAll,
      this.id,
      this.name
    );
  }

  /**
   * Safe non-throwing wrapper.
   */
  async getRatesSafe(): Promise<{ payload: RawRatePayload | null; error: CoinMarketCapProviderError | null }> {
    try {
      const payload = await this.getRates();
      return { payload, error: null };
    } catch (err) {
      const error =
        err instanceof CoinMarketCapProviderError
          ? err
          : new CoinMarketCapProviderError(err instanceof Error ? err.message : String(err), err);
      return { payload: null, error };
    }
  }
}
