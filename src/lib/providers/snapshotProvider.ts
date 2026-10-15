/**
 * AllFinConverter Snapshot Rate Provider Adapter
 *
 * Implements the RateProvider interface to ingest rate datasets from
 * serializable snapshots (in-memory payloads or static/remote URLs).
 *
 * Design Invariants:
 * - Compatible with existing RateProvider and RateEngine contracts.
 * - Supports in-memory snapshot objects (for testing or direct injection)
 *   and URL fetching via injected or global fetch.
 * - Enforces snapshot validity and max-age constraints (default: 24h).
 * - Never makes live requests unless snapshotUrl is explicitly configured.
 */

import type { RateProvider } from '../rateProviders.ts';
import type { RawRatePayload } from '../rates.ts';
import type { RateProvenance } from '../compositeRates.ts';
import {
  type RateSnapshotPayload,
  validateRateSnapshot,
  MAX_SNAPSHOT_AGE_MS,
} from '../rateSnapshot.ts';

/**
 * Custom error class for snapshot provider operational and fetching failures.
 */
export class SnapshotProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SnapshotProviderError';
    this.cause = cause;
  }
}

/**
 * Configuration options for SnapshotRateProvider.
 */
export interface SnapshotProviderOptions {
  /** In-memory snapshot payload to use directly */
  readonly snapshot?: RateSnapshotPayload;
  /** URL from which to fetch the JSON snapshot */
  readonly snapshotUrl?: string;
  /** Custom fetch implementation for testing or offline sandboxing */
  readonly fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Defaults to 10,000ms. */
  readonly timeoutMs?: number;
  /** Maximum acceptable age for the snapshot in ms. Defaults to 24h (86,400,000ms). */
  readonly maxAgeMs?: number;
  /** Optional custom provider identifier */
  readonly id?: string;
  /** Optional custom provider display name */
  readonly name?: string;
}

/**
 * Safe result wrapper for SnapshotRateProvider.getRatesSafe().
 */
export type SafeSnapshotResult =
  | {
      readonly success: true;
      readonly payload: RawRatePayload;
      readonly snapshot: RateSnapshotPayload;
    }
  | {
      readonly success: false;
      readonly error: SnapshotProviderError;
    };

/**
 * RateProvider implementation that supplies rates from a verified snapshot.
 */
export class SnapshotRateProvider implements RateProvider {
  readonly id: string;
  readonly name: string;
  readonly isMock: boolean;

  private readonly staticSnapshot?: RateSnapshotPayload;
  private readonly snapshotUrl?: string;
  private readonly customFetch?: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;

  private latestSnapshot: RateSnapshotPayload | null = null;
  private provenanceMap: Map<string, RateProvenance> = new Map();

  constructor(options?: SnapshotProviderOptions) {
    this.id = options?.id ?? 'snapshot';
    this.name = options?.name ?? 'Rate Snapshot Provider';
    this.staticSnapshot = options?.snapshot;
    this.snapshotUrl = options?.snapshotUrl;
    this.customFetch = options?.fetch;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    this.maxAgeMs = options?.maxAgeMs !== undefined ? options.maxAgeMs : MAX_SNAPSHOT_AGE_MS;
    this.isMock = options?.snapshot ? options.snapshot.isMock : false;
  }

  /**
   * Retrieves rates from the snapshot source (in-memory or URL).
   * Validates snapshot integrity and freshness before returning raw payload.
   */
  async getRates(): Promise<RawRatePayload> {
    let snapshot: RateSnapshotPayload;

    if (this.staticSnapshot) {
      try {
        snapshot = validateRateSnapshot(this.staticSnapshot, {
          maxAgeMs: this.maxAgeMs,
        });
      } catch (err: unknown) {
        throw new SnapshotProviderError(
          `Static snapshot validation failed: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }
    } else if (this.snapshotUrl) {
      snapshot = await this.fetchSnapshotFromUrl(this.snapshotUrl);
    } else {
      throw new SnapshotProviderError(
        'SnapshotRateProvider requires either snapshot or snapshotUrl to be configured.'
      );
    }

    this.latestSnapshot = snapshot;
    this.updateProvenance(snapshot);

    return {
      providerId: snapshot.providerId,
      providerName: snapshot.providerName,
      timestamp: snapshot.timestamp,
      isMock: snapshot.isMock,
      rates: snapshot.rates,
    };
  }

  /**
   * Safe non-throwing retrieval returning a typed SafeSnapshotResult.
   */
  async getRatesSafe(): Promise<SafeSnapshotResult> {
    try {
      const payload = await this.getRates();
      return {
        success: true,
        payload,
        snapshot: this.latestSnapshot!,
      };
    } catch (err: unknown) {
      const error =
        err instanceof SnapshotProviderError
          ? err
          : new SnapshotProviderError(
              err instanceof Error ? err.message : String(err),
              err
            );
      return {
        success: false,
        error,
      };
    }
  }

  /**
   * Returns the most recently ingested snapshot payload, or null if uninitialized.
   */
  getLatestSnapshot(): RateSnapshotPayload | null {
    return this.latestSnapshot;
  }

  /**
   * Returns per-asset provenance metadata from the active snapshot.
   */
  getProvenance(): ReadonlyMap<string, RateProvenance> {
    return this.provenanceMap;
  }

  private updateProvenance(snapshot: RateSnapshotPayload): void {
    this.provenanceMap.clear();
    for (const [code, prov] of Object.entries(snapshot.provenance)) {
      this.provenanceMap.set(code, {
        sourceId: prov.sourceId,
        sourceName: prov.sourceName,
        timestamp: prov.timestamp,
      });
    }
  }

  private async fetchSnapshotFromUrl(url: string): Promise<RateSnapshotPayload> {
    const fetchImpl = this.customFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new SnapshotProviderError(
        'No fetch implementation available for SnapshotRateProvider.'
      );
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      controller && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;

    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          signal: controller?.signal,
          headers: {
            Accept: 'application/json',
          },
        });
      } catch (networkErr: unknown) {
        if (controller?.signal.aborted) {
          throw new SnapshotProviderError(
            `Snapshot fetch timed out after ${this.timeoutMs}ms for ${url}`,
            networkErr
          );
        }
        throw new SnapshotProviderError(
          `Snapshot network request failed for ${url}: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
          networkErr
        );
      }

      if (!res.ok) {
        throw new SnapshotProviderError(
          `Snapshot HTTP error from ${url}: ${res.status} ${res.statusText || ''}`.trim()
        );
      }

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (jsonErr: unknown) {
        throw new SnapshotProviderError(
          `Malformed JSON in snapshot response from ${url}: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          jsonErr
        );
      }

      try {
        return validateRateSnapshot(parsed, { maxAgeMs: this.maxAgeMs });
      } catch (valErr: unknown) {
        throw new SnapshotProviderError(
          `Snapshot validation failed for ${url}: ${valErr instanceof Error ? valErr.message : String(valErr)}`,
          valErr
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
