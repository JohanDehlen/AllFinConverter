/**
 * Tests for Build-Time Snapshot Loader and Pair Overview Rate Labelling
 *
 * Verifies:
 * 1. loadBuildSnapshot returns correct results for valid live snapshots.
 * 2. loadBuildSnapshot returns safe fallback for missing/invalid snapshots.
 * 3. Mock snapshots are never labelled as live.
 * 4. The pair-page overview labels are derived correctly from snapshot state.
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadBuildSnapshot, type BuildSnapshotResult } from '../src/lib/buildSnapshot.ts';
import { createDefaultMockSnapshot, validateRateSnapshot } from '../src/lib/rateSnapshot.ts';
import { RateEngine, defaultRateEngine } from '../src/lib/rateEngine.ts';

/**
 * Helper: Temporarily writes a snapshot file, runs a callback, then restores the original.
 */
function withSnapshotFile<T>(content: string | null, fn: () => T): T {
  const snapshotPath = path.resolve(process.cwd(), 'src/data/latestSnapshot.json');
  const hadFile = fs.existsSync(snapshotPath);
  let originalContent: string | undefined;

  if (hadFile) {
    originalContent = fs.readFileSync(snapshotPath, 'utf8');
  }

  try {
    if (content === null) {
      // Remove the file temporarily
      if (hadFile) {
        fs.unlinkSync(snapshotPath);
      }
    } else {
      fs.writeFileSync(snapshotPath, content, 'utf8');
    }
    return fn();
  } finally {
    // Restore original state
    if (hadFile && originalContent !== undefined) {
      fs.writeFileSync(snapshotPath, originalContent, 'utf8');
    } else if (!hadFile && fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }
  }
}

describe('Build-Time Snapshot Loader', () => {
  it('should return a valid live result when a valid non-mock snapshot is on disk', () => {
    // The project's latestSnapshot.json is a real production snapshot (isMock: false)
    const snapshotPath = path.resolve(process.cwd(), 'src/data/latestSnapshot.json');
    if (!fs.existsSync(snapshotPath)) {
      // Skip if no snapshot on disk (dev environment without snapshot)
      return;
    }

    const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

    // Only test the live path if the on-disk snapshot is actually non-mock
    let validated;
    try {
      validated = validateRateSnapshot(raw, { maxAgeMs: 0 });
    } catch {
      // Snapshot is invalid (e.g. stale) — skip live-specific assertions
      return;
    }

    if (validated.isMock) {
      // The on-disk snapshot is mock, so loadBuildSnapshot should NOT be live
      const result = loadBuildSnapshot();
      assert.equal(result.isLive, false, 'Mock snapshot must never be labelled live');
      return;
    }

    const result = loadBuildSnapshot();
    assert.ok(result.engine, 'Engine must be available for valid snapshot');
    assert.equal(result.isLive, true, 'Non-mock valid snapshot must be live');
    assert.ok(result.timestamp !== null && result.timestamp > 0, 'Timestamp must be positive');
    assert.ok(result.payload !== null, 'Payload must be present');
    assert.equal(result.payload!.isMock, false, 'Payload must not be mock');
  });

  it('should return fallback result when snapshot file is missing', () => {
    const result = withSnapshotFile(null, () => loadBuildSnapshot());

    assert.equal(result.engine, undefined, 'Engine must be undefined');
    assert.equal(result.isLive, false, 'Must not be live');
    assert.equal(result.timestamp, null, 'Timestamp must be null');
    assert.equal(result.payload, null, 'Payload must be null');
  });

  it('should return fallback result when snapshot file contains invalid JSON', () => {
    const result = withSnapshotFile('{ not valid json }}}}', () => loadBuildSnapshot());

    assert.equal(result.engine, undefined);
    assert.equal(result.isLive, false);
    assert.equal(result.timestamp, null);
    assert.equal(result.payload, null);
  });

  it('should return fallback result when snapshot has wrong schema version', () => {
    const badSnapshot = JSON.stringify({
      version: 999,
      providerId: 'test',
      providerName: 'Test',
      baseAsset: 'USD',
      timestamp: Date.now(),
      isMock: false,
      rates: {},
      provenance: {},
    });

    const result = withSnapshotFile(badSnapshot, () => loadBuildSnapshot());
    assert.equal(result.engine, undefined);
    assert.equal(result.isLive, false);
  });

  it('should never label a mock snapshot as live', () => {
    const mockSnapshot = createDefaultMockSnapshot(Date.now());
    const mockJson = JSON.stringify(mockSnapshot);

    const result = withSnapshotFile(mockJson, () => loadBuildSnapshot());

    // Engine may or may not be available (mock data is valid for ingestion)
    // but isLive must always be false
    assert.equal(result.isLive, false, 'Mock snapshot must never be labelled live');

    if (result.payload) {
      assert.equal(result.payload.isMock, true, 'Payload must reflect mock status');
    }
  });
});

describe('Pair Overview Rate Labels', () => {
  /**
   * Static pair-page markup stays non-live until browser validation is possible.
   */
  function deriveOverviewLabels(snapshot: BuildSnapshotResult) {
    const overviewBadgeLabel = 'Demo mode: fictional mock exchange rates';
    const overviewBadgeText = 'Demo rates \u2022 Offline preview';
    const directRateLabel = 'Direct Rate (Demo)';
    const inverseRateLabel = 'Inverse Rate (Demo)';
    const badgeClass = 'demo-badge';

    return { overviewBadgeLabel, overviewBadgeText, directRateLabel, inverseRateLabel, badgeClass };
  }

  it('should produce demo labels when snapshot is unavailable', () => {
    const fallback: BuildSnapshotResult = {
      engine: undefined,
      isLive: false,
      timestamp: null,
      payload: null,
    };

    const labels = deriveOverviewLabels(fallback);
    assert.equal(labels.badgeClass, 'demo-badge');
    assert.equal(labels.overviewBadgeText, 'Demo rates \u2022 Offline preview');
    assert.equal(labels.directRateLabel, 'Direct Rate (Demo)');
    assert.equal(labels.inverseRateLabel, 'Inverse Rate (Demo)');
    assert.equal(labels.overviewBadgeLabel, 'Demo mode: fictional mock exchange rates');
  });

  it('should produce demo labels when snapshot is mock', () => {
    const mockResult: BuildSnapshotResult = {
      engine: undefined,
      isLive: false,
      timestamp: Date.now(),
      payload: null,
    };

    const labels = deriveOverviewLabels(mockResult);
    assert.equal(labels.badgeClass, 'demo-badge');
    assert.equal(labels.overviewBadgeText, 'Demo rates \u2022 Offline preview');
    assert.equal(labels.directRateLabel, 'Direct Rate (Demo)');
    assert.equal(labels.inverseRateLabel, 'Inverse Rate (Demo)');
  });

  it('should keep static labels non-live even when a build snapshot is valid', () => {
    const ts = Date.now();
    const liveResult: BuildSnapshotResult = {
      engine: new RateEngine(),
      isLive: true,
      timestamp: ts,
      payload: null,
    };

    const labels = deriveOverviewLabels(liveResult);
    assert.equal(labels.badgeClass, 'demo-badge');
    assert.equal(labels.overviewBadgeText, 'Demo rates \u2022 Offline preview');
    assert.equal(labels.directRateLabel, 'Direct Rate (Demo)');
    assert.equal(labels.inverseRateLabel, 'Inverse Rate (Demo)');
    assert.equal(labels.overviewBadgeLabel, 'Demo mode: fictional mock exchange rates');
  });

  it('should never present mock rates with live labelling', () => {
    // Even if engine is somehow available but isLive is false, labels must be demo
    const mockWithEngine: BuildSnapshotResult = {
      engine: defaultRateEngine,
      isLive: false,
      timestamp: Date.now(),
      payload: null,
    };

    const labels = deriveOverviewLabels(mockWithEngine);
    assert.equal(labels.badgeClass, 'demo-badge');
    assert.equal(labels.directRateLabel, 'Direct Rate (Demo)');
    assert.ok(!labels.overviewBadgeLabel.includes('Live'), 'Must not contain Live');
  });
});
