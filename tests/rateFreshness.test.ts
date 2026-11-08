// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_GOLD_API_RATE_AGE_MS,
  MAX_COINMARKETCAP_RATE_AGE_MS,
  MAX_FRANKFURTER_RATE_AGE_MS,
  evaluateRateFreshness,
} from '../src/lib/rateFreshness.ts';
import {
  createDefaultMockSnapshot,
  isLiveSnapshotAcceptable,
  MAX_SNAPSHOT_AGE_MS,
  validateRateSnapshot,
  type RateSnapshotProvenanceEntry,
  type RateSnapshotPayload,
} from '../src/lib/rateSnapshot.ts';
import { getSupportedAssets } from '../src/lib/assets.ts';

function createLiveSnapshot(
  now: number,
  options?: {
    snapshotTimestamp?: number;
    provenanceTimestampOverrides?: Readonly<Record<string, number>>;
    sourceOverrides?: Readonly<Record<string, string>>;
  }
): RateSnapshotPayload {
  const rates: Record<string, string> = {};
  const provenance: Record<string, RateSnapshotProvenanceEntry> = {};

  for (const asset of getSupportedAssets()) {
    rates[asset.code] = asset.code === 'AED' ? '3.6725' : '1';

    const sourceId =
      asset.code === 'AED' || asset.code === 'USD'
        ? 'fixed-peg'
        : asset.category === 'fiat'
          ? 'frankfurter'
          : asset.category === 'crypto'
            ? 'coinmarketcap'
            : 'goldapi';
    provenance[asset.code] = {
      sourceId: options?.sourceOverrides?.[asset.code] ?? sourceId,
      sourceName: 'Test source',
      timestamp: options?.provenanceTimestampOverrides?.[asset.code] ?? now,
    };
  }

  return {
    version: 1,
    providerId: 'allfin-live',
    providerName: 'AllFinConverter test snapshot',
    baseAsset: 'USD',
    timestamp: options?.snapshotTimestamp ?? now,
    isMock: false,
    rates,
    provenance,
  };
}

describe('Source-aware rate freshness', () => {
  it('keeps a Friday ECB publication fresh over the weekend', () => {
    const friday = Date.parse('2026-10-30T16:00:00.000Z');
    const monday = Date.parse('2026-11-02T16:00:00.000Z');
    const result = evaluateRateFreshness(
      { ...createLiveSnapshot(monday).rates },
      {
        ...createLiveSnapshot(monday).provenance,
        EUR: { sourceId: 'frankfurter', timestamp: friday },
      },
      { now: monday }
    );

    assert.equal(result.fresh, true, result.errors.join(' '));
  });

  it('accepts Frankfurter rates at seven days and rejects rates older than seven days', () => {
    const now = Date.parse('2026-11-08T12:00:00.000Z');
    const fresh = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { EUR: now - MAX_FRANKFURTER_RATE_AGE_MS },
    });
    const stale = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { EUR: now - MAX_FRANKFURTER_RATE_AGE_MS - 1 },
    });

    assert.equal(evaluateRateFreshness(fresh.rates, fresh.provenance, { now }).fresh, true);
    assert.equal(evaluateRateFreshness(stale.rates, stale.provenance, { now }).fresh, false);
  });

  it('accepts crypto rates at 24 hours and rejects rates older than 24 hours', () => {
    const now = Date.now();
    const fresh = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { BTC: now - MAX_COINMARKETCAP_RATE_AGE_MS },
    });
    const stale = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { BTC: now - MAX_COINMARKETCAP_RATE_AGE_MS - 1 },
    });

    assert.equal(evaluateRateFreshness(fresh.rates, fresh.provenance, { now }).fresh, true);
    assert.equal(evaluateRateFreshness(stale.rates, stale.provenance, { now }).fresh, false);
  });

  it('accepts metal rates at 96 hours and rejects rates older than 96 hours', () => {
    const now = Date.now();
    const fresh = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { XAU: now - DEFAULT_MAX_GOLD_API_RATE_AGE_MS },
    });
    const stale = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { XAU: now - DEFAULT_MAX_GOLD_API_RATE_AGE_MS - 1 },
    });

    assert.equal(evaluateRateFreshness(fresh.rates, fresh.provenance, { now }).fresh, true);
    assert.equal(evaluateRateFreshness(stale.rates, stale.provenance, { now }).fresh, false);
  });

  it('allows the initial Gold-API age threshold to be configured', () => {
    const now = Date.now();
    const snapshot = createLiveSnapshot(now, {
      provenanceTimestampOverrides: { XAU: now - 48 * 60 * 60 * 1000 },
    });

    assert.equal(
      evaluateRateFreshness(snapshot.rates, snapshot.provenance, {
        now,
        maxGoldApiAgeMs: 48 * 60 * 60 * 1000,
      }).fresh,
      true
    );
    assert.equal(
      evaluateRateFreshness(snapshot.rates, snapshot.provenance, {
        now,
        maxGoldApiAgeMs: 24 * 60 * 60 * 1000,
      }).fresh,
      false
    );
  });

  it('does not let a recent aggregate timestamp hide an old individual rate', () => {
    const now = Date.now();
    const snapshot = createLiveSnapshot(now, {
      provenanceTimestampOverrides: {
        EUR: now - MAX_FRANKFURTER_RATE_AGE_MS - 1,
        AED: now,
      },
    });

    assert.throws(
      () => validateRateSnapshot(snapshot, { now }),
      /EUR is stale/
    );
    assert.equal(isLiveSnapshotAcceptable(snapshot, { now }), false);
  });

  it('does not use a recent fixed-peg timestamp to make market rates fresh', () => {
    const now = Date.now();
    const snapshot = createLiveSnapshot(now, {
      provenanceTimestampOverrides: {
        AED: now,
        BTC: now - MAX_COINMARKETCAP_RATE_AGE_MS - 1,
      },
    });

    it('rejects an AED rate that does not match the configured fixed peg', () => {
      const now = Date.now();
      const snapshot = createLiveSnapshot(now);
      const invalidPegSnapshot: RateSnapshotPayload = {
        ...snapshot,
        rates: { ...snapshot.rates, AED: '3.67' },
      };

      assert.throws(
        () => validateRateSnapshot(invalidPegSnapshot, { now }),
        /AED rate must equal the configured fixed peg/
      );
    });

    assert.equal(
      evaluateRateFreshness(snapshot.rates, snapshot.provenance, { now }).fresh,
      false
    );
  });

  it('fails closed for missing or unknown source provenance', () => {
    const now = Date.now();
    const snapshot = createLiveSnapshot(now);
    const missingProvenance = { ...snapshot.provenance };
    delete missingProvenance.EUR;
    const unknownSource = {
      ...snapshot.provenance,
      EUR: { sourceId: 'unregistered-provider', sourceName: 'Unknown', timestamp: now },
    };
    const invalidTimestamp = {
      ...snapshot.provenance,
      EUR: { sourceId: 'frankfurter', sourceName: 'Frankfurter', timestamp: Number.NaN },
    };

    assert.equal(evaluateRateFreshness(snapshot.rates, missingProvenance, { now }).fresh, false);
    assert.equal(evaluateRateFreshness(snapshot.rates, unknownSource, { now }).fresh, false);
    assert.equal(evaluateRateFreshness(snapshot.rates, invalidTimestamp, { now }).fresh, false);
  });

  it('keeps the overall 24-hour snapshot age check separate', () => {
    const now = Date.now();
    const staleSnapshot = createLiveSnapshot(now, {
      snapshotTimestamp: now - MAX_SNAPSHOT_AGE_MS - 1,
    });

    assert.throws(() => validateRateSnapshot(staleSnapshot, { now }), /snapshot is stale/i);
    assert.equal(isLiveSnapshotAcceptable(staleSnapshot, { now }), false);
  });

  it('uses the same freshness decision for server validation and browser activation', () => {
    const now = Date.now();
    const freshSnapshot = createLiveSnapshot(now);
    const staleSnapshot = createLiveSnapshot(now, {
      provenanceTimestampOverrides: {
        DOGE: now - MAX_COINMARKETCAP_RATE_AGE_MS - 1,
      },
    });

    assert.doesNotThrow(() => validateRateSnapshot(freshSnapshot, { now }));
    assert.equal(isLiveSnapshotAcceptable(freshSnapshot, { now }), true);
    assert.throws(() => validateRateSnapshot(staleSnapshot, { now }), /DOGE is stale/);
    assert.equal(isLiveSnapshotAcceptable(staleSnapshot, { now }), false);
  });

  it('marks fallback snapshots as mock and never accepts them as live', () => {
    const fallback = createDefaultMockSnapshot(Date.now());

    assert.equal(fallback.isMock, true);
    assert.equal(isLiveSnapshotAcceptable(fallback), false);
  });
});
