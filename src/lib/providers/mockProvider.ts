/**
 * WorthPair Local Mock Rate Provider
 *
 * Implements the RateProvider interface using static fictional demo data.
 * Contains ZERO network calls, zero external dependencies, and zero API keys.
 * All rates are normalized to USD (1 USD = R asset units).
 */

import type { RateProvider } from '../rateProviders';
import type { RawRatePayload } from '../rates';

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

  constructor(customRates?: Record<string, string>) {
    this.rates = customRates ? Object.freeze({ ...customRates }) : FICTIONAL_MOCK_RATES;
  }

  /**
   * Returns the raw rate payload synchronously without any network requests.
   */
  getRates(): RawRatePayload {
    return {
      providerId: this.id,
      providerName: this.name,
      timestamp: Date.now(),
      isMock: true,
      rates: this.rates,
    };
  }
}

/**
 * Default singleton instance of the mock rate provider.
 */
export const defaultMockProvider = new MockRateProvider();
