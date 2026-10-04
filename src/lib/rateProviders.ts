/**
 * WorthPair Rate Provider Abstraction
 *
 * Generic, provider-neutral contract for rate suppliers.
 * Rate providers are responsible solely for supplying raw rate payloads.
 * They do NOT perform calculations, validation, or UI formatting.
 */

import type { RawRatePayload } from './rates.ts';

/**
 * Generic interface for a rate provider.
 * Any future external provider adapter (e.g. for crypto, fiat, or commodity providers)
 * must implement this contract.
 */
export interface RateProvider {
  /** Unique machine-readable identifier (e.g. 'mock-local') */
  readonly id: string;
  /** Human-readable display name for debugging/status (e.g. 'Local Mock Provider') */
  readonly name: string;
  /** Indicates whether this provider generates synthetic demo data */
  readonly isMock: boolean;
  /**
   * Fetches or retrieves rate data from the provider.
   * May be synchronous (for local mock data) or asynchronous (for future network providers).
   */
  getRates(): RawRatePayload | Promise<RawRatePayload>;
}
