/**
 * AllFinConverter CoinGecko Crypto Rate Provider
 *
 * Implements the RateProvider interface for CoinGecko API (https://api.coingecko.com or https://pro-api.coingecko.com).
 * Fetches real-time spot prices for cryptocurrencies (BTC, ETH, SOL, XRP, DOGE) in a single batch request
 * and normalizes them into canonical USD-base reciprocal rates (1 USD = 1/P units of crypto).
 *
 * API reference (from official CoinGecko /simple/price documentation):
 * - Endpoint: GET /simple/price?ids={ids}&vs_currencies=usd&include_last_updated_at=true
 * - Response schema:
 *   {
 *     "bitcoin": { "usd": 65000.5, "last_updated_at": 1719876543 },
 *     "ethereum": { "usd": 3500.25, "last_updated_at": 1719876540 },
 *     ...
 *   }
 *
 * Rate Normalization Convention:
 * - AllFinConverter rates are normalized to USD base: 1 USD = R asset units.
 * - CoinGecko provides spot price P in USD per coin (e.g. P = 65000 USD / BTC).
 * - Therefore, the normalized rate R (units of crypto per 1 USD) is: R = 1 / P.
 * - Base currency USD is explicitly injected with rate '1'.
 * - CoinGecko timestamps are in UNIX seconds; converted to epoch milliseconds (ts * 1000).
 * - Dataset timestamp is the minimum (oldest) timestamp among contributing coins,
 *   guaranteeing that no older rate can ever appear newer.
 */

import Big from 'big.js';
import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';

/**
 * Default base URL for CoinGecko Public/Demo API.
 */
export const DEFAULT_COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

/**
 * Base URL for CoinGecko Pro/Paid API (including Basic plan).
 */
export const PRO_COINGECKO_BASE_URL = 'https://pro-api.coingecko.com/api/v3';

/**
 * Standard CoinGecko authentication header names.
 */
export const COINGECKO_PRO_HEADER = 'x-cg-pro-api-key';
export const COINGECKO_DEMO_HEADER = 'x-cg-demo-api-key';

/**
 * Canonical cryptocurrency asset codes supported by AllFinConverter.
 */
export const COINGECKO_SUPPORTED_CRYPTO = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] as const;

export type SupportedCryptoCode = (typeof COINGECKO_SUPPORTED_CRYPTO)[number];

/**
 * Mapping between AllFinConverter asset codes and CoinGecko coin IDs.
 */
export const CRYPTO_TO_COINGECKO_ID: Readonly<Record<SupportedCryptoCode, string>> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  DOGE: 'dogecoin',
};

export const COINGECKO_ID_TO_CRYPTO: Readonly<Record<string, SupportedCryptoCode>> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  ripple: 'XRP',
  dogecoin: 'DOGE',
};

/**
 * Custom error class for CoinGecko provider failures (network, HTTP, parsing, validation).
 */
export class CoinGeckoProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CoinGeckoProviderError';
    this.cause = cause;
  }
}

/**
 * Configuration options for CoinGeckoRateProvider.
 */
export interface CoinGeckoProviderOptions {
  /** Base URL for CoinGecko API. Defaults to DEFAULT_COINGECKO_BASE_URL. */
  readonly baseUrl?: string;
  /** Optional API key for CoinGecko. Never hard-code credentials. */
  readonly apiKey?: string;
  /**
   * Header name to use when apiKey is provided.
   * If omitted:
   * - Defaults to 'x-cg-pro-api-key' when baseUrl contains 'pro-api.coingecko.com'.
   * - Defaults to 'x-cg-demo-api-key' otherwise.
   * Supports any custom string header.
   */
  readonly apiKeyHeader?: string;
  /** Custom fetch implementation for testing or non-standard runtimes. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Defaults to 10,000ms. */
  readonly timeoutMs?: number;
  /** Crypto symbols to retrieve. Defaults to COINGECKO_SUPPORTED_CRYPTO. */
  readonly symbols?: readonly SupportedCryptoCode[];
  /**
   * If true (default), requires all requested crypto symbols to succeed.
   * If any requested coin is missing or invalid, getRates() throws CoinGeckoProviderError
   * so that RateOrchestrator and RateEngine preserve their complete last-known-good dataset.
   * If false, allows partial batches containing only the valid coins.
   */
  readonly requireAll?: boolean;
}

/**
 * Normalizes a raw JSON response from CoinGecko's /simple/price endpoint into a canonical RawRatePayload.
 *
 * Rules:
 * - Base asset USD is injected with rate '1'.
 * - Coin prices are inverted into canonical USD-base rates: R = 1 / P.
 * - UNIX second timestamps are converted to milliseconds (sec * 1000).
 * - Dataset timestamp is the oldest (earliest) timestamp among contributing coins,
 *   guaranteeing that no older rate can ever appear newer.
 * - If requireAll is true, any missing coin, invalid price, or missing timestamp throws CoinGeckoProviderError.
 * - If requireAll is false, partial responses are accepted as long as at least one valid coin is extracted.
 */
export function normalizeCoinGeckoResponse(
  rawJson: unknown,
  symbols: readonly SupportedCryptoCode[] = COINGECKO_SUPPORTED_CRYPTO,
  requireAll = true,
  providerId = 'coingecko',
  providerName = 'CoinGecko Crypto'
): RawRatePayload {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new CoinGeckoProviderError(
      'CoinGecko response is missing or malformed (expected an object).'
    );
  }

  const data = rawJson as Record<string, unknown>;
  const rates: Record<string, string> = {
    USD: '1',
  };

  let oldestTimestamp = Infinity;
  let validCoinCount = 0;

  for (const symbol of symbols) {
    const coinId = CRYPTO_TO_COINGECKO_ID[symbol];
    if (!coinId) {
      if (requireAll) {
        throw new CoinGeckoProviderError(`Unsupported cryptocurrency symbol: '${symbol}'`);
      }
      continue;
    }

    const coinDataRaw = data[coinId];
    if (!coinDataRaw || typeof coinDataRaw !== 'object' || Array.isArray(coinDataRaw)) {
      if (requireAll) {
        throw new CoinGeckoProviderError(
          `CoinGecko response missing required coin '${symbol}' (${coinId}).`
        );
      }
      continue;
    }

    const coinData = coinDataRaw as Record<string, unknown>;

    // 1. Price extraction and validation
    let bigPrice: Big;
    try {
      if (typeof coinData.usd === 'number') {
        if (!Number.isFinite(coinData.usd) || Number.isNaN(coinData.usd)) {
          throw new Error('Price is NaN or Infinity');
        }
        bigPrice = new Big(coinData.usd);
      } else if (typeof coinData.usd === 'string' && coinData.usd.trim() !== '') {
        bigPrice = new Big(coinData.usd.trim());
      } else {
        throw new Error(`Invalid price type: ${typeof coinData.usd}`);
      }
    } catch (err) {
      if (requireAll) {
        throw new CoinGeckoProviderError(
          `Invalid or non-numeric price for '${symbol}': '${String(coinData.usd)}'`,
          err
        );
      }
      continue;
    }

    if (bigPrice.lte(0)) {
      if (requireAll) {
        throw new CoinGeckoProviderError(
          `Non-positive price for '${symbol}': ${bigPrice.toFixed()} (must be strictly positive).`
        );
      }
      continue;
    }

    // Rate normalization: 1 USD = (1 / price) crypto units
    const normalizedRate = new Big(1).div(bigPrice).toFixed();

    // 2. Timestamp extraction (UNIX seconds -> epoch milliseconds)
    let tsNum: number;
    if (typeof coinData.last_updated_at === 'number') {
      tsNum = coinData.last_updated_at;
    } else if (
      typeof coinData.last_updated_at === 'string' &&
      coinData.last_updated_at.trim() !== ''
    ) {
      tsNum = Number(coinData.last_updated_at.trim());
    } else {
      if (requireAll) {
        throw new CoinGeckoProviderError(
          `CoinGecko response for '${symbol}' missing valid last_updated_at timestamp.`
        );
      }
      continue;
    }

    if (!Number.isFinite(tsNum) || Number.isNaN(tsNum) || tsNum <= 0) {
      if (requireAll) {
        throw new CoinGeckoProviderError(
          `Failed to parse valid epoch timestamp from last_updated_at for '${symbol}': '${String(coinData.last_updated_at)}'.`
        );
      }
      continue;
    }

    const timestampMs = Math.floor(tsNum * 1000);

    rates[symbol] = normalizedRate;
    if (timestampMs < oldestTimestamp) {
      oldestTimestamp = timestampMs;
    }
    validCoinCount++;
  }

  if (validCoinCount === 0 || !Number.isFinite(oldestTimestamp)) {
    throw new CoinGeckoProviderError(
      'No valid cryptocurrency rates found in CoinGecko response.'
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
 * RateProvider adapter for CoinGecko API.
 * Fetches spot prices for cryptocurrency assets in a single batch request and normalizes them to USD base.
 */
export class CoinGeckoRateProvider implements RateProvider {
  readonly id = 'coingecko';
  readonly name = 'CoinGecko Crypto';
  readonly isMock = false;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyHeader?: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly symbols: readonly SupportedCryptoCode[];
  private readonly requireAll: boolean;

  constructor(options?: CoinGeckoProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_COINGECKO_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options?.apiKey?.trim() || undefined;
    this.apiKeyHeader = options?.apiKeyHeader?.trim() || undefined;
    this.fetchFn = options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.symbols = options?.symbols ?? COINGECKO_SUPPORTED_CRYPTO;
    this.requireAll = options?.requireAll ?? true;
  }

  /**
   * Fetches latest spot prices for all configured crypto assets and normalizes to USD base.
   * Throws CoinGeckoProviderError on network failure, timeout, HTTP error, or if required rates are missing/invalid.
   */
  async getRates(): Promise<RawRatePayload> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const ids = this.symbols.map((sym) => {
        const id = CRYPTO_TO_COINGECKO_ID[sym];
        if (!id) {
          throw new CoinGeckoProviderError(`Unsupported crypto symbol: '${sym}'`);
        }
        return id;
      });

      const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_last_updated_at=true`;

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };

      if (this.apiKey) {
        const defaultHeader = this.baseUrl.includes('pro-api.coingecko.com')
          ? COINGECKO_PRO_HEADER
          : COINGECKO_DEMO_HEADER;
        const headerName = this.apiKeyHeader ?? defaultHeader;
        headers[headerName] = this.apiKey;
      }

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          signal: controller.signal,
          headers,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new CoinGeckoProviderError(
            `CoinGecko request timed out after ${this.timeoutMs}ms.`,
            err
          );
        }
        throw new CoinGeckoProviderError(
          `CoinGecko network request failed: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      if (!response.ok) {
        throw new CoinGeckoProviderError(
          `CoinGecko HTTP error: ${response.status} ${response.statusText}`.trim()
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw new CoinGeckoProviderError(
          `Failed to parse CoinGecko JSON response: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      return normalizeCoinGeckoResponse(
        json,
        this.symbols,
        this.requireAll,
        this.id,
        this.name
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Non-throwing convenience method for safe operations.
   * Returns a payload or an error object without crashing the caller.
   */
  async getRatesSafe(): Promise<{
    payload: RawRatePayload | null;
    error: CoinGeckoProviderError | null;
  }> {
    try {
      const payload = await this.getRates();
      return { payload, error: null };
    } catch (err) {
      const error =
        err instanceof CoinGeckoProviderError
          ? err
          : new CoinGeckoProviderError(err instanceof Error ? err.message : String(err), err);
      return { payload: null, error };
    }
  }
}
