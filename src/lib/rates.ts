/**
 * AllFinConverter Normalized Rate Data Model
 *
 * Provider-neutral data definitions for exchange rates, normalized market datasets,
 * freshness states, and reliability status.
 *
 * Base normalization convention:
 * Base is always USD (1 USD = R asset units).
 */

import type Big from 'big.js';

/**
 * Freshness lifecycle classification of a rate dataset.
 * - 'fresh': Structurally valid and within the acceptable time threshold.
 * - 'stale': Structurally valid, but older than the freshness threshold. Usable as last-known-good.
 * - 'unavailable': No valid or usable rate dataset is available. Calculations must not proceed.
 */
export type RateFreshnessStatus = 'fresh' | 'stale' | 'unavailable';

/**
 * Default provisional freshness threshold in milliseconds (24 hours).
 * NOTE: This value is provisional for local/mock foundation and will be configured per-source in production.
 */
export const DEFAULT_FRESHNESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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
  /** Identifier of the originating provider (e.g., 'mock-local') */
  readonly providerId: string;
  /** Display name of the provider */
  readonly providerName: string;
  /** Normalization base asset (always 'USD') */
  readonly baseAsset: 'USD';
  /** Timestamp representing when the underlying dataset was snapshot/generated (epoch ms) */
  readonly timestamp: number;
  /** Normalized rates indexed by canonical uppercase asset code */
  readonly rates: ReadonlyMap<string, Big>;
  /** Indicates whether this dataset is synthetic mock/demo data */
  readonly isMock: boolean;
}

/**
 * Comprehensive status report on the current rate dataset freshness and reliability.
 */
export interface RateDatasetStatusInfo {
  /** Freshness status: 'fresh', 'stale', or 'unavailable' */
  readonly status: RateFreshnessStatus;
  /** True if the dataset is usable for conversion calculations (status is 'fresh' or 'stale') */
  readonly isUsable: boolean;
  /** Provider identifier if dataset is loaded */
  readonly providerId?: string;
  /** Provider human-readable name if dataset is loaded */
  readonly providerName?: string;
  /** Dataset snapshot timestamp (epoch ms) if loaded */
  readonly timestamp?: number;
  /** Age of the dataset in milliseconds at evaluation time */
  readonly ageMs?: number;
  /** True if the active dataset is synthetic development/demo data */
  readonly isMock: boolean;
  /** True if the active dataset is a fallback to a retained last-known-good dataset */
  readonly isLastKnownGood: boolean;
  /** Informational message regarding status or fallback reason */
  readonly message?: string;
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
  /** Dataset snapshot timestamp (epoch ms) */
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

/**
 * Pure helper function to evaluate freshness for any given dataset.
 *
 * Deterministic rules:
 * - If dataset is null/undefined: 'unavailable'
 * - If now - dataset.timestamp > thresholdMs: 'stale'
 * - Otherwise: 'fresh'
 */
export function evaluateDatasetFreshness(
  dataset: NormalizedRateDataset | null | undefined,
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_FRESHNESS_THRESHOLD_MS,
  isLastKnownGood = false,
  fallbackReason?: string
): RateDatasetStatusInfo {
  if (!dataset || dataset.rates.size === 0) {
    return {
      status: 'unavailable',
      isUsable: false,
      isMock: false,
      isLastKnownGood: false,
      message: fallbackReason || 'No rate dataset is currently available.',
    };
  }

  const ageMs = Math.max(0, now - dataset.timestamp);
  const isStale = ageMs > thresholdMs;
  const status: RateFreshnessStatus = isStale ? 'stale' : 'fresh';

  let message: string | undefined;
  if (isLastKnownGood) {
    message = `Using last-known-good dataset from ${dataset.providerName}${fallbackReason ? ` (Reason: ${fallbackReason})` : ''}.`;
  } else if (isStale) {
    message = `Dataset is stale (${Math.round(ageMs / 1000)}s old; exceeds threshold of ${Math.round(thresholdMs / 1000)}s).`;
  }

  return {
    status,
    isUsable: true,
    providerId: dataset.providerId,
    providerName: dataset.providerName,
    timestamp: dataset.timestamp,
    ageMs,
    isMock: dataset.isMock,
    isLastKnownGood,
    message,
  };
}
