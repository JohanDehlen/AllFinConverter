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

export type AssetCategory = 'fiat' | 'crypto' | 'commodity';

export interface Asset {
  code: string;
  name: string;
  category: AssetCategory;
  ratePerUsd: string; // Fictional normalized rate: 1 USD = X units
}

/**
 * Fictional mock asset dataset for milestone M1.0.
 * Plausible demo numbers for realistic UI testing; entirely local and offline.
 */
export const MOCK_ASSETS: readonly Asset[] = [
  // Required Fiat Currencies
  { code: 'USD', name: 'US Dollar', category: 'fiat', ratePerUsd: '1' },
  { code: 'EUR', name: 'Euro', category: 'fiat', ratePerUsd: '0.92' },
  { code: 'GBP', name: 'British Pound', category: 'fiat', ratePerUsd: '0.79' },
  { code: 'JPY', name: 'Japanese Yen', category: 'fiat', ratePerUsd: '155.0' },
  { code: 'CHF', name: 'Swiss Franc', category: 'fiat', ratePerUsd: '0.90' },
  { code: 'CAD', name: 'Canadian Dollar', category: 'fiat', ratePerUsd: '1.36' },
  { code: 'AUD', name: 'Australian Dollar', category: 'fiat', ratePerUsd: '1.52' },
  { code: 'ZAR', name: 'South African Rand', category: 'fiat', ratePerUsd: '18.25' },
  { code: 'INR', name: 'Indian Rupee', category: 'fiat', ratePerUsd: '83.50' },
  { code: 'AED', name: 'UAE Dirham', category: 'fiat', ratePerUsd: '3.67' },

  // Additional Demo Assets for WorthPair multi-asset concept (Crypto & Precious Metals)
  { code: 'BTC', name: 'Bitcoin', category: 'crypto', ratePerUsd: '0.000015' },
  { code: 'XAU', name: 'Gold (troy oz)', category: 'commodity', ratePerUsd: '0.000416' },
] as const;

const RATE_MAP = new Map<string, Big>(
  MOCK_ASSETS.map((a) => [a.code, new Big(a.ratePerUsd)])
);

const ASSET_MAP = new Map<string, Asset>(
  MOCK_ASSETS.map((a) => [a.code, a])
);

/**
 * Abstraction function: Retrieve the normalized mock rate (units per 1 USD) for an asset.
 * Throws an Error if the asset code is unknown.
 */
export function getMockRate(assetCode: string): Big {
  const code = assetCode.toUpperCase();
  const rate = RATE_MAP.get(code);
  if (!rate) {
    throw new Error(`Asset code '${assetCode}' not found in mock rate dataset.`);
  }
  return rate;
}

/**
 * Abstraction function: Get the full list of supported mock assets.
 */
export function getSupportedAssets(): readonly Asset[] {
  return MOCK_ASSETS;
}

/**
 * Abstraction function: Get metadata for a specific asset code.
 */
export function getAssetMeta(assetCode: string): Asset | undefined {
  return ASSET_MAP.get(assetCode.toUpperCase());
}
