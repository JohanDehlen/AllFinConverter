import type { APIRoute } from 'astro';
import { createDefaultMockSnapshot } from '../../lib/rateSnapshot.ts';

export const prerender = true;

/**
 * AllFinConverter Static Rate Snapshot API Endpoint
 *
 * Generates a deterministic mock rate snapshot at build time.
 * In Astro static mode (output: "static"), this endpoint compiles to dist/api/rates.json.
 *
 * Invariants:
 * - Does NOT import or invoke live providers.
 * - Makes ZERO external network requests.
 * - Complies strictly with RateSnapshotPayload schema across all 19 canonical assets.
 */
export const GET: APIRoute = async () => {
  const snapshot = createDefaultMockSnapshot();

  return new Response(JSON.stringify(snapshot, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
