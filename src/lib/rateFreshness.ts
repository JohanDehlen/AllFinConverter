import Big from 'big.js';
import { getSupportedAssets } from './assets.ts';
import { AED_USD_PEG_RATE_STR } from './providers/fixedPegProvider.ts';

export const MAX_FRANKFURTER_RATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_COINMARKETCAP_RATE_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_GOLD_API_RATE_AGE_MS = 96 * 60 * 60 * 1000;

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const KNOWN_SOURCE_IDS = new Set(['frankfurter', 'coinmarketcap', 'goldapi', 'fixed-peg']);

export interface RateFreshnessProvenance {
  readonly sourceId: string;
  readonly timestamp: number;
}

export interface RateFreshnessOptions {
  readonly now?: number;
  readonly maxGoldApiAgeMs?: number;
}

export interface RateFreshnessResult {
  readonly fresh: boolean;
  readonly errors: readonly string[];
}

/**
 * Evaluates every canonical rate against the freshness policy for its source.
 */
export function evaluateRateFreshness(
  rates: Readonly<Record<string, string | number>>,
  provenance: Readonly<Record<string, RateFreshnessProvenance>>,
  options?: RateFreshnessOptions
): RateFreshnessResult {
  const now = options?.now ?? Date.now();
  const maxGoldApiAgeMs = options?.maxGoldApiAgeMs ?? DEFAULT_MAX_GOLD_API_RATE_AGE_MS;
  const errors: string[] = [];

  if (!Number.isFinite(now)) {
    return { fresh: false, errors: ['Freshness reference time is invalid.'] };
  }
  if (!Number.isFinite(maxGoldApiAgeMs) || maxGoldApiAgeMs <= 0) {
    return { fresh: false, errors: ['Gold-API maximum age must be a positive finite number.'] };
  }

  for (const asset of getSupportedAssets()) {
    const rawRate = rates[asset.code];
    const source = provenance[asset.code];
    if (rawRate === undefined || !source || typeof source !== 'object') {
      errors.push(`Missing required rate or provenance for ${asset.code}.`);
      continue;
    }

    if (
      typeof source.sourceId !== 'string' ||
      !KNOWN_SOURCE_IDS.has(source.sourceId) ||
      typeof source.timestamp !== 'number' ||
      !Number.isFinite(source.timestamp) ||
      source.timestamp <= 0
    ) {
      errors.push(`Invalid or unknown provenance for ${asset.code}.`);
      continue;
    }

    let rate: Big;
    try {
      rate = new Big(String(rawRate));
    } catch {
      errors.push(`Invalid rate value for ${asset.code}.`);
      continue;
    }

    if (!rate.gt(0)) {
      errors.push(`Rate for ${asset.code} must be positive.`);
      continue;
    }

    if (asset.code === 'USD') {
      if (!rate.eq(1)) errors.push("USD base rate must equal exactly 1.");
      continue;
    }

    if (asset.code === 'AED') {
      if (source.sourceId !== 'fixed-peg') {
        errors.push('AED provenance must identify the fixed-peg provider.');
      }
      if (!rate.eq(AED_USD_PEG_RATE_STR)) {
        errors.push(`AED rate must equal the configured fixed peg of ${AED_USD_PEG_RATE_STR}.`);
      }
      continue;
    }

    const expectedSource =
      asset.category === 'fiat'
        ? 'frankfurter'
        : asset.category === 'crypto'
          ? 'coinmarketcap'
          : 'goldapi';
    if (source.sourceId !== expectedSource) {
      errors.push(`Unexpected source '${source.sourceId}' for ${asset.code}; expected '${expectedSource}'.`);
      continue;
    }

    if (source.timestamp - now > MAX_FUTURE_SKEW_MS) {
      errors.push(`Provenance timestamp for ${asset.code} is too far in the future.`);
      continue;
    }

    const maxAgeMs =
      source.sourceId === 'frankfurter'
        ? MAX_FRANKFURTER_RATE_AGE_MS
        : source.sourceId === 'coinmarketcap'
          ? MAX_COINMARKETCAP_RATE_AGE_MS
          : maxGoldApiAgeMs;
    const ageMs = Math.max(0, now - source.timestamp);
    if (ageMs > maxAgeMs) {
      errors.push(`Rate for ${asset.code} is stale (${Math.round(ageMs / 1000)}s old).`);
    }
  }

  return { fresh: errors.length === 0, errors };
}
