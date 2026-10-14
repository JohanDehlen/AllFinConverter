/**
 * AllFinConverter Frankfurter FX Rate Provider
 *
 * Implements the RateProvider interface for Frankfurter (ECB reference rates).
 * Frankfurter is a free, open-source API tracking European Central Bank daily reference rates.
 * It requires ZERO API keys and no paid subscription.
 *
 * Reference rates:
 * - Base is always USD (1 USD = R asset units).
 * - Only daily reference rates are queried.
 * - Publication date is preserved as the dataset timestamp (epoch ms UTC).
 * - Fetch time is NEVER misrepresented as the rate publication date.
 * - Missing or invalid rates are NEVER silently converted to zero.
 */

import Big from 'big.js';
import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';

/**
 * Default base URL for the Frankfurter API.
 */
export const DEFAULT_FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';

/**
 * The ten canonical fiat currency codes configured in AllFinConverter.
 */
export const FRANKFURTER_SUPPORTED_FIAT_CODES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'ZAR',
  'INR',
  'AED',
] as const;

export type SupportedFiatCode = (typeof FRANKFURTER_SUPPORTED_FIAT_CODES)[number];

/**
 * Custom error class for Frankfurter provider failures (network, HTTP, parsing, validation).
 */
export class FrankfurterProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FrankfurterProviderError';
    this.cause = cause;
  }
}

/**
 * Options for configuring the FrankfurterRateProvider.
 */
export interface FrankfurterProviderOptions {
  /** Base URL for Frankfurter API. Defaults to DEFAULT_FRANKFURTER_BASE_URL. */
  readonly baseUrl?: string;
  /** Custom fetch implementation for testing or non-standard runtimes. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Defaults to 10,000ms. */
  readonly timeoutMs?: number;
}

/**
 * Normalizes a raw parsed JSON response from the Frankfurter API into a project-standard RawRatePayload.
 *
 * Validation rules:
 * 1. Input must be an object with valid structure.
 * 2. Base currency must be 'USD'.
 * 3. Date must be a valid 'YYYY-MM-DD' string representing the ECB reference rate date.
 * 4. Timestamp is derived directly from the reference date (UTC midnight), never Date.now().
 * 5. USD is explicitly injected with rate '1'.
 * 6. Only configured fiat currencies are extracted; unsupported currencies are discarded.
 * 7. Rate values must be finite, strictly positive numbers.
 * 8. Missing currencies (e.g. AED not tracked by ECB) are omitted, NEVER turned into zero.
 * 9. Non-numeric, zero, negative, NaN, and Infinity rates are skipped, NEVER turned into zero.
 */
export function normalizeFrankfurterResponse(rawJson: unknown): RawRatePayload {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    throw new FrankfurterProviderError('Frankfurter response is missing or malformed (expected an object).');
  }

  const data = rawJson as Record<string, unknown>;

  // 1. Base currency check
  if (data.base !== 'USD') {
    throw new FrankfurterProviderError(
      `Frankfurter response base must be 'USD' (received: '${String(data.base)}').`
    );
  }

  // 2. Publication date validation and timestamp extraction
  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new FrankfurterProviderError(
      `Frankfurter response has invalid or missing publication date: '${String(data.date)}'.`
    );
  }

  const publicationTimestamp = Date.parse(`${data.date}T00:00:00.000Z`);
  if (!Number.isFinite(publicationTimestamp) || publicationTimestamp <= 0) {
    throw new FrankfurterProviderError(
      `Failed to parse valid epoch timestamp from Frankfurter date: '${data.date}'.`
    );
  }

  // 3. Rates container validation
  if (!data.rates || typeof data.rates !== 'object' || Array.isArray(data.rates)) {
    throw new FrankfurterProviderError('Frankfurter response missing valid rates object.');
  }

  const rawRates = data.rates as Record<string, unknown>;
  const normalizedRates: Record<string, string> = {};

  // 4. Base USD rate is always exactly 1
  normalizedRates['USD'] = '1';

  // 5. Extract supported fiat currencies
  for (const code of FRANKFURTER_SUPPORTED_FIAT_CODES) {
    if (code === 'USD') continue; // already set to '1'

    const rawVal = rawRates[code];

    // Missing currency: omit safely, never set to 0 or null
    if (rawVal === undefined || rawVal === null) {
      continue;
    }

    // Number conversion and strict validation
    let bigRate: Big;
    try {
      if (typeof rawVal === 'number') {
        if (!Number.isFinite(rawVal) || Number.isNaN(rawVal)) {
          continue;
        }
        bigRate = new Big(rawVal);
      } else if (typeof rawVal === 'string' && rawVal.trim() !== '') {
        bigRate = new Big(rawVal.trim());
      } else {
        // Discard unsupported types (booleans, objects, empty strings)
        continue;
      }
    } catch {
      // Discard unparseable numbers without throwing
      continue;
    }

    // Strictly positive check
    if (bigRate.lte(0)) {
      continue;
    }

    normalizedRates[code] = bigRate.toFixed();
  }

  return {
    providerId: 'frankfurter',
    providerName: 'Frankfurter FX',
    timestamp: publicationTimestamp,
    isMock: false,
    rates: normalizedRates,
  };
}

/**
 * RateProvider adapter for Frankfurter's public API.
 * Fetches daily reference rates normalized to USD base.
 */
export class FrankfurterRateProvider implements RateProvider {
  readonly id = 'frankfurter';
  readonly name = 'Frankfurter FX';
  readonly isMock = false;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options?: FrankfurterProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? DEFAULT_FRANKFURTER_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  /**
   * Fetches latest daily reference rates from Frankfurter and normalizes to USD base.
   * Throws FrankfurterProviderError on network failure, HTTP error, timeout, or malformed JSON.
   */
  async getRates(): Promise<RawRatePayload> {
    const url = `${this.baseUrl}/latest?base=USD`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FrankfurterProviderError(
          `Frankfurter request timed out after ${this.timeoutMs}ms.`,
          err
        );
      }
      throw new FrankfurterProviderError(
        `Frankfurter network request failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new FrankfurterProviderError(
        `Frankfurter HTTP error: ${response.status} ${response.statusText}`.trim()
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new FrankfurterProviderError(
        `Failed to parse Frankfurter JSON response: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    return normalizeFrankfurterResponse(json);
  }

  /**
   * Non-throwing convenience method for safe operations.
   * Returns a payload or an error object without crashing the caller.
   */
  async getRatesSafe(): Promise<{ payload: RawRatePayload | null; error: FrankfurterProviderError | null }> {
    try {
      const payload = await this.getRates();
      return { payload, error: null };
    } catch (err) {
      const error =
        err instanceof FrankfurterProviderError
          ? err
          : new FrankfurterProviderError(err instanceof Error ? err.message : String(err), err);
      return { payload: null, error };
    }
  }
}

/**
 * Default singleton instance of the Frankfurter rate provider.
 * Note: instantiating this class performs ZERO network calls.
 */
export const defaultFrankfurterProvider = new FrankfurterRateProvider();
