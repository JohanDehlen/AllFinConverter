/**
 * WorthPair Normalized Rate Data Model
 *
 * Provider-neutral data definitions for exchange rates and normalized market datasets.
 * Decouples rate representations from external provider schemas and the calculation engine.
 *
 * Base normalization convention:
 * Base is always USD (1 USD = R asset units).
 */

import type Big from 'big.js';

/**
 * Represents a single normalized exchange rate entry for an asset.
 */
export interface NormalizedRate {
  /** Canonical uppercase asset code (e.g. 'USD', 'EUR', 'BTC', 'XAU') */
  readonly assetCode: string;
  /** Exchange rate normalized to USD (1 USD = rate units of asset) */
  readonly rate: Big;
  /** Timestamp when this rate was recorded/normalized (epoch ms) */
  readonly timestamp?: number;
  /** Identifier of the provider source */
  readonly source: string;
  /** Whether the rate passed all validation rules */
  readonly isValid: boolean;
}

/**
 * Complete normalized rate dataset supplied by a provider and validated by the rate engine.
 */
export interface NormalizedRateDataset {
  /** Identifier of the originating provider (e.g., 'mock-provider') */
  readonly providerId: string;
  /** Display name of the provider */
  readonly providerName: string;
  /** Normalization base asset (always 'USD') */
  readonly baseAsset: 'USD';
  /** Timestamp of dataset creation / snapshot (epoch ms) */
  readonly timestamp: number;
  /** Normalized rates indexed by canonical uppercase asset code */
  readonly rates: ReadonlyMap<string, Big>;
  /** Indicates whether this dataset is synthetic mock/demo data */
  readonly isMock: boolean;
}

/**
 * Raw rate entry before normalization and validation.
 */
export interface RawRateEntry {
  readonly code: string;
  readonly rate: string | number | Big;
}

/**
 * Raw provider payload format submitted to the rate engine for validation.
 */
export interface RawRatePayload {
  /** Unique provider identifier */
  readonly providerId: string;
  /** Provider human-readable name */
  readonly providerName: string;
  /** Optional payload timestamp (epoch ms) */
  readonly timestamp?: number;
  /** Indicates if data is demo/mock */
  readonly isMock?: boolean;
  /** Raw rates as a key-value record or an array of entries */
  readonly rates: Record<string, string | number | Big> | readonly RawRateEntry[];
}

/**
 * Result of dataset validation by the rate engine.
 */
export interface DatasetValidationResult {
  /** True if dataset is structurally sound and contains a valid USD base */
  readonly valid: boolean;
  /** The validated normalized dataset, present if valid is true */
  readonly dataset?: NormalizedRateDataset;
  /** Validation errors that prevented acceptance or affected entries */
  readonly errors: readonly string[];
  /** Non-fatal warnings for discarded or skipped entries */
  readonly warnings: readonly string[];
}
