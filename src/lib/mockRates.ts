/**
 * FICTIONAL DEVELOPMENT / DEMO DATA ONLY.
 *
 * IMPORTANT:
 * These rates are mock values used solely for local UI development and testing.
 * They are NOT live, real-time, or real market rates.
 * Do NOT use these values for real financial decisions.
 *
 * Rate representation:
 * Base is normalized to USD: 1 USD = X asset units.
 */

import Big from 'big.js';

/**
 * Fictional mock rate dataset for milestone M1.1.
 * Plausible demo numbers for realistic UI testing; entirely local and offline.
 * Covers all 19 supported assets across Fiat, Crypto, and Precious Metals.
 */
export const MOCK_RATES: Readonly<Record<string, string>> = {
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

  // Precious Metals (units per 1 USD, reference troy ounce) - Fictional development values
  XAU: '0.000416',
  XAG: '0.0357',
  XPT: '0.00104',
  XPD: '0.00102',
};

const RATE_MAP = new Map<string, Big>(
  Object.entries(MOCK_RATES).map(([code, rateStr]) => [code, new Big(rateStr)])
);

/**
 * Abstraction function: Retrieve the normalized mock rate (units per 1 USD) for an asset.
 * Normalizes input code to uppercase.
 * Throws an Error if the asset code is unknown in the mock rate dataset.
 */
export function getMockRate(assetCode: string): Big {
  const code = assetCode.trim().toUpperCase();
  const rate = RATE_MAP.get(code);
  if (!rate) {
    throw new Error(`Asset code '${assetCode}' not found in mock rate dataset.`);
  }
  return rate;
}

/**
 * Checks whether a given asset code has an available mock rate.
 */
export function hasMockRate(assetCode: string): boolean {
  return RATE_MAP.has(assetCode.trim().toUpperCase());
}
