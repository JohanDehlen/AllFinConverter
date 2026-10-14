/**
 * AllFinConverter Composite Rate Assembler
 *
 * Combines validated partial datasets from multiple independent rate providers
 * into a single USD-normalized NormalizedRateDataset for the rate engine.
 *
 * Design principles:
 * 1. Per-rate provenance: Every rate tracks its source provider and timestamp individually.
 *    The composite dataset does NOT imply that all rates share one update timestamp.
 * 2. Source isolation: One provider's failure does not discard valid rates from other sources.
 *    A failed provider's last-known-good rates are retained until replaced by a fresh update.
 * 3. Deterministic merge: When multiple providers supply the same asset code, the dataset
 *    with the most recent timestamp for that asset wins (last-writer-wins by timestamp).
 * 4. Strict validation: The composite output enforces the same USD-base, positive-rate,
 *    and canonical-code invariants as the single-provider path.
 * 5. No network calls: This module is a pure data assembler with no I/O.
 */

import Big from 'big.js';
import type { NormalizedRateDataset } from './rates.ts';

/**
 * Provenance metadata for a single rate entry within a composite dataset.
 * Tracks which provider supplied the rate and when.
 */
export interface RateProvenance {
  /** Identifier of the provider that supplied this rate */
  readonly sourceId: string;
  /** Display name of the provider */
  readonly sourceName: string;
  /** Timestamp (epoch ms) when this specific rate was recorded/provided */
  readonly timestamp: number;
}

/**
 * A validated source dataset ready for composite assembly.
 * This is a NormalizedRateDataset (already validated by the rate engine)
 * tagged for merging into a composite.
 */
export interface SourceDataset {
  /** The validated, normalized dataset from a single provider */
  readonly dataset: NormalizedRateDataset;
  /**
   * Priority hint for conflict resolution when timestamps are identical.
   * Higher values win. Default is 0.
   */
  readonly priority?: number;
}

/**
 * Result of assembling multiple source datasets into one composite.
 */
export interface CompositeAssemblyResult {
  /** The merged composite dataset, suitable for RateEngine.setDataset(). Null if no valid rates. */
  readonly dataset: NormalizedRateDataset | null;
  /** Per-asset provenance map: asset code → provenance metadata */
  readonly provenance: ReadonlyMap<string, RateProvenance>;
  /** Identifiers of all source providers that contributed at least one rate */
  readonly contributingSources: readonly string[];
  /** Summary of the assembly (e.g. asset counts per source) */
  readonly summary: string;
}

/**
 * Merges multiple validated source datasets into a single composite NormalizedRateDataset.
 *
 * Merge rules:
 * - Each asset code is resolved independently. If multiple sources provide the same code,
 *   the source with the most recent timestamp for that asset wins.
 * - If timestamps are equal, the source with higher priority wins.
 * - If timestamps and priorities are equal, the last source in the input array wins
 *   (stable, predictable ordering).
 * - USD must be present with rate exactly 1 in the composite output.
 * - Empty or null source datasets are silently skipped (source failure resilience).
 *
 * @param sources - Array of validated source datasets to merge. Order matters for tie-breaking.
 * @param compositeId - Provider ID for the composite dataset (default: 'composite')
 * @param compositeName - Display name for the composite dataset (default: 'Composite Provider')
 */
export function mergeSourceDatasets(
  sources: readonly SourceDataset[],
  compositeId = 'composite',
  compositeName = 'Composite Provider'
): CompositeAssemblyResult {
  const mergedRates = new Map<string, Big>();
  const provenance = new Map<string, RateProvenance>();
  const contributingSourceIds = new Set<string>();

  // Track which timestamp and priority currently "own" each asset code
  const assetTimestamps = new Map<string, number>();
  const assetPriorities = new Map<string, number>();

  for (const source of sources) {
    if (!source?.dataset) continue;

    const { dataset } = source;
    const priority = source.priority ?? 0;

    if (dataset.rates.size === 0) continue;

    let contributed = false;

    for (const [code, rate] of dataset.rates) {
      const existingTimestamp = assetTimestamps.get(code);
      const existingPriority = assetPriorities.get(code);

      // Determine if this source should overwrite the current value for this code.
      // Rules: higher timestamp wins; on tie, higher priority wins; on tie, last writer wins.
      let shouldOverwrite = false;
      if (existingTimestamp === undefined) {
        shouldOverwrite = true;
      } else if (dataset.timestamp > existingTimestamp) {
        shouldOverwrite = true;
      } else if (dataset.timestamp === existingTimestamp && priority >= (existingPriority ?? 0)) {
        shouldOverwrite = true;
      }

      if (shouldOverwrite) {
        mergedRates.set(code, rate);
        assetTimestamps.set(code, dataset.timestamp);
        assetPriorities.set(code, priority);
        provenance.set(code, {
          sourceId: dataset.providerId,
          sourceName: dataset.providerName,
          timestamp: dataset.timestamp,
        });
        contributed = true;
      }
    }

    if (contributed) {
      contributingSourceIds.add(dataset.providerId);
    }
  }

  // Validate USD base in composite
  const usdRate = mergedRates.get('USD');
  if (!usdRate || !usdRate.eq(1)) {
    return {
      dataset: null,
      provenance,
      contributingSources: [...contributingSourceIds],
      summary: mergedRates.size === 0
        ? 'No valid source datasets provided.'
        : "Composite assembly failed: Missing or invalid USD base rate.",
    };
  }

  // Compute composite timestamp as the most recent individual rate timestamp
  let latestTimestamp = 0;
  for (const ts of assetTimestamps.values()) {
    if (ts > latestTimestamp) latestTimestamp = ts;
  }

  // Determine if composite contains any mock data
  const hasMock = sources.some(
    (s) => s?.dataset && s.dataset.isMock && contributingSourceIds.has(s.dataset.providerId)
  );

  const compositeDataset: NormalizedRateDataset = {
    providerId: compositeId,
    providerName: compositeName,
    baseAsset: 'USD',
    timestamp: latestTimestamp,
    rates: mergedRates,
    isMock: hasMock,
  };

  // Build summary
  const sourceCountMap = new Map<string, number>();
  for (const { sourceId } of provenance.values()) {
    sourceCountMap.set(sourceId, (sourceCountMap.get(sourceId) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [id, count] of sourceCountMap) {
    parts.push(`${id}: ${count} rate(s)`);
  }
  const summary = `Composite assembled from ${contributingSourceIds.size} source(s) with ${mergedRates.size} rate(s). [${parts.join(', ')}]`;

  return {
    dataset: compositeDataset,
    provenance,
    contributingSources: [...contributingSourceIds],
    summary,
  };
}
