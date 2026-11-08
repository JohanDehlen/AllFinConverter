// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getSupportedAssets, GRAMS_PER_TROY_OUNCE_STR } from '../src/lib/assets.ts';
import { getFeaturedPairs } from '../src/lib/pairs.ts';
import {
  createDefaultMockSnapshot,
  isLiveSnapshotAcceptable,
  MAX_SNAPSHOT_AGE_MS,
  type RateSnapshotPayload,
} from '../src/lib/rateSnapshot.ts';
import { createStaticSnapshotResponse } from '../src/pages/api/rates.json.ts';

function createLiveSnapshot(timestamp: number): RateSnapshotPayload {
  const mock = createDefaultMockSnapshot(timestamp);
  const rates = { ...mock.rates, AED: '3.6725' };
  const provenance = Object.fromEntries(
    getSupportedAssets().map((asset) => {
      const sourceId =
        asset.code === 'AED' || asset.code === 'USD'
          ? 'fixed-peg'
          : asset.category === 'fiat'
            ? 'frankfurter'
            : asset.category === 'crypto'
              ? 'coinmarketcap'
              : 'goldapi';

      return [
        asset.code,
        {
          sourceId,
          sourceName: sourceId,
          timestamp,
        },
      ];
    })
  );

  return {
    ...mock,
    providerId: 'allfin-live',
    providerName: 'AllFinConverter Live Composite',
    timestamp,
    isMock: false,
    rates,
    provenance,
  };
}

describe('Static snapshot metadata and expiry', () => {
  it('adds generation and 24-hour expiry metadata without dropping snapshot fields', async () => {
    const now = Date.now();
    const snapshot = createLiveSnapshot(now);
    const response = createStaticSnapshotResponse(snapshot, now);
    const result = await response.json() as RateSnapshotPayload;

    assert.equal(result.isMock, false);
    assert.deepEqual(result.provenance, snapshot.provenance);
    assert.deepEqual(result.rates, snapshot.rates);
    assert.deepEqual(result.staticMetadata, {
      generationTimestamp: snapshot.timestamp,
      expiryTimestamp: snapshot.timestamp + MAX_SNAPSHOT_AGE_MS,
      deliveryMode: 'static',
      revalidatesAtRequestTime: false,
    });
  });

  it('serves expired production snapshots only as explicitly marked mock fallback data', async () => {
    const now = Date.now();
    const expired = createLiveSnapshot(now - MAX_SNAPSHOT_AGE_MS - 1);
    const response = createStaticSnapshotResponse(expired, now);
    const result = await response.json() as RateSnapshotPayload;

    assert.equal(result.isMock, true);
    assert.equal(result.staticMetadata?.generationTimestamp, now);
    assert.equal(result.staticMetadata?.expiryTimestamp, now + MAX_SNAPSHOT_AGE_MS);
  });

  it('rejects a static snapshot in browser live validation after its expiry', () => {
    const now = Date.now();
    const snapshot = createLiveSnapshot(now);
    const response = {
      ...snapshot,
      staticMetadata: {
        generationTimestamp: now,
        expiryTimestamp: now + MAX_SNAPSHOT_AGE_MS,
        deliveryMode: 'static' as const,
        revalidatesAtRequestTime: false as const,
      },
    };

    assert.equal(isLiveSnapshotAcceptable(response, { now }), true);
    assert.equal(isLiveSnapshotAcceptable(response, { now: now + MAX_SNAPSHOT_AGE_MS + 1 }), false);
  });

  it('keeps generated HTML statuses non-live until browser validation', () => {
    const converter = readFileSync(new URL('../src/components/Converter.astro', import.meta.url), 'utf8');
    const pairPage = readFileSync(new URL('../src/pages/[pair].astro', import.meta.url), 'utf8');
    const footer = readFileSync(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');

    assert.match(converter, /class="demo-badge"/);
    assert.match(converter, /<span id="rate-badge-text">Demo rates<\/span>/);
    assert.doesNotMatch(converter, /data-initial-snapshot|loadBuildSnapshot/);
    assert.doesNotMatch(pairPage, /loadBuildSnapshot|isLiveRate|live-badge/);
    assert.match(pairPage, /Use the interactive converter above to calculate conversions/);
    assert.match(pairPage, /shows validated live reference rates when available and clearly indicates demo mode otherwise/);
    assert.match(pairPage, /<p class="related-pairs-subheading">Related conversions<\/p>/);
    assert.doesNotMatch(pairPage, /popular conversion/i);
    assert.doesNotMatch(pairPage, /Direct Rate \(Demo\)|Inverse Rate \(Demo\)|formattedUnitRate|formattedInverseRate/);
    assert.match(footer, /Exchange rates currently in demo mode/);
    assert.doesNotMatch(footer, /Live reference rates/);
    assert.match(converter, /footerRateStatus\.textContent = isSnapshot/);
  });

  it('renders the metal explanation before asset details and the overview after them', () => {
    const pairPage = readFileSync(new URL('../src/pages/[pair].astro', import.meta.url), 'utf8');
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

    assert.match(pairPage, /const isMetalPair = pair\.fromAsset\.category === 'metal' \|\| pair\.toAsset\.category === 'metal';/);
    assert.match(pairPage, /import \{ GRAMS_PER_TROY_OUNCE_STR \} from '\.\.\/lib\/assets\.ts'/);

    const metalExplanation = pairPage.match(/\{isMetalPair && \(\s*<p>\s*([\s\S]*?)\s*<\/p>\s*\)\}/)?.[1];
    const expectedMetalExplanation =
      'Precious metals are priced by default in troy ounces. You can switch to grams using the unit selector. One troy ounce equals 31.1034768 grams. Changing the unit preserves the equivalent quantity and updates the conversion accordingly.';
    assert.ok(metalExplanation);
    assert.equal(GRAMS_PER_TROY_OUNCE_STR, '31.1034768');
    assert.equal(
      normalize(metalExplanation),
      expectedMetalExplanation.replace('31.1034768', '{GRAMS_PER_TROY_OUNCE_STR}')
    );

    const overviewMatches = [...pairPage.matchAll(/\{(!?isMetalPair) && \(\s*<p>\s*([\s\S]*?)\s*<\/p>\s*\)/g)];
    const expectedOverview =
      'Use the interactive converter above to calculate conversions. It shows validated live reference rates when available and clearly indicates demo mode otherwise.';
    const nonMetalOverview = overviewMatches.find(
      ([, condition, content]) => condition === '!isMetalPair' && normalize(content) === expectedOverview
    );
    const metalOverview = overviewMatches.find(
      ([, condition, content]) => condition === 'isMetalPair' && normalize(content) === expectedOverview
    );
    assert.ok(nonMetalOverview);
    assert.ok(metalOverview);
    assert.equal(normalize(nonMetalOverview[2]), expectedOverview);
    assert.equal(normalize(metalOverview[2]), expectedOverview);

    const assetDetailsIndex = pairPage.indexOf('<div class="pair-assets-info">');
    assert.ok(pairPage.indexOf('Precious metals are priced by default in troy ounces.') < assetDetailsIndex);
    assert.ok(nonMetalOverview.index < assetDetailsIndex, 'non-metal overview must remain before asset details');
    assert.ok(assetDetailsIndex < metalOverview.index, 'metal overview must follow asset details');
  });

  it('uses the approved overview wording and avoids conflicting metal-only overview copy', () => {
    const pairPage = readFileSync(new URL('../src/pages/[pair].astro', import.meta.url), 'utf8');

    assert.match(
      pairPage,
      /<p>\s*Use the interactive converter above to calculate conversions\. It shows validated live reference rates when available and clearly indicates demo mode otherwise\.\s*<\/p>/
    );
    assert.doesNotMatch(pairPage, /Precious metals are represented as reference assets in this development version\./);

    const preciousMetalPairSlugs = getFeaturedPairs()
      .filter((pair) => pair.fromAsset.category === 'metal' || pair.toAsset.category === 'metal')
      .map((pair) => pair.slug)
      .sort();
    assert.deepEqual(preciousMetalPairSlugs, [
      'gold-to-usd',
      'silver-to-usd',
      'usd-to-gold',
      'usd-to-silver',
    ]);
  });

  it('sets the converter default opening amount to one', () => {
    const converter = readFileSync(new URL('../src/components/Converter.astro', import.meta.url), 'utf8');

    assert.match(converter, /initialAmount = '1'/);
    assert.match(converter, /value=\{initialAmount\}/);
  });
});
