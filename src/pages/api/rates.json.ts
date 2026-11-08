import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDefaultMockSnapshot,
  MAX_SNAPSHOT_AGE_MS,
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
 * This is a static artifact: metadata allows consumers to evaluate its age,
 * but the endpoint cannot revalidate freshness at request time.
 *
 * Invariants:
 * - Does NOT invoke live network providers at build time.
 * - Makes ZERO external network requests.
 * - Complies strictly with RateSnapshotPayload schema across all canonical assets.
 */
export function createStaticSnapshotResponse(
  rawSnapshot: unknown,
  now: number = Date.now()
): Response {
  let snapshot: RateSnapshotPayload;
  try {
    snapshot = validateRateSnapshot(rawSnapshot, { now });
  } catch {
    snapshot = createDefaultMockSnapshot(now);
  }

  const responseSnapshot: RateSnapshotPayload = {
    ...snapshot,
    staticMetadata: {
      generationTimestamp: snapshot.timestamp,
      expiryTimestamp: snapshot.timestamp + MAX_SNAPSHOT_AGE_MS,
      deliveryMode: 'static',
      revalidatesAtRequestTime: false,
    },
  };

  return new Response(JSON.stringify(responseSnapshot, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export const GET: APIRoute = async () => {
  let rawSnapshot: unknown;
  const storagePath = path.resolve(process.cwd(), 'src/data/latestSnapshot.json');

  if (fs.existsSync(storagePath)) {
    try {
      const fileContent = fs.readFileSync(storagePath, 'utf8');
      rawSnapshot = JSON.parse(fileContent);
    } catch {
      rawSnapshot = undefined;
    }
  }

  return createStaticSnapshotResponse(rawSnapshot);
};
