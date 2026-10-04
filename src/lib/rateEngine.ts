/**
 * WorthPair Rate Engine Service
 *
 * Provider-neutral rate engine responsible for:
 * 1. Managing rate provider registration and active provider selection.
 * 2. Ingesting raw rate payloads and applying strict validation rules.
 * 3. Enforcing canonical asset validation against assets.ts.
 * 4. Storing and exposing verified normalized rate datasets to the converter.
 * 5. Isolating provider specifics from UI layers.
 */

import Big from 'big.js';
import { getAsset } from './assets';
import type { RateProvider } from './rateProviders';
import type {
  NormalizedRateDataset,
  RawRatePayload,
  DatasetValidationResult,
  RawRateEntry,
} from './rates';
import { defaultMockProvider } from './providers/mockProvider';

/**
 * Validates and normalizes a raw rate payload from any provider.
 *
 * Strict financial validation rules:
 * 1. Payload structure must be an object with valid provider metadata.
 * 2. Base asset must be USD (code 'USD') and its rate must be exactly 1.
 * 3. Every asset code must exist in the authoritative asset registry (assets.ts).
 * 4. Every rate value must be a valid, finite, positive number (> 0).
 * 5. NaN, Infinity, zero, and negative values are strictly rejected.
 * 6. Duplicate asset codes within payload are detected and rejected.
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
    timestamp: payload.timestamp || Date.now(),
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
 * Rate Engine manages providers and holds the active validated rate dataset.
 */
export class RateEngine {
  private providers = new Map<string, RateProvider>();
  private activeProviderId: string;
  private currentDataset: NormalizedRateDataset;

  constructor(defaultProvider: RateProvider = defaultMockProvider) {
    this.registerProvider(defaultProvider);
    this.activeProviderId = defaultProvider.id;
    this.currentDataset = this.loadFromProvider(defaultProvider);
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
      throw new Error(`Rate provider '${providerId}' is not registered.`);
    }
    this.activeProviderId = providerId;
    this.currentDataset = this.loadFromProvider(provider);
  }

  /**
   * Loads and validates rates synchronously from a provider.
   */
  private loadFromProvider(provider: RateProvider): NormalizedRateDataset {
    const raw = provider.getRates();
    if (raw instanceof Promise) {
      throw new Error('Asynchronous provider loading must use loadFromProviderAsync.');
    }

    const validation = validateRatePayload(raw);
    if (!validation.valid || !validation.dataset) {
      throw new Error(`Failed to load rates from '${provider.id}': ${validation.errors.join(', ')}`);
    }

    return validation.dataset;
  }

  /**
   * Ingests an external validated dataset directly.
   */
  setDataset(dataset: NormalizedRateDataset): void {
    const usd = dataset.rates.get('USD');
    if (!usd || !usd.eq(1)) {
      throw new Error("Cannot set dataset: Missing or invalid 'USD' base rate.");
    }
    this.currentDataset = dataset;
  }

  /**
   * Retrieves the current normalized rate (units per 1 USD) for an asset.
   * Throws an Error if the asset code is unknown or missing from the current dataset.
   */
  getRate(assetCode: string): Big {
    const code = assetCode.trim().toUpperCase();
    const rate = this.currentDataset.rates.get(code);
    if (!rate) {
      throw new Error(`Asset code '${assetCode}' not found in active rate dataset.`);
    }
    return rate;
  }

  /**
   * Checks whether a rate is available for the given asset code.
   */
  hasRate(assetCode: string): boolean {
    return this.currentDataset.rates.has(assetCode.trim().toUpperCase());
  }

  /**
   * Returns the complete active validated dataset.
   */
  getDataset(): NormalizedRateDataset {
    return this.currentDataset;
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
    return this.currentDataset.isMock;
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
