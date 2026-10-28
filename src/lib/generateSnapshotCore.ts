/**
 * AllFinConverter Production Rate Snapshot Generator Core
 *
 * Core service for generating, validating, and atomically persisting production rate snapshots.
 *
 * Safety Invariants:
 * 1. Must satisfy canonical RateSnapshotPayload schema and include all 19 canonical assets.
 * 2. All 4 providers (Frankfurter, Fixed Peg AED, CoinMarketCap, Gold-API) must succeed.
 * 3. Never publishes an incomplete snapshot.
 * 4. Never silently substitutes mock rates for failed live providers.
 * 5. Never labels mock data as live data (snapshot.isMock === false strictly enforced).
 * 6. If any provider fails, API key is missing, or rates are unavailable, fails clearly
 *    and leaves the existing snapshot completely untouched.
 * 7. Uses atomic write patterns (write to .tmp then rename) to prevent partial file corruption.
 * 8. Does NOT store historical price data (only the latest operational snapshot).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  createProductionRateOrchestrator,
  type ProductionOrchestratorOptions,
} from './productionOrchestrator.ts';
import {
  serializeRateSnapshot,
  validateRateSnapshot,
  type RateSnapshotPayload,
} from './rateSnapshot.ts';
import { getSupportedAssets } from './assets.ts';

/**
 * Standard relative file path where the latest production snapshot is stored.
 */
export const DEFAULT_SNAPSHOT_STORAGE_REL_PATH = 'src/data/latestSnapshot.json';

/**
 * Build output path where static distribution serves the snapshot.
 */
export const DEFAULT_DIST_SNAPSHOT_REL_PATH = 'dist/api/rates.json';

/**
 * Custom error class for snapshot generation and writing failures.
 */
export class SnapshotGenerationError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SnapshotGenerationError';
    this.cause = cause;
  }
}

/**
 * Options for generating a production snapshot in memory.
 */
export interface GenerateSnapshotOptions {
  /** Optional custom orchestrator options (e.g. injected fetch or API keys for testing) */
  readonly orchestratorOptions?: ProductionOrchestratorOptions;
  /** Optional reference timestamp */
  readonly timestamp?: number;
}

/**
 * Generates an in-memory validated production RateSnapshotPayload from real providers.
 * Throws SnapshotGenerationError if any provider fails, assets are missing, or validation fails.
 */
export async function generateProductionSnapshot(
  options?: GenerateSnapshotOptions
): Promise<RateSnapshotPayload> {
  const orchestrator = createProductionRateOrchestrator(options?.orchestratorOptions);

  const refreshResult = await orchestrator.refreshAll();

  if (!refreshResult.success || refreshResult.failedRefreshes > 0) {
    const errorDetails: string[] = [];
    for (const [providerId, errorMsg] of refreshResult.providerErrors) {
      errorDetails.push(`Provider '${providerId}' failed: ${errorMsg}`);
    }
    throw new SnapshotGenerationError(
      `Snapshot generation failed: ${refreshResult.failedRefreshes} provider(s) failed. Details:\n- ${errorDetails.join('\n- ')}`
    );
  }

  const composite = refreshResult.composite;
  if (!composite.dataset) {
    throw new SnapshotGenerationError('Snapshot generation failed: Composite dataset assembly produced null.');
  }

  // Verify all 19 canonical assets are present in the composite dataset
  const supported = getSupportedAssets();
  const missingAssets: string[] = [];
  for (const asset of supported) {
    if (!composite.dataset.rates.has(asset.code)) {
      missingAssets.push(asset.code);
    }
  }

  if (missingAssets.length > 0) {
    throw new SnapshotGenerationError(
      `Snapshot generation failed: Composite dataset is missing canonical asset(s): ${missingAssets.join(', ')}.`
    );
  }

  // Serialize to canonical schema
  const rawSnapshot = serializeRateSnapshot(composite.dataset, composite.provenance, {
    providerId: 'allfin-live',
    providerName: 'AllFinConverter Live Composite',
  });

  // Strict schema validation (bypassing max-age check during fresh serialization)
  const validated = validateRateSnapshot(rawSnapshot, { maxAgeMs: 0 });

  // Invariant check: Live snapshots must NEVER be marked mock
  if (validated.isMock) {
    throw new SnapshotGenerationError(
      'Snapshot generation safety violation: Generated snapshot was incorrectly marked as mock data.'
    );
  }

  return validated;
}

/**
 * Options for writing a snapshot to disk.
 */
export interface WriteSnapshotOptions {
  /** Destination file path. Defaults to src/data/latestSnapshot.json */
  readonly targetPath?: string;
  /** Whether to also update dist/api/rates.json if the dist/api folder exists. Default: true */
  readonly updateDistIfPresent?: boolean;
}

/**
 * Result of writing snapshot to disk.
 */
export interface WriteSnapshotResult {
  readonly primaryPath: string;
  readonly primaryBytes: number;
  readonly distPath?: string;
  readonly distBytes?: number;
}

/**
 * Atomically writes a validated production snapshot to disk.
 * Uses a temporary file and atomic rename to guarantee the destination is never left in a partial state.
 */
export function writeProductionSnapshot(
  snapshot: RateSnapshotPayload,
  options?: WriteSnapshotOptions
): WriteSnapshotResult {
  if (snapshot.isMock) {
    throw new SnapshotGenerationError('Cannot write snapshot: Mock data cannot be written as live production snapshot.');
  }

  try {
    validateRateSnapshot(snapshot, { maxAgeMs: 0 });
  } catch (err) {
    throw new SnapshotGenerationError(
      `Cannot write snapshot: validation failed: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  const targetPath = options?.targetPath
    ? path.resolve(options.targetPath)
    : path.resolve(process.cwd(), DEFAULT_SNAPSHOT_STORAGE_REL_PATH);

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const jsonContent = JSON.stringify(snapshot, null, 2);
  const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  try {
    fs.writeFileSync(tempPath, jsonContent, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
    throw new SnapshotGenerationError(
      `Failed to write snapshot atomically to '${targetPath}': ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  const primaryBytes = Buffer.byteLength(jsonContent, 'utf8');
  let distPathResult: string | undefined;
  let distBytesResult: number | undefined;

  // Optionally mirror to dist/api/rates.json if dist directory exists
  if (options?.updateDistIfPresent !== false) {
    const distPath = path.resolve(process.cwd(), DEFAULT_DIST_SNAPSHOT_REL_PATH);
    const distDir = path.dirname(distPath);
    if (fs.existsSync(distDir)) {
      const distTmpPath = `${distPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      try {
        fs.writeFileSync(distTmpPath, jsonContent, 'utf8');
        fs.renameSync(distTmpPath, distPath);
        distPathResult = distPath;
        distBytesResult = primaryBytes;
      } catch {
        if (fs.existsSync(distTmpPath)) {
          try {
            fs.unlinkSync(distTmpPath);
          } catch {}
        }
      }
    }
  }

  return {
    primaryPath: targetPath,
    primaryBytes,
    distPath: distPathResult,
    distBytes: distBytesResult,
  };
}

/**
 * End-to-end execution pipeline:
 * 1. Generates live snapshot in memory.
 * 2. Validates structure, canonical assets, and live status.
 * 3. Atomically writes to target destination.
 * If any step fails, the existing file at targetPath is left completely untouched.
 */
export async function runProductionSnapshotPipeline(
  options?: GenerateSnapshotOptions & WriteSnapshotOptions
): Promise<{ snapshot: RateSnapshotPayload; writeResult: WriteSnapshotResult }> {
  const snapshot = await generateProductionSnapshot(options);
  const writeResult = writeProductionSnapshot(snapshot, options);
  return { snapshot, writeResult };
}
