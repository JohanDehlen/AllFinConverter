/**
 * AllFinConverter Rate Engine Service
 *
 * Provider-neutral rate engine responsible for:
 * 1. Managing rate provider registration and active provider selection.
 * 2. Ingesting raw rate payloads and applying strict validation rules.
 * 3. Enforcing canonical asset validation against assets.ts.
 * 4. Tracking dataset freshness ('fresh' | 'stale' | 'unavailable').
 * 5. Maintaining current and last-known-good (LKG) datasets for fault tolerance.
 * 6. Safely exposing rate lookups to the converter without leaking provider details.
 */

import Big from 'big.js';
import { getAsset } from './assets.ts';
import type { RateProvider } from './rateProviders.ts';
import {
  type NormalizedRateDataset,
  type RawRatePayload,
  type DatasetValidationResult,
  type RawRateEntry,
  type RateDatasetStatusInfo,
  DEFAULT_FRESHNESS_THRESHOLD_MS,
  evaluateDatasetFreshness,
} from './rates.ts';
import { defaultMockProvider } from './providers/mockProvider.ts';

/**
 * Custom error class for rate engine operational failures.
 */
export class RateEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateEngineError';
  }
}

/**
 * Validates and normalizes a raw rate payload from any provider.
 *
 * Strict financial validation rules:
 * 1. Payload structure must be an object with valid provider metadata.
 * 2. Payload timestamp must be a valid, positive finite number.
 * 3. Base asset must be USD (code 'USD') and its rate must be exactly 1.
 * 4. Every asset code must exist in the authoritative asset registry (assets.ts).
 * 5. Every rate value must be a valid, finite, positive number (> 0).
 * 6. NaN, Infinity, zero, and negative values are strictly rejected.
 * 7. Duplicate asset codes within payload are detected and rejected.
 */
export function validateRatePayload(payload: RawRatePayload | null | undefined): DatasetValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!payload || typeof payload !== 'object') {
    return {
      valid: false,
      errors: ['Payload is missing or malformed.'],
      warnings: [],
    };
  }

  if (!payload.providerId || typeof payload.providerId !== 'string') {
    errors.push('Payload missing valid providerId.');
  }

  // Timestamp validation
  let timestamp = payload.timestamp;
  if (timestamp !== undefined) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      errors.push(`Payload timestamp is invalid (must be a positive number; got ${String(timestamp)}).`);
    }
  } else {
    // If not provided, payload is missing timestamp
    errors.push('Payload missing dataset timestamp.');
  }

  const rawEntries: RawRateEntry[] = [];
  if (Array.isArray(payload.rates)) {
    const seenCodes = new Set<string>();
    for (const item of payload.rates) {
      if (!item || typeof item !== 'object' || !item.code) {
        warnings.push('Malformed rate entry encountered in array payload.');
        continue;
      }
      const normCode = item.code.trim().toUpperCase();
      if (seenCodes.has(normCode)) {
        errors.push(`Duplicate asset code '${normCode}' detected in payload.`);
      } else {
        seenCodes.add(normCode);
        rawEntries.push({ code: normCode, rate: item.rate });
      }
    }
  } else if (payload.rates && typeof payload.rates === 'object') {
    for (const [code, rate] of Object.entries(payload.rates)) {
      rawEntries.push({ code: code.trim().toUpperCase(), rate });
    }
  } else {
    return {
      valid: false,
      errors: ['Payload rates property must be an object or array.'],
      warnings: [],
    };
  }

  const validatedRates = new Map<string, Big>();

  for (const { code, rate } of rawEntries) {
    // 1. Authoritative asset registry check
    const assetMeta = getAsset(code);
    if (!assetMeta) {
      warnings.push(`Asset '${code}' rejected: Not registered in authoritative asset model.`);
      continue;
    }

    // 2. Number parsing and validation
    let bigRate: Big;
    try {
      if (rate === null || rate === undefined || rate === '') {
        warnings.push(`Asset '${code}' rejected: Empty or null rate value.`);
        continue;
      }

      if (typeof rate === 'number' && (!Number.isFinite(rate) || Number.isNaN(rate))) {
        warnings.push(`Asset '${code}' rejected: Rate is NaN or Infinity.`);
        continue;
      }

      bigRate = rate instanceof Big ? rate : new Big(rate.toString().trim());
    } catch {
      warnings.push(`Asset '${code}' rejected: Rate '${String(rate)}' is not a valid number.`);
      continue;
    }

    // 3. Positive value check
    if (bigRate.lte(0)) {
      warnings.push(`Asset '${code}' rejected: Rate must be strictly positive (got ${bigRate.toFixed()}).`);
      continue;
    }

    validatedRates.set(code, bigRate);
  }

  // 4. USD Base validation
  const usdRate = validatedRates.get('USD');
  if (!usdRate) {
    errors.push("Dataset rejected: Missing mandatory base asset 'USD'.");
  } else if (!usdRate.eq(1)) {
    errors.push(`Dataset rejected: Base asset 'USD' rate must equal exactly 1 (got ${usdRate.toFixed()}).`);
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings,
    };
  }

  const dataset: NormalizedRateDataset = {
    providerId: payload.providerId,
    providerName: payload.providerName || payload.providerId,
    baseAsset: 'USD',
    timestamp: timestamp!,
    rates: validatedRates,
    isMock: Boolean(payload.isMock),
  };

  return {
    valid: true,
    dataset,
    errors: [],
    warnings,
  };
}

/**
 * Rate Engine manages providers, validates incoming data, tracks freshness,
 * and maintains last-known-good datasets in memory.
 */
export class RateEngine {
  private providers = new Map<string, RateProvider>();
  private activeProviderId: string;
  private currentDataset: NormalizedRateDataset | null = null;
  private lastKnownGoodDataset: NormalizedRateDataset | null = null;
  private freshnessThresholdMs: number = DEFAULT_FRESHNESS_THRESHOLD_MS;
  private isFallbackToLkg = false;
  private lastError: string | null = null;

  constructor(
    defaultProvider: RateProvider = defaultMockProvider,
    freshnessThresholdMs: number = DEFAULT_FRESHNESS_THRESHOLD_MS
  ) {
    this.freshnessThresholdMs = freshnessThresholdMs;
    this.registerProvider(defaultProvider);
    this.activeProviderId = defaultProvider.id;
    this.loadFromProvider(defaultProvider);
  }

  /**
   * Registers a rate provider with the engine.
   */
  registerProvider(provider: RateProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Sets the active provider and ingests its rates.
   */
  setActiveProvider(providerId: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new RateEngineError(`Rate provider '${providerId}' is not registered.`);
    }
    this.activeProviderId = providerId;
    this.loadFromProvider(provider);
  }

  /**
   * Ingests and validates a raw rate payload.
   * On valid payload: Updates current and last-known-good datasets.
   * On invalid payload: Rejects update, retains last-known-good dataset if available.
   */
  ingestPayload(payload: RawRatePayload | null | undefined): DatasetValidationResult {
    const validation = validateRatePayload(payload);

    if (validation.valid && validation.dataset) {
      this.currentDataset = validation.dataset;
      this.lastKnownGoodDataset = validation.dataset;
      this.isFallbackToLkg = false;
      this.lastError = null;
      return validation;
    }

    // Invalid payload handling
    this.lastError = validation.errors.join('; ');

    if (this.lastKnownGoodDataset) {
      // Retain last-known-good dataset without corruption
      this.currentDataset = this.lastKnownGoodDataset;
      this.isFallbackToLkg = true;
    } else {
      this.currentDataset = null;
      this.isFallbackToLkg = false;
    }

    return validation;
  }

  /**
   * Loads rates from a provider.
   */
  private loadFromProvider(provider: RateProvider): void {
    const raw = provider.getRates();
    if (raw instanceof Promise) {
      throw new RateEngineError('Asynchronous provider loading must use loadFromProviderAsync.');
    }

    const validation = this.ingestPayload(raw);
    if (!validation.valid && !this.lastKnownGoodDataset) {
      throw new RateEngineError(
        `Failed to load rates from '${provider.id}': ${validation.errors.join(', ')}`
      );
    }
  }

  /**
   * Ingests an external validated dataset directly.
   */
  setDataset(dataset: NormalizedRateDataset): void {
    const usd = dataset.rates.get('USD');
    if (!usd || !usd.eq(1)) {
      throw new RateEngineError("Cannot set dataset: Missing or invalid 'USD' base rate.");
    }
    this.currentDataset = dataset;
    this.lastKnownGoodDataset = dataset;
    this.isFallbackToLkg = false;
    this.lastError = null;
  }

  /**
   * Retrieves the current normalized rate (units per 1 USD) for an asset.
   * Throws RateEngineError if no dataset is loaded or asset code is unknown.
   */
  getRate(assetCode: string): Big {
    if (!this.currentDataset) {
      throw new RateEngineError(
        `Rate unavailable for '${assetCode}': No valid rate dataset is currently loaded.`
      );
    }

    const code = assetCode.trim().toUpperCase();
    const rate = this.currentDataset.rates.get(code);
    if (!rate) {
      throw new RateEngineError(
        `Asset code '${assetCode}' not found in active rate dataset (${this.currentDataset.providerName}).`
      );
    }
    return rate;
  }

  /**
   * Checks whether a rate is available for the given asset code.
   */
  hasRate(assetCode: string): boolean {
    if (!this.currentDataset) return false;
    return this.currentDataset.rates.has(assetCode.trim().toUpperCase());
  }

  /**
   * Returns the current active dataset or throws if unavailable.
   */
  getDataset(): NormalizedRateDataset {
    if (!this.currentDataset) {
      throw new RateEngineError('No active rate dataset is currently available.');
    }
    return this.currentDataset;
  }

  /**
   * Returns the current active dataset or null if unavailable.
   */
  getDatasetOrNull(): NormalizedRateDataset | null {
    return this.currentDataset;
  }

  /**
   * Returns the retained last-known-good dataset, if one exists.
   */
  getLastKnownGoodDataset(): NormalizedRateDataset | null {
    return this.lastKnownGoodDataset;
  }

  /**
   * Returns comprehensive status and freshness info for the active dataset.
   */
  getStatus(now?: number): RateDatasetStatusInfo {
    return evaluateDatasetFreshness(
      this.currentDataset,
      now,
      this.freshnessThresholdMs,
      this.isFallbackToLkg,
      this.lastError ?? undefined
    );
  }

  /**
   * Returns true if a usable rate dataset is currently loaded.
   */
  isAvailable(): boolean {
    return Boolean(this.currentDataset && this.currentDataset.rates.size > 0);
  }

  /**
   * Returns true if the active dataset is within the freshness threshold.
   */
  isFresh(now?: number): boolean {
    return this.getStatus(now).status === 'fresh';
  }

  /**
   * Returns true if the active dataset is older than the freshness threshold.
   */
  isStale(now?: number): boolean {
    return this.getStatus(now).status === 'stale';
  }

  /**
   * Sets the freshness threshold in milliseconds.
   */
  setFreshnessThreshold(thresholdMs: number): void {
    if (thresholdMs <= 0) {
      throw new RateEngineError('Freshness threshold must be a positive number of milliseconds.');
    }
    this.freshnessThresholdMs = thresholdMs;
  }

  /**
   * Returns the configured freshness threshold in milliseconds.
   */
  getFreshnessThreshold(): number {
    return this.freshnessThresholdMs;
  }

  /**
   * Returns the identifier of the current active provider.
   */
  getActiveProviderId(): string {
    return this.activeProviderId;
  }

  /**
   * Indicates whether the active dataset contains mock/demo data.
   */
  isMock(): boolean {
    return Boolean(this.currentDataset?.isMock);
  }

  /**
   * Clears the engine state (primarily used for unit testing unavailable scenarios).
   */
  clear(): void {
    this.currentDataset = null;
    this.lastKnownGoodDataset = null;
    this.isFallbackToLkg = false;
    this.lastError = null;
  }
}

/**
 * Singleton instance of the RateEngine initialized with the default mock provider.
 */
export const defaultRateEngine = new RateEngine();

/**
 * Direct lookup helper for converter and calculations.
 * Returns normalized rate (units per 1 USD) for an asset code.
 */
export function getRate(assetCode: string): Big {
  return defaultRateEngine.getRate(assetCode);
}

/**
 * Checks if a rate is available for the given asset code.
 */
export function hasRate(assetCode: string): boolean {
  return defaultRateEngine.hasRate(assetCode);
}

/**
 * Returns the current active validated rate dataset.
 */
export function getActiveDataset(): NormalizedRateDataset {
  return defaultRateEngine.getDataset();
}

/**
 * Returns the status of the active rate engine dataset.
 */
export function getRateEngineStatus(now?: number): RateDatasetStatusInfo {
  return defaultRateEngine.getStatus(now);
}

/**
 * Returns true if the rate engine has a usable dataset available.
 */
export function isRateEngineAvailable(): boolean {
  return defaultRateEngine.isAvailable();
}
