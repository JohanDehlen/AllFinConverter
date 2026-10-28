import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDefaultMockSnapshot,
  validateRateSnapshot,
  type RateSnapshotPayload,
} from '../../lib/rateSnapshot.ts';

export const prerender = true;

/**
 * AllFinConverter Static Rate Snapshot API Endpoint
 *
 * Compiles the rate snapshot at build time into dist/api/rates.json.
 * If a validated production snapshot exists on disk (src/data/latestSnapshot.json),
 * it is verified and delivered.
 * Otherwise, falls back safely to the deterministic mock rate snapshot.
 *
 * Invariants:
 * - Does NOT invoke live network providers at build time.
 * - Makes ZERO external network requests.
 * - Complies strictly with RateSnapshotPayload schema across all 19 canonical assets.
 */
export const GET: APIRoute = async () => {
  let snapshot: RateSnapshotPayload;

  const storagePath = path.resolve(process.cwd(), 'src/data/latestSnapshot.json');

  if (fs.existsSync(storagePath)) {
    try {
      const fileContent = fs.readFileSync(storagePath, 'utf8');
      const parsed = JSON.parse(fileContent);
      snapshot = validateRateSnapshot(parsed, { maxAgeMs: 0 });
    } catch {
      // If disk snapshot is corrupt or invalid, fall back gracefully to default mock snapshot
      snapshot = createDefaultMockSnapshot();
    }
  } else {
    snapshot = createDefaultMockSnapshot();
  }

  return new Response(JSON.stringify(snapshot, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
