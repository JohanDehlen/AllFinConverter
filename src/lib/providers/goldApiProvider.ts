/**
 * AllFinConverter Gold-API Precious Metals Rate Provider
 *
 * Implements the RateProvider interface for gold-api.com.
 * Gold-API provides real-time spot prices for precious metals (XAU, XAG, XPT, XPD).
 * The endpoint is free to use with zero API keys required for current spot prices.
 *
 * API reference (from https://api.gold-api.com / https://gold-api.com/llms.txt):
 * - Endpoint: GET https://api.gold-api.com/price/{symbol}
 * - Response schema:
 *   {
 *     "symbol": "XAU",
 *     "name": "Gold",
 *     "price": 2350.75, // USD per troy ounce
 *     "currency": "USD",
 *     "currencySymbol": "$",
 *     "exchangeRate": 1,
 *     "updatedAt": "2026-10-12T00:00:00.000Z",
 *     "updatedAtReadable": "a few seconds ago"
 *   }
 *
 * Rate Normalization Convention:
 * - AllFinConverter rates are normalized to USD base: 1 USD = R asset units.
 * - For precious metals, the project's canonical reference unit is the troy ounce.
 * - Gold-API provides price P in USD per troy ounce (e.g. P = 2500 USD / troy oz).
 * - Therefore, the normalized rate R (troy ounces per 1 USD) is: R = 1 / P.
 * - Base currency USD is explicitly injected with rate '1'.
 */

import Big from 'big.js';
import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';

/**
 * Default base URL for the Gold-API service.
 */
export const DEFAULT_GOLD_API_BASE_URL = 'https://api.gold-api.com';

/**
 * Canonical precious metal asset codes supported by AllFinConverter and Gold-API.
 */
export const GOLD_API_SUPPORTED_METALS = ['XAU', 'XAG', 'XPT', 'XPD'] as const;

export type SupportedMetalCode = (typeof GOLD_API_SUPPORTED_METALS)[number];

const SUPPORTED_METALS_SET: ReadonlySet<string> = new Set(GOLD_API_SUPPORTED_METALS);

/**
 * Custom error class for Gold-API provider failures (network, HTTP, parsing, validation).
 */
export class GoldApiProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GoldApiProviderError';
    this.cause = cause;
  }
}

/**
 * Configuration options for GoldApiRateProvider.
 */
export interface GoldApiProviderOptions {
  /** Base URL for Gold-API. Defaults to DEFAULT_GOLD_API_BASE_URL. */
  readonly baseUrl?: string;
  /** Custom fetch implementation for testing or non-standard runtimes. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Defaults to 10,000ms. */
  readonly timeoutMs?: number;
  /** Metal symbols to retrieve. Defaults to GOLD_API_SUPPORTED_METALS. */
  readonly symbols?: readonly SupportedMetalCode[];
  /**
   * If true (default), requires all requested metal symbols to succeed.
   * If any metal request fails, getRates() throws GoldApiProviderError so that
   * RateOrchestrator and RateEngine preserve their complete last-known-good dataset
   * without dropping missing metals.
   * If false, allows partial batches containing only the succeeding metals.
   */
  readonly requireAll?: boolean;
}

/**
 * Parsed and validated result for an individual metal price response.
 */
export interface SingleMetalRateResult {
  readonly code: SupportedMetalCode;
  readonly rate: string;
  readonly timestamp: number;
}

/**
 * Normalizes a single metal price JSON response from Gold-API (/price/{symbol}).
 *
 * Validation rules:
 * 1. Must be an object with string symbol, positive finite price, currency USD, and valid updatedAt.
 * 2. Symbol must be one of the supported precious metal codes (XAU, XAG, XPT, XPD).
 * 3. Currency must be 'USD'.
 * 4. Price must be strictly positive and finite (> 0).
 * 5. Inverts the price to USD-base: rate = 1 / price (troy ounces per 1 USD).
 * 6. Timestamp is extracted from updatedAt (UTC epoch ms).
 */
export function normalizeGoldApiPriceResponse(rawJson: unknown): SingleMetalRateResult {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new GoldApiProviderError('Gold-API response is missing or malformed (expected an object).');
  }

  const data = rawJson as Record<string, unknown>;

  // 1. Symbol validation
  if (typeof data.symbol !== 'string') {
    throw new GoldApiProviderError(`Gold-API response missing symbol: '${String(data.symbol)}'.`);
  }
  const code = data.symbol.trim().toUpperCase() as SupportedMetalCode;
  if (!SUPPORTED_METALS_SET.has(code)) {
    throw new GoldApiProviderError(`Unsupported metal symbol from Gold-API: '${code}'.`);
  }

  // 2. Currency validation (must be USD)
  if (data.currency !== 'USD') {
    throw new GoldApiProviderError(
      `Gold-API response currency must be 'USD' (received: '${String(data.currency)}').`
    );
  }

  // 3. Price validation and normalization
  let bigPrice: Big;
  try {
    if (typeof data.price === 'number') {
      if (!Number.isFinite(data.price) || Number.isNaN(data.price)) {
        throw new Error('Price is NaN or Infinity');
      }
      bigPrice = new Big(data.price);
    } else if (typeof data.price === 'string' && data.price.trim() !== '') {
      bigPrice = new Big(data.price.trim());
    } else {
      throw new Error(`Invalid price type: ${typeof data.price}`);
    }
  } catch (err) {
    throw new GoldApiProviderError(
      `Invalid or non-numeric price for '${code}': '${String(data.price)}'`,
      err
    );
  }

  if (bigPrice.lte(0)) {
    throw new GoldApiProviderError(
      `Non-positive price for '${code}': ${bigPrice.toFixed()} (must be strictly positive).`
    );
  }

  // Rate normalization: 1 USD = (1 / price) troy ounces
  const normalizedRate = new Big(1).div(bigPrice).toFixed();

  // 4. Timestamp extraction from updatedAt ISO string
  if (typeof data.updatedAt !== 'string' || data.updatedAt.trim() === '') {
    throw new GoldApiProviderError(
      `Gold-API response for '${code}' missing valid updatedAt string.`
    );
  }

  const timestamp = Date.parse(data.updatedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new GoldApiProviderError(
      `Failed to parse valid epoch timestamp from updatedAt for '${code}': '${data.updatedAt}'.`
    );
  }

  return {
    code,
    rate: normalizedRate,
    timestamp,
  };
}

/**
 * Normalizes multiple metal responses into a single canonical RawRatePayload.
 *
 * Rules:
 * - Base asset USD is injected with rate '1'.
 * - At least one valid precious metal rate must be present.
 * - Dataset timestamp is the oldest (earliest) timestamp among the contributing metals,
 *   guaranteeing that no older rate can ever appear newer.
 */
export function normalizeGoldApiResponses(
  responses: readonly unknown[],
  providerId = 'goldapi',
  providerName = 'Gold API'
): RawRatePayload {
  const rates: Record<string, string> = {
    USD: '1',
  };
  let oldestTimestamp = Infinity;
  let validMetalCount = 0;

  for (const res of responses) {
    try {
      const parsed = normalizeGoldApiPriceResponse(res);
      rates[parsed.code] = parsed.rate;
      if (parsed.timestamp < oldestTimestamp) {
        oldestTimestamp = parsed.timestamp;
      }
      validMetalCount++;
    } catch {
      // Discard invalid individual metal responses gracefully
      continue;
    }
  }

  if (validMetalCount === 0 || !Number.isFinite(oldestTimestamp)) {
    throw new GoldApiProviderError('No valid precious metal rates found in Gold-API responses.');
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
 * RateProvider adapter for Gold-API (https://api.gold-api.com).
 * Fetches real-time spot prices for precious metals and normalizes them to USD base.
 */
export class GoldApiRateProvider implements RateProvider {
  readonly id = 'goldapi';
  readonly name = 'Gold API';
  readonly isMock = false;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly symbols: readonly SupportedMetalCode[];
  private readonly requireAll: boolean;

  constructor(options?: GoldApiProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_GOLD_API_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.symbols = options?.symbols ?? GOLD_API_SUPPORTED_METALS;
    this.requireAll = options?.requireAll ?? true;
  }

  /**
   * Fetches latest spot prices for all configured metals and normalizes to USD base.
   * Throws GoldApiProviderError on network failure, timeout, HTTP error, or if no valid rates are returned.
   */
  async getRates(): Promise<RawRatePayload> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetchPromises = this.symbols.map(async (symbol) => {
        const url = `${this.baseUrl}/price/${encodeURIComponent(symbol)}`;
        let response: Response;
        try {
          response = await this.fetchFn(url, { signal: controller.signal });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw new GoldApiProviderError(
              `Gold-API request for '${symbol}' timed out after ${this.timeoutMs}ms.`,
              err
            );
          }
          throw new GoldApiProviderError(
            `Gold-API network request for '${symbol}' failed: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }

        if (!response.ok) {
          throw new GoldApiProviderError(
            `Gold-API HTTP error for '${symbol}': ${response.status} ${response.statusText}`.trim()
          );
        }

        let json: unknown;
        try {
          json = await response.json();
        } catch (err) {
          throw new GoldApiProviderError(
            `Failed to parse Gold-API JSON response for '${symbol}': ${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }

        return json;
      });

      const settledResults = await Promise.allSettled(fetchPromises);
      const successfulResponses: unknown[] = [];
      const errors: string[] = [];
      let timeoutError: GoldApiProviderError | null = null;

      for (const res of settledResults) {
        if (res.status === 'fulfilled') {
          successfulResponses.push(res.value);
        } else {
          const reason = res.reason;
          if (reason instanceof GoldApiProviderError && reason.message.includes('timed out')) {
            timeoutError = reason;
          }
          errors.push(reason instanceof Error ? reason.message : String(reason));
        }
      }

      // If all requests timed out, propagate the timeout error
      if (successfulResponses.length === 0 && timeoutError) {
        throw timeoutError;
      }

      // If all requests failed, throw an aggregated error
      if (successfulResponses.length === 0) {
        throw new GoldApiProviderError(
          `All Gold-API metal requests failed: ${errors.join('; ')}`
        );
      }

      // If requireAll is true (default) and any metal request failed, throw to protect LKG retention
      if (this.requireAll && errors.length > 0) {
        throw new GoldApiProviderError(
          `Gold-API metal request failed (requireAll=true): ${errors.join('; ')}`
        );
      }

      return normalizeGoldApiResponses(successfulResponses, this.id, this.name);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Non-throwing convenience method for safe operations.
   * Returns a payload or an error object without crashing the caller.
   */
  async getRatesSafe(): Promise<{ payload: RawRatePayload | null; error: GoldApiProviderError | null }> {
    try {
      const payload = await this.getRates();
      return { payload, error: null };
    } catch (err) {
      const error =
        err instanceof GoldApiProviderError
          ? err
          : new GoldApiProviderError(err instanceof Error ? err.message : String(err), err);
      return { payload: null, error };
    }
  }
}

/**
 * Default singleton instance of the Gold-API rate provider.
 * Instantiating this class performs ZERO network calls.
 */
export const defaultGoldApiProvider = new GoldApiRateProvider();
