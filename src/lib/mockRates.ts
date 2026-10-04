/**
 * FICTIONAL DEVELOPMENT / DEMO DATA ONLY.
 *
 * IMPORTANT:
 * These rates are mock values used solely for local UI development and testing.
 * They are NOT live, real-time, or real market rates.
 * Do NOT use these values for real financial decisions.
 *
 * M1.2 Architecture Note:
 * Rates are supplied via `src/lib/providers/mockProvider.ts` and managed by `src/lib/rateEngine.ts`.
 * This module delegates to the Rate Engine and Provider to eliminate data duplication.
 */

import type Big from 'big.js';
import { FICTIONAL_MOCK_RATES } from './providers/mockProvider';
import { getRate, hasRate } from './rateEngine';

/**
 * Fictional mock rate dataset for milestone M1.1/M1.2.
 */
export const MOCK_RATES: Readonly<Record<string, string>> = FICTIONAL_MOCK_RATES;

/**
 * Retrieves the normalized rate (units per 1 USD) from the active rate engine.
 * Normalizes input code to uppercase.
 */
export function getMockRate(assetCode: string): Big {
  return getRate(assetCode);
}

/**
 * Checks whether a given asset code has an available rate in the active rate engine.
 */
export function hasMockRate(assetCode: string): boolean {
  return hasRate(assetCode);
}
