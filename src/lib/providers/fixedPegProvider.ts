/**
 * AllFinConverter Fixed Peg Rate Provider Adapter
 *
 * Implements the RateProvider interface for reference assets whose exchange rates
 * are established by official currency pegs rather than floating market quotes.
 *
 * Primary Use Case:
 * - UAE Dirham (AED): Officially pegged to the US Dollar at 1 USD = 3.6725 AED
 *   (decreed by UAE Central Bank regulation since November 1997).
 * - The European Central Bank (ECB) and Frankfurter API do not publish daily AED reference rates.
 * - This provider supplies the official USD-pegged reference rate for AED.
 *
 * Invariants & Labeling Requirements:
 * - AED is documented and labeled as a fixed-peg-derived reference rate, NOT a live
 *   floating market quote or an ECB reference rate.
 * - It is NEVER described as an independently retrieved market price.
 * - Base currency USD is explicitly set to rate '1'.
 * - Rates strictly follow the USD-base normalization convention: 1 USD = R asset units.
 *   Therefore, AED rate = 3.6725.
 * - Does NOT perform any network calls.
 */

import Big from 'big.js';
import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';

/**
 * Official fixed peg rate: 1 USD = 3.6725 AED.
 * Established by UAE Central Bank decree.
 */
export const AED_USD_PEG_RATE_STR = '3.6725';
export const AED_USD_PEG_RATE = new Big(AED_USD_PEG_RATE_STR);

/**
 * Reciprocal rate: 1 AED = ~0.2722940776 USD (1 / 3.6725).
 */
export const USD_AED_RECIPROCAL_RATE = new Big(1).div(AED_USD_PEG_RATE);

/**
 * Configuration options for FixedPegRateProvider.
 */
export interface FixedPegProviderOptions {
  /** Optional custom provider ID. Defaults to 'fixed-peg'. */
  readonly id?: string;
  /** Optional custom display name. Defaults to 'Fixed Peg Reference (USD)'. */
  readonly name?: string;
  /** Optional custom timestamp generator or fixed timestamp (epoch ms). */
  readonly timestamp?: number;
}

/**
 * RateProvider adapter supplying official currency peg rates against USD base.
 */
export class FixedPegRateProvider implements RateProvider {
  readonly id: string;
  readonly name: string;
  readonly isMock = false;

  private readonly timestampOverride?: number;

  constructor(options?: FixedPegProviderOptions) {
    this.id = options?.id ?? 'fixed-peg';
    this.name = options?.name ?? 'Fixed Peg Reference (USD)';
    this.timestampOverride = options?.timestamp;
  }

  /**
   * Returns normalized fixed-peg rates for supported pegged assets (AED) against USD base.
   * Performs ZERO network calls.
   */
  getRates(): RawRatePayload {
    const timestamp = this.timestampOverride ?? Date.now();

    return {
      providerId: this.id,
      providerName: this.name,
      timestamp,
      isMock: false,
      rates: {
        USD: '1',
        AED: AED_USD_PEG_RATE_STR,
      },
    };
  }
}

/**
 * Default singleton instance of FixedPegRateProvider.
 */
export const defaultFixedPegProvider = new FixedPegRateProvider();
