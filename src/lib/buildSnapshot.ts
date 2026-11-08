/**
 * Build-Time Snapshot Loader
 *
 * Shared utility for loading and validating the production rate snapshot
 * at Astro build time (SSG). Used by both the interactive Converter component
 * and the pair-page Pair Overview section to ensure consistent rate sourcing
 * and honest labelling (live vs demo).
 *
 * This module is intended for Node.js server-side execution during `astro build`
 * and must never be imported in client-side bundles.
 */

import fs from 'node:fs';
import path from 'node:path';
import { RateEngine } from './rateEngine.ts';
import { validateRateSnapshot, type RateSnapshotPayload } from './rateSnapshot.ts';

/**
 * Result of attempting to load the build-time rate snapshot.
 */
export interface BuildSnapshotResult {
  /** A RateEngine loaded with snapshot rates, or undefined if unavailable */
  readonly engine: RateEngine | undefined;
  /** Whether the loaded snapshot represents live (non-mock) production data */
  readonly isLive: boolean;
  /** Snapshot timestamp in epoch ms, or null if unavailable */
  readonly timestamp: number | null;
  /** The validated snapshot payload, or null if unavailable */
  readonly payload: RateSnapshotPayload | null;
}

/**
 * Attempts to load and validate the production rate snapshot from disk.
 *
 * Returns a result indicating whether live rates are available. If the snapshot
 * is missing, invalid, or contains mock data, returns a safe fallback result
 * with `isLive: false`.
 *
 * This function never throws — all errors are caught and produce the fallback result.
 */
export function loadBuildSnapshot(): BuildSnapshotResult {
  const fallback: BuildSnapshotResult = {
    engine: undefined,
    isLive: false,
    timestamp: null,
    payload: null,
  };

  const snapshotPath = path.resolve(process.cwd(), 'src/data/latestSnapshot.json');

  if (!fs.existsSync(snapshotPath)) {
    return fallback;
  }

  try {
    const rawContent = fs.readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(rawContent);
    const validated = validateRateSnapshot(parsed);

    const engine = new RateEngine();
    const result = engine.ingestPayload({
      providerId: validated.providerId,
      providerName: validated.providerName,
      timestamp: validated.timestamp,
      rates: validated.rates,
    });

    if (result.valid) {
      return {
        engine,
        isLive: !validated.isMock,
        timestamp: validated.timestamp,
        payload: validated,
      };
    }
  } catch {
    // If snapshot loading or validation fails, return fallback
  }

  return fallback;
}
