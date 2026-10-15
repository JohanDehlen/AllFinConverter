/**
 * AllFinConverter Rate Snapshot Contract & Validation
 *
 * Defines the canonical, versioned, JSON-safe snapshot schema for serializing
 * and deserializing rate datasets across distribution boundaries (e.g. static JSON files,
 * CDN distribution, and client-side hydration).
 *
 * Precision Principle:
 * Exchange rates are serialized as decimal strings (e.g. "0.00001538461538461538461538461538")
 * to guarantee that Big.js precision is preserved without IEEE-754 floating-point truncation.
 */

import Big from 'big.js';
import { getSupportedAssets } from './assets.ts';
import type { NormalizedRateDataset } from './rates.ts';
import type { RateProvenance } from './compositeRates.ts';
import { FICTIONAL_MOCK_RATES } from './providers/mockProvider.ts';

/**
 * Supported snapshot schema versions.
 */
export const CURRENT_SNAPSHOT_VERSION = 1;

/**
 * Maximum acceptable age for a rate snapshot to be considered valid and fresh (24 hours).
 */
export const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Provenance metadata entry for a single asset in a rate snapshot.
 */
export interface RateSnapshotProvenanceEntry {
  /** Identifier of the provider that supplied this rate */
  readonly sourceId: string;
  /** Display name of the originating provider */
  readonly sourceName: string;
  /** Individual publication timestamp (epoch ms) */
  readonly timestamp: number;
}

/**
 * Canonical JSON-serializable rate snapshot payload.
 */
export interface RateSnapshotPayload {
  /** Snapshot schema version */
  readonly version: 1;
  /** Identifier of the provider or orchestrator that generated this snapshot */
  readonly providerId: string;
  /** Display name of the provider or orchestrator */
  readonly providerName: string;
  /** Normalization base asset (always 'USD') */
  readonly baseAsset: 'USD';
  /** Snapshot generation timestamp (epoch ms) */
  readonly timestamp: number;
  /** True if the snapshot contains mock/fictional data */
  readonly isMock: boolean;
  /** Decimal string rates indexed by canonical uppercase asset code */
  readonly rates: Readonly<Record<string, string>>;
  /** Per-asset provenance records mapping asset code to origin metadata */
  readonly provenance: Readonly<Record<string, RateSnapshotProvenanceEntry>>;
}

/**
 * Custom error class for snapshot validation and parsing failures.
 */
export class RateSnapshotError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RateSnapshotError';
    this.cause = cause;
  }
}

/**
 * Options for snapshot validation.
 */
export interface SnapshotValidationOptions {
  /**
   * Maximum acceptable age in milliseconds.
   * Defaults to MAX_SNAPSHOT_AGE_MS (24 hours).
   * Set to 0 or Infinity to bypass the age check.
   */
  readonly maxAgeMs?: number;
  /**
   * Reference timestamp in epoch ms for age evaluation.
   * Defaults to Date.now().
   */
  readonly now?: number;
}

/**
 * Validates and normalizes an untrusted rate snapshot payload.
 *
 * Strict validation rules:
 * 1. Must be a valid object with version 1.
 * 2. baseAsset must be 'USD' and rates['USD'] must equal '1'.
 * 3. timestamp must be a positive finite number.
 * 4. Snapshot timestamp must not exceed maxAgeMs (default: 24h) and must not be from the future (> 5m clock skew).
 * 5. rates must contain all 19 canonical assets with positive, finite decimal values.
 * 6. provenance must contain valid metadata entries for all 19 canonical assets.
 */
export function validateRateSnapshot(
  raw: unknown,
  options?: SnapshotValidationOptions
): RateSnapshotPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RateSnapshotError('Rate snapshot payload must be a non-null object.');
  }

  const payload = raw as Partial<RateSnapshotPayload>;

  if (payload.version !== CURRENT_SNAPSHOT_VERSION) {
    throw new RateSnapshotError(
      `Unsupported or missing snapshot version: ${String(payload.version)}. Expected version ${CURRENT_SNAPSHOT_VERSION}.`
    );
  }

  if (typeof payload.providerId !== 'string' || !payload.providerId.trim()) {
    throw new RateSnapshotError('Rate snapshot missing valid providerId.');
  }

  if (typeof payload.providerName !== 'string' || !payload.providerName.trim()) {
    throw new RateSnapshotError('Rate snapshot missing valid providerName.');
  }

  if (payload.baseAsset !== 'USD') {
    throw new RateSnapshotError(
      `Rate snapshot base asset must be 'USD', got: ${String(payload.baseAsset)}.`
    );
  }

  if (
    typeof payload.timestamp !== 'number' ||
    !Number.isFinite(payload.timestamp) ||
    payload.timestamp <= 0
  ) {
    throw new RateSnapshotError(
      `Rate snapshot timestamp must be a positive finite number, got: ${String(payload.timestamp)}.`
    );
  }

  if (typeof payload.isMock !== 'boolean') {
    throw new RateSnapshotError('Rate snapshot missing valid isMock boolean property.');
  }

  // Age / freshness validation
  const maxAge = options?.maxAgeMs !== undefined ? options.maxAgeMs : MAX_SNAPSHOT_AGE_MS;
  if (maxAge > 0 && Number.isFinite(maxAge)) {
    const now = options?.now !== undefined ? options.now : Date.now();
    const age = now - payload.timestamp;

    // Disallow future timestamps beyond a 5-minute clock skew threshold
    if (age < -300_000) {
      throw new RateSnapshotError(
        `Rate snapshot timestamp is from the future (${Math.round(-age / 1000)}s ahead of current time).`
      );
    }

    if (age > maxAge) {
      throw new RateSnapshotError(
        `Rate snapshot is stale (${Math.round(age / 1000)}s old; exceeds 24-hour threshold of ${Math.round(maxAge / 1000)}s).`
      );
    }
  }

  // Rates property validation
  if (!payload.rates || typeof payload.rates !== 'object' || Array.isArray(payload.rates)) {
    throw new RateSnapshotError('Rate snapshot rates property must be a key-value object.');
  }

  const supported = getSupportedAssets();
  const ratesRecord = payload.rates as Record<string, unknown>;

  // Check that all 19 canonical assets are present and valid
  for (const asset of supported) {
    const val = ratesRecord[asset.code];
    if (val === undefined || val === null) {
      throw new RateSnapshotError(`Rate snapshot missing required canonical asset: ${asset.code}.`);
    }

    if (typeof val !== 'string' && typeof val !== 'number') {
      throw new RateSnapshotError(
        `Rate for ${asset.code} must be a decimal string or number, got ${typeof val}.`
      );
    }

    const strVal = String(val).trim();
    if (!strVal) {
      throw new RateSnapshotError(`Rate for ${asset.code} cannot be empty.`);
    }

    let bigVal: Big;
    try {
      bigVal = new Big(strVal);
    } catch {
      throw new RateSnapshotError(
        `Rate for ${asset.code} is not a valid decimal number: "${strVal}".`
      );
    }

    if (!bigVal.gt(0)) {
      throw new RateSnapshotError(
        `Rate for ${asset.code} must be strictly positive (> 0), got ${strVal}.`
      );
    }

    if (asset.code === 'USD' && !bigVal.eq(1)) {
      throw new RateSnapshotError(`USD base rate must equal exactly 1, got ${strVal}.`);
    }
  }

  // Provenance validation
  if (
    !payload.provenance ||
    typeof payload.provenance !== 'object' ||
    Array.isArray(payload.provenance)
  ) {
    throw new RateSnapshotError('Rate snapshot provenance property must be a key-value object.');
  }

  const provRecord = payload.provenance as Record<string, unknown>;
  const cleanProvenance: Record<string, RateSnapshotProvenanceEntry> = {};

  for (const asset of supported) {
    const prov = provRecord[asset.code] as Partial<RateSnapshotProvenanceEntry> | undefined;
    if (!prov || typeof prov !== 'object') {
      throw new RateSnapshotError(
        `Rate snapshot provenance missing entry for asset: ${asset.code}.`
      );
    }

    if (typeof prov.sourceId !== 'string' || !prov.sourceId.trim()) {
      throw new RateSnapshotError(`Provenance for ${asset.code} missing valid sourceId.`);
    }

    if (typeof prov.sourceName !== 'string' || !prov.sourceName.trim()) {
      throw new RateSnapshotError(`Provenance for ${asset.code} missing valid sourceName.`);
    }

    if (
      typeof prov.timestamp !== 'number' ||
      !Number.isFinite(prov.timestamp) ||
      prov.timestamp <= 0
    ) {
      throw new RateSnapshotError(
        `Provenance for ${asset.code} has invalid timestamp: ${String(prov.timestamp)}.`
      );
    }

    cleanProvenance[asset.code] = {
      sourceId: prov.sourceId.trim(),
      sourceName: prov.sourceName.trim(),
      timestamp: prov.timestamp,
    };
  }

  // Freeze clean string rates
  const cleanRates: Record<string, string> = {};
  for (const asset of supported) {
    cleanRates[asset.code] = String(ratesRecord[asset.code]).trim();
  }

  return {
    version: 1,
    providerId: payload.providerId.trim(),
    providerName: payload.providerName.trim(),
    baseAsset: 'USD',
    timestamp: payload.timestamp,
    isMock: payload.isMock,
    rates: Object.freeze(cleanRates),
    provenance: Object.freeze(cleanProvenance),
  };
}

/**
 * Serializes a validated NormalizedRateDataset into a canonical RateSnapshotPayload.
 *
 * Preserves Big.js rate precision by converting each rate to a string via Big.toString().
 */
export function serializeRateSnapshot(
  dataset: NormalizedRateDataset,
  provenanceMap?:
    | ReadonlyMap<string, RateProvenance>
    | Record<string, RateSnapshotProvenanceEntry>,
  options?: {
    providerId?: string;
    providerName?: string;
  }
): RateSnapshotPayload {
  const cleanRates: Record<string, string> = {};
  for (const [code, bigRate] of dataset.rates) {
    cleanRates[code] = bigRate.toString();
  }

  const cleanProvenance: Record<string, RateSnapshotProvenanceEntry> = {};

  if (provenanceMap instanceof Map) {
    for (const [code, prov] of provenanceMap) {
      cleanProvenance[code] = {
        sourceId: prov.sourceId,
        sourceName: prov.sourceName,
        timestamp: prov.timestamp,
      };
    }
  } else if (provenanceMap && typeof provenanceMap === 'object') {
    for (const [code, prov] of Object.entries(provenanceMap)) {
      cleanProvenance[code] = {
        sourceId: prov.sourceId,
        sourceName: prov.sourceName,
        timestamp: prov.timestamp,
      };
    }
  }

  // Ensure all assets present in the dataset have an entry in provenance
  for (const code of dataset.rates.keys()) {
    if (!cleanProvenance[code]) {
      cleanProvenance[code] = {
        sourceId: dataset.providerId,
        sourceName: dataset.providerName,
        timestamp: dataset.timestamp,
      };
    }
  }

  const payload: RateSnapshotPayload = {
    version: 1,
    providerId: options?.providerId ?? dataset.providerId,
    providerName: options?.providerName ?? dataset.providerName,
    baseAsset: 'USD',
    timestamp: dataset.timestamp,
    isMock: dataset.isMock,
    rates: Object.freeze(cleanRates),
    provenance: Object.freeze(cleanProvenance),
  };

  // Validate to ensure full compliance (bypass age check during serialization)
  return validateRateSnapshot(payload, { maxAgeMs: 0 });
}

/**
 * Generates a deterministic mock snapshot covering all 19 canonical assets.
 *
 * Used for build-time static endpoints and offline development fallback.
 */
export function createDefaultMockSnapshot(
  timestamp: number = Date.now()
): RateSnapshotPayload {
  const cleanRates: Record<string, string> = { ...FICTIONAL_MOCK_RATES };
  const cleanProvenance: Record<string, RateSnapshotProvenanceEntry> = {};

  for (const code of Object.keys(FICTIONAL_MOCK_RATES)) {
    cleanProvenance[code] = {
      sourceId: 'mock-local',
      sourceName: 'Local Mock Provider',
      timestamp,
    };
  }

  return {
    version: 1,
    providerId: 'mock-snapshot',
    providerName: 'Build-Time Mock Snapshot',
    baseAsset: 'USD',
    timestamp,
    isMock: true,
    rates: Object.freeze(cleanRates),
    provenance: Object.freeze(cleanProvenance),
  };
}
