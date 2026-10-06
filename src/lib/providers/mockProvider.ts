/**
 * AllFinConverter Local Mock Rate Provider
 *
 * Implements the RateProvider interface using static fictional demo data.
 * Contains ZERO network calls, zero external dependencies, and zero API keys.
 * All rates are normalized to USD (1 USD = R asset units).
 */

import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';

/**
 * Explicit static snapshot timestamp for fictional development mock rates.
 * Fixed reference: 2026-01-01T00:00:00.000Z.
 * Mock data does NOT invent dynamic "live" timestamps on each invocation.
 */
export const MOCK_DATASET_TIMESTAMP = 1767225600000;

/**
 * Fictional mock rate dataset for local development and testing.
 * Covers all 19 supported assets across Fiat, Crypto, and Precious Metals.
 */
export const FICTIONAL_MOCK_RATES: Readonly<Record<string, string>> = {
  // Fiat Currencies (units per 1 USD)
  USD: '1',
  EUR: '0.92',
  GBP: '0.79',
  JPY: '155.0',
  CHF: '0.90',
  CAD: '1.36',
  AUD: '1.52',
  ZAR: '18.25',
  INR: '83.50',
  AED: '3.67',

  // Cryptocurrencies (units per 1 USD) - Fictional development values
  BTC: '0.000015',
  ETH: '0.00038',
  SOL: '0.0068',
  XRP: '1.85',
  DOGE: '8.33',

  // Precious Metals (units per 1 USD, reference troy-ounce) - Fictional development values
  XAU: '0.000416',
  XAG: '0.0357',
  XPT: '0.00104',
  XPD: '0.00102',
};

/**
 * Mock implementation of RateProvider supplying offline development rates.
 */
export class MockRateProvider implements RateProvider {
  readonly id = 'mock-local';
  readonly name = 'Local Mock Provider';
  readonly isMock = true;

  private readonly rates: Readonly<Record<string, string>>;
  private readonly timestamp: number;

  constructor(
    customRates?: Record<string, string>,
    timestamp: number = MOCK_DATASET_TIMESTAMP
  ) {
    this.rates = customRates ? Object.freeze({ ...customRates }) : FICTIONAL_MOCK_RATES;
    this.timestamp = timestamp;
  }

  /**
   * Returns the raw rate payload synchronously with an explicit static mock timestamp.
   */
  getRates(): RawRatePayload {
    return {
      providerId: this.id,
      providerName: this.name,
      timestamp: this.timestamp,
      isMock: true,
      rates: this.rates,
    };
  }
}

/**
 * Default singleton instance of the mock rate provider.
 */
export const defaultMockProvider = new MockRateProvider();
