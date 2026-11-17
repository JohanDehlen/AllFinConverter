// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getSupportedAssets, GRAMS_PER_TROY_OUNCE_STR } from '../src/lib/assets.ts';
import { getFeaturedPairs } from '../src/lib/pairs.ts';
import { getHomepagePairGroups } from '../src/lib/pairs.ts';
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

describe('How it works methodology content', () => {
  const methodology = readFileSync(new URL('../src/pages/how-it-works.astro', import.meta.url), 'utf8');

  it('explains Big.js arithmetic and its configured division precision without promising exact results', () => {
    assert.match(methodology, /Big\.js/);
    assert.match(methodology, /binary floating-point representation artefacts/i);
    assert.match(methodology, /Division precision is configured to 30 decimal places/);
    assert.match(methodology, /non-terminating decimal result is rounded to that configured precision/i);
    assert.match(methodology, /Rate\(Target\) \/ Rate\(Source\)/);
    assert.doesNotMatch(
      methodology,
      /guaranteeing exact decimal results|zero floating-point drift|exact inverse mathematics|zero loss of accuracy/i
    );
  });

  it('describes fiat, cryptocurrency, and precious-metal data sources and limitations accurately', () => {
    assert.match(methodology, /USD is the normalization base currency, with a rate of 1/);
    assert.match(methodology, /Frankfurter API<\/a> supplies daily ECB-derived reference rates for the other 19 fiat currencies/);
    assert.match(methodology, /fixed-peg reference rate of 1 USD = 3\.6725 AED/);
    assert.match(methodology, /not an AED market rate supplied by Frankfurter/);
    assert.match(methodology, /consumes USD-denominated reference prices supplied by the/);
    assert.match(methodology, /does not independently calculate CoinMarketCap's volume-weighted market price/);
    assert.match(methodology, /not a guaranteed executable exchange or purchase price/);
    assert.match(methodology, /Gold-API<\/a> supplies USD-denominated reference prices/);
    assert.match(methodology, /expressed per troy ounce before quantity-unit conversion/);
    assert.match(methodology, /premiums, fabrication costs, purity, product form, and dealer margins/);

    for (const sourceUrl of [
      'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
      'https://support.coinmarketcap.com/hc/en-us/articles/360015968632-How-are-prices-calculated-on-CoinMarketCap',
      'https://www.lbma.org.uk/wonders-of-gold/items/the-troy-ounce',
      'https://centralbank.ae/en/forex-eibor/exchange-rates/',
    ]) {
      assert.ok(methodology.includes(sourceUrl), `Expected methodology source link: ${sourceUrl}`);
    }

    assert.doesNotMatch(methodology, /institutional spot market quotes|Frankfurter API<\/a>[^<]*20 currencies/i);
  });
});

describe('Static snapshot metadata and expiry', () => {
  it('renders crawlable homepage links for the selected existing pair routes', () => {
    const homepage = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
    const groups = getHomepagePairGroups();

    assert.match(homepage, /<h2 id="homepage-pairs-heading" class="homepage-pairs-heading">Explore Popular Conversions<\/h2>/);
    assert.match(homepage, /Explore popular currency, cryptocurrency and precious-metal conversions/);
    assert.match(homepage, /<a href=\{`\/\$\{pair\.slug\}\/`\}>/);
    assert.deepEqual(groups.map((group) => group.title), [
      'Currency conversions',
      'Cryptocurrency conversions',
      'Precious-metal conversions',
    ]);

    const slugs = groups.flatMap((group) => group.pairs.map((pair) => pair.slug));
    assert.equal(new Set(slugs).size, slugs.length);
    assert.ok(groups.every((group) => group.pairs.length > 0));
  });

  it('uses the absolute branded social image and descriptive alternative text by default', () => {
    const layout = readFileSync(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');

    assert.match(layout, /ogImage = '\/social-preview\.png'/);
    assert.match(layout, /ogImageAlt = 'AllFinConverter — Currency, Crypto and Precious Metals Converter'/);
    assert.match(layout, /new URL\(ogImage, Astro\.site \?\? 'https:\/\/allfinconverter\.com'\)\.href/);
    assert.match(layout, /property="og:image" content=\{resolvedOgImage\}/);
    assert.match(layout, /name="twitter:image" content=\{resolvedOgImage\}/);
    assert.match(layout, /property="og:image:alt" content=\{ogImageAlt\}/);
    assert.match(layout, /name="twitter:image:alt" content=\{ogImageAlt\}/);
    assert.match(layout, /name="twitter:card" content="summary_large_image"/);
    assert.match(layout, /property="og:image:width" content="1200"/);
    assert.match(layout, /property="og:image:height" content="630"/);
  });

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

  it('renders a neutral checking state until browser validation', () => {
    const converter = readFileSync(new URL('../src/components/Converter.astro', import.meta.url), 'utf8');
    const pairPage = readFileSync(new URL('../src/pages/[pair].astro', import.meta.url), 'utf8');
    const footer = readFileSync(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');
    const initialMarkup = converter.slice(converter.indexOf('<section'), converter.indexOf('<script>'));

    assert.match(initialMarkup, /class="checking-badge"/);
    assert.match(initialMarkup, /aria-label="Checking rates"/);
    assert.match(initialMarkup, /<span id="rate-badge-text">Checking rates…<\/span>/);
    assert.match(initialMarkup, /id="amount-to"[\s\S]*?value=""[\s\S]*?placeholder="—"/);
    assert.match(initialMarkup, /id="summary-headline" class="summary-calculation">—<\/span>/);
    assert.match(initialMarkup, /id="summary-subtext" class="summary-disclaimer"><\/p>/);
    assert.doesNotMatch(initialMarkup, /Demo rates|fictional development rates|1 USD = 0\.92 EUR/);
    assert.doesNotMatch(converter, /data-initial-snapshot|loadBuildSnapshot/);
    assert.doesNotMatch(pairPage, /loadBuildSnapshot|isLiveRate|live-badge/);
    assert.match(pairPage, /Use the interactive converter above to calculate conversions/);
    assert.match(pairPage, /shows validated live reference rates when available and clearly indicates demo mode otherwise/);
    assert.match(pairPage, /<p class="related-pairs-subheading">Related conversions<\/p>/);
    assert.doesNotMatch(pairPage, /popular conversion/i);
    assert.doesNotMatch(pairPage, /Direct Rate \(Demo\)|Inverse Rate \(Demo\)|formattedUnitRate|formattedInverseRate/);
    assert.match(footer, /<p class="footer-note"><\/p>/);
    assert.doesNotMatch(footer, /Live reference rates/);
    assert.match(converter, /footerRateStatus\.textContent = isSnapshot/);
    assert.match(converter, /if \(isCheckingRates\) \{/);
    assert.match(converter, /isCheckingRates = false;/);
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

  it('limits pair-specific explanations to USD/EUR, BTC/USD, and gold/USD', () => {
    const pairPage = readFileSync(new URL('../src/pages/[pair].astro', import.meta.url), 'utf8');

    assert.match(pairPage, /const isUsdToEurPair = pair\.fromCode === 'USD' && pair\.toCode === 'EUR';/);
    assert.match(pairPage, /const isBtcToUsdPair = pair\.fromCode === 'BTC' && pair\.toCode === 'USD';/);
    assert.match(pairPage, /const isGoldToUsdPair = pair\.fromCode === 'XAU' && pair\.toCode === 'USD';/);
    assert.match(pairPage, /\{isUsdToEurPair && \([\s\S]*?Converting US dollars to euros[\s\S]*?does not execute transactions\./);
    assert.match(pairPage, /\{isBtcToUsdPair && \([\s\S]*?Bitcoin amount into its indicative US dollar equivalent[\s\S]*?not a cryptocurrency exchange or trading service\./);
    assert.match(pairPage, /\{isGoldToUsdPair && \([\s\S]*?US dollars per troy ounce[\s\S]*?dealer premiums, spreads, taxes, and other charges/);
  });

  it('sets the converter default opening amount to one', () => {
    const converter = readFileSync(new URL('../src/components/Converter.astro', import.meta.url), 'utf8');

    assert.match(converter, /initialAmount = '1'/);
    assert.match(converter, /value=\{initialAmount\}/);
  });
});
