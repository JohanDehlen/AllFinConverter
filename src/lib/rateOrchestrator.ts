/**
 * AllFinConverter Multi-Provider Rate Orchestrator
 *
 * Coordinates multiple registered RateProvider adapters, manages independent
 * provider lifecycles and last-known-good (LKG) datasets, resolves out-of-order
 * asynchronous refresh races, and combines partial datasets via mergeSourceDatasets().
 *
 * Design principles:
 * 1. Independent provider lifecycles: One provider's failure (network, HTTP, validation)
 *    never discards or blocks valid data from other providers.
 * 2. Strict pre-merge validation: Every provider payload is validated with validateRatePayload()
 *    before updating LKG or being submitted for composite merge.
 * 3. Last-known-good retention: Failed or invalid refreshes preserve the provider's
 *    prior LKG dataset.
 * 4. Race-condition / out-of-order defense: Monotonic sequence tracking and dataset timestamp
 *    guards ensure older asynchronous results never overwrite newer successful results.
 * 5. Deterministic conflict resolution: Duplicate assets across providers resolve
 *    by timestamp (newest wins), then priority, then array registration order.
 * 6. Explicit execution: Registration and refresh are strictly explicit. Zero background
 *    timers, zero implicit network requests, and zero live requests on import or build.
 */

import type { RateProvider } from './rateProviders.ts';
import type { NormalizedRateDataset, RawRatePayload, DatasetValidationResult } from './rates.ts';
import { validateRatePayload, type RateEngine } from './rateEngine.ts';
import {
  mergeSourceDatasets,
  type SourceDataset,
  type CompositeAssemblyResult,
} from './compositeRates.ts';

/**
 * Configuration options for registering a rate provider with the orchestrator.
 */
export interface OrchestratorProviderOptions {
  /**
   * Priority hint for conflict resolution when multiple providers supply the same asset
   * at the exact same timestamp. Higher values win. Default: 0.
   */
  readonly priority?: number;
  /**
   * Whether this provider is enabled for refresh cycles. Default: true.
   */
  readonly enabled?: boolean;
}

/**
 * State record tracked per registered provider.
 */
export interface OrchestratedProviderState {
  readonly provider: RateProvider;
  readonly priority: number;
  readonly enabled: boolean;
  readonly lastKnownGoodDataset: NormalizedRateDataset | null;
  readonly lastError: string | null;
  readonly lastRefreshTimestamp?: number;
  readonly refreshCount: number;
}

/**
 * Summary result returned by refreshAll().
 */
export interface OrchestratorRefreshResult {
  /** True if all enabled providers refreshed successfully without errors */
  readonly success: boolean;
  /** The resulting composite dataset and provenance metadata */
  readonly composite: CompositeAssemblyResult;
  /** Map of providerId -> error message for providers that encountered failures */
  readonly providerErrors: ReadonlyMap<string, string>;
  /** Number of providers that successfully supplied fresh datasets this cycle */
  readonly successfulRefreshes: number;
  /** Number of providers that failed this cycle */
  readonly failedRefreshes: number;
}

/**
 * Configuration options for the RateOrchestrator.
 */
export interface RateOrchestratorOptions {
  /** Composite dataset ID passed to mergeSourceDatasets. Default: 'composite' */
  readonly compositeId?: string;
  /** Composite dataset display name. Default: 'Composite Provider' */
  readonly compositeName?: string;
  /** Optional RateEngine instance to synchronize with composite results */
  readonly rateEngine?: RateEngine;
}

interface InternalProviderEntry {
  provider: RateProvider;
  priority: number;
  enabled: boolean;
  lastKnownGoodDataset: NormalizedRateDataset | null;
  lastError: string | null;
  lastRefreshTimestamp?: number;
  refreshCount: number;
  /** Monotonic sequence counter to guard against out-of-order async resolution */
  activeRequestId: number;
  /** Sequence number of the latest successfully applied refresh */
  latestAppliedRequestId: number;
}

/**
 * Multi-provider rate orchestrator.
 */
export class RateOrchestrator {
  private readonly providers = new Map<string, InternalProviderEntry>();
  private readonly compositeId: string;
  private readonly compositeName: string;
  private readonly rateEngine?: RateEngine;
  private latestComposite: CompositeAssemblyResult | null = null;

  constructor(options?: RateOrchestratorOptions) {
    this.compositeId = options?.compositeId ?? 'composite';
    this.compositeName = options?.compositeName ?? 'Composite Provider';
    this.rateEngine = options?.rateEngine;
  }

  /**
   * Registers a rate provider with the orchestrator.
   * If a provider with the same ID is already registered, its configuration is updated
   * while preserving its existing last-known-good dataset.
   */
  registerProvider(provider: RateProvider, options?: OrchestratorProviderOptions): void {
    const existing = this.providers.get(provider.id);
    const priority = options?.priority ?? existing?.priority ?? 0;
    const enabled = options?.enabled ?? existing?.enabled ?? true;

    this.providers.set(provider.id, {
      provider,
      priority,
      enabled,
      lastKnownGoodDataset: existing?.lastKnownGoodDataset ?? null,
      lastError: existing?.lastError ?? null,
      lastRefreshTimestamp: existing?.lastRefreshTimestamp,
      refreshCount: existing?.refreshCount ?? 0,
      activeRequestId: existing?.activeRequestId ?? 0,
      latestAppliedRequestId: existing?.latestAppliedRequestId ?? 0,
    });
  }

  /**
   * Unregisters a provider by its ID.
   * Returns true if the provider was found and removed.
   */
  unregisterProvider(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  /**
   * Enables or disables a registered provider.
   */
  setProviderEnabled(providerId: string, enabled: boolean): void {
    const entry = this.providers.get(providerId);
    if (!entry) {
      throw new Error(`Cannot set enabled: Provider '${providerId}' is not registered.`);
    }
    entry.enabled = enabled;
  }

  /**
   * Returns state information for a specific registered provider.
   */
  getProviderState(providerId: string): OrchestratedProviderState | undefined {
    const entry = this.providers.get(providerId);
    if (!entry) return undefined;
    return {
      provider: entry.provider,
      priority: entry.priority,
      enabled: entry.enabled,
      lastKnownGoodDataset: entry.lastKnownGoodDataset,
      lastError: entry.lastError,
      lastRefreshTimestamp: entry.lastRefreshTimestamp,
      refreshCount: entry.refreshCount,
    };
  }

  /**
   * Returns state records for all registered providers.
   */
  getAllProviderStates(): readonly OrchestratedProviderState[] {
    return [...this.providers.values()].map((entry) => ({
      provider: entry.provider,
      priority: entry.priority,
      enabled: entry.enabled,
      lastKnownGoodDataset: entry.lastKnownGoodDataset,
      lastError: entry.lastError,
      lastRefreshTimestamp: entry.lastRefreshTimestamp,
      refreshCount: entry.refreshCount,
    }));
  }

  /**
   * Refreshes a single registered provider asynchronously.
   *
   * Protection mechanisms:
   * 1. Request sequence guards: Out-of-order async resolutions from older requests are dropped.
   * 2. Timestamp guards: A dataset with an older timestamp than existing LKG is ignored.
   * 3. Pre-merge validation: Invalid/empty payloads fail validation and do not corrupt LKG.
   * 4. Safe error catching: Network/timeout errors record an error message without throwing.
   */
  async refreshProvider(providerId: string): Promise<DatasetValidationResult> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      return {
        valid: false,
        errors: [`Provider '${providerId}' is not registered with the orchestrator.`],
        warnings: [],
      };
    }

    const currentRequestId = ++entry.activeRequestId;

    let rawPayload: RawRatePayload;
    try {
      rawPayload = await entry.provider.getRates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorMessage = `Fetch failed for '${providerId}': ${message}`;

      // Out-of-order check: do not overwrite error or timestamp if a newer request already applied
      if (currentRequestId >= entry.latestAppliedRequestId) {
        entry.lastError = errorMessage;
        entry.lastRefreshTimestamp = Date.now();
      }

      return {
        valid: false,
        errors: [errorMessage],
        warnings: [],
      };
    }

    // Guard against out-of-order completion:
    // If a newer request already completed while this one was in flight, discard this result
    if (currentRequestId < entry.latestAppliedRequestId) {
      return {
        valid: false,
        errors: [`Discarded out-of-order refresh result for '${providerId}' (request #${currentRequestId} superseded by #${entry.latestAppliedRequestId}).`],
        warnings: [],
      };
    }

    // Validate the raw payload
    const validation = validateRatePayload(rawPayload);

    if (!validation.valid || !validation.dataset) {
      entry.lastError = `Validation failed for '${providerId}': ${validation.errors.join('; ')}`;
      entry.lastRefreshTimestamp = Date.now();
      return validation;
    }

    // Guard against older dataset timestamp overwriting newer LKG data
    if (entry.lastKnownGoodDataset && validation.dataset.timestamp < entry.lastKnownGoodDataset.timestamp) {
      entry.lastError = `Ignored older dataset for '${providerId}' (${validation.dataset.timestamp} < current LKG ${entry.lastKnownGoodDataset.timestamp}).`;
      entry.lastRefreshTimestamp = Date.now();
      return {
        valid: false,
        errors: [entry.lastError],
        warnings: validation.warnings,
      };
    }

    // Successful update
    entry.lastKnownGoodDataset = validation.dataset;
    entry.lastError = null;
    entry.lastRefreshTimestamp = Date.now();
    entry.refreshCount++;
    entry.latestAppliedRequestId = currentRequestId;

    return validation;
  }

  /**
   * Refreshes all enabled registered providers concurrently.
   *
   * Fault-tolerance guarantees:
   * - Each provider is queried independently; one failure never aborts others.
   * - Providers that fail retain their last-known-good dataset.
   * - All available datasets (fresh updates + retained LKGs) are merged into a composite.
   * - If configured with a RateEngine, the new composite is automatically synchronized.
   */
  async refreshAll(): Promise<OrchestratorRefreshResult> {
    const enabledEntries = [...this.providers.values()].filter((e) => e.enabled);
    const providerErrors = new Map<string, string>();
    let successfulRefreshes = 0;
    let failedRefreshes = 0;

    // Fetch all enabled providers concurrently and independently
    const results = await Promise.allSettled(
      enabledEntries.map(async (entry) => {
        const validation = await this.refreshProvider(entry.provider.id);
        return { providerId: entry.provider.id, validation };
      })
    );

    for (const res of results) {
      if (res.status === 'fulfilled') {
        const { providerId, validation } = res.value;
        if (validation.valid) {
          successfulRefreshes++;
        } else {
          failedRefreshes++;
          providerErrors.set(providerId, validation.errors.join('; '));
        }
      } else {
        // Promise.allSettled caught unexpected rejection
        failedRefreshes++;
        const message = res.reason instanceof Error ? res.reason.message : String(res.reason);
        providerErrors.set('unknown', message);
      }
    }

    // Assemble composite dataset from all available valid LKG datasets
    const composite = this.assembleComposite();

    return {
      success: failedRefreshes === 0,
      composite,
      providerErrors,
      successfulRefreshes,
      failedRefreshes,
    };
  }

  /**
   * Assembles a composite dataset from all enabled providers' current LKG datasets.
   * Does NOT perform any network requests.
   * If a RateEngine is attached and assembly produces a valid dataset, syncs to the engine.
   */
  assembleComposite(): CompositeAssemblyResult {
    const sourcesToMerge: SourceDataset[] = [];

    for (const entry of this.providers.values()) {
      if (!entry.enabled) continue;
      if (!entry.lastKnownGoodDataset) continue;

      sourcesToMerge.push({
        dataset: entry.lastKnownGoodDataset,
        priority: entry.priority,
      });
    }

    const result = mergeSourceDatasets(sourcesToMerge, this.compositeId, this.compositeName);
    this.latestComposite = result;

    // Sync to attached RateEngine if composite produced a valid dataset
    if (this.rateEngine && result.dataset) {
      this.rateEngine.setDataset(result.dataset);
    }

    return result;
  }

  /**
   * Returns the latest assembled composite result, or null if assembleComposite() has not been run.
   */
  getLatestComposite(): CompositeAssemblyResult | null {
    return this.latestComposite;
  }

  /**
   * Returns the attached RateEngine, if one was provided in the constructor.
   */
  getRateEngine(): RateEngine | undefined {
    return this.rateEngine;
  }

  /**
   * Clears all provider LKGs and error states (primarily for testing).
   */
  clear(): void {
    for (const entry of this.providers.values()) {
      entry.lastKnownGoodDataset = null;
      entry.lastError = null;
      entry.lastRefreshTimestamp = undefined;
      entry.refreshCount = 0;
      entry.activeRequestId = 0;
      entry.latestAppliedRequestId = 0;
    }
    this.latestComposite = null;
  }
}
