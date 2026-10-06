/**
 * Automated Test Suite for AllFinConverter M1.6 & M1.7
 *
 * Verifies:
 * 1. Pair validation rules (valid pairs, unknown assets, same-asset, disabled, etc.)
 * 2. URL slug handling and metal alias resolution (XAU->gold, XAG->silver, etc.)
 * 3. Featured pair registry and static generation integrity
 * 4. High-precision financial conversion calculations with Big.js
 * 5. M1.7 Precious Metal Unit Toggle (troy oz <-> grams conversions with Big.js)
 * 6. Related pair generation and crawlable internal linking
 * 7. Rate engine abstraction and mock provider isolation
 * 8. SEO metadata and sitemap synchronization
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  validatePair,
  getPairFromSlug,
  getFeaturedPairs,
  getRelatedPairs,
  FEATURED_PAIR_DEFINITIONS,
} from '../src/lib/pairs.ts';

import {
  getSupportedAssets,
  isPreciousMetal,
  getMetalUnitLabel,
  getAssetAmountPrefix,
  getAssetAmountSuffix,
  GRAMS_PER_TROY_OUNCE_STR,
} from '../src/lib/assets.ts';

import {
  formatPairSlug,
  parsePairSlug,
  resolveCanonicalUrl,
  getBreadcrumbStructuredData,
} from '../src/lib/seo.ts';

import {
  calculateConversion,
  convertTroyOzToGrams,
  convertGramsToTroyOz,
  formatDisplayAmount,
  formatQuantityWithUnit,
  formatUnitRateWithUnit,
  GRAMS_PER_TROY_OUNCE,
} from '../src/lib/converter.ts';

import {
  defaultRateEngine,
  getRate,
  hasRate,
} from '../src/lib/rateEngine.ts';

describe('M1.6 — Conversion Pair Validation', () => {
  it('should validate valid fiat pairs (USD → EUR, EUR → USD)', () => {
    const usdToEur = validatePair('USD', 'EUR');
    assert.ok(usdToEur, 'USD -> EUR should be valid');
    if (!usdToEur) throw new Error('Expected valid pair');
    assert.equal(usdToEur.fromCode, 'USD');
    assert.equal(usdToEur.toCode, 'EUR');
    assert.equal(usdToEur.slug, 'usd-to-eur');
    assert.equal(usdToEur.headline, 'USD to EUR Converter');
    assert.equal(usdToEur.title, 'USD to EUR Converter | AllFinConverter');

    const eurToUsd = validatePair('EUR', 'USD');
    assert.ok(eurToUsd, 'EUR -> USD should be valid');
    if (!eurToUsd) throw new Error('Expected valid pair');
    assert.equal(eurToUsd.fromCode, 'EUR');
    assert.equal(eurToUsd.toCode, 'USD');
    assert.equal(eurToUsd.slug, 'eur-to-usd');
  });

  it('should validate valid crypto pairs (BTC → USD, USD → BTC)', () => {
    const btcToUsd = validatePair('BTC', 'USD');
    assert.ok(btcToUsd, 'BTC -> USD should be valid');
    if (!btcToUsd) throw new Error('Expected valid pair');
    assert.equal(btcToUsd.fromCode, 'BTC');
    assert.equal(btcToUsd.toCode, 'USD');
    assert.equal(btcToUsd.slug, 'btc-to-usd');
    assert.equal(btcToUsd.headline, 'BTC to USD Converter');

    const usdToBtc = validatePair('USD', 'BTC');
    assert.ok(usdToBtc, 'USD -> BTC should be valid');
    if (!usdToBtc) throw new Error('Expected valid pair');
    assert.equal(usdToBtc.fromCode, 'USD');
    assert.equal(usdToBtc.toCode, 'BTC');
    assert.equal(usdToBtc.slug, 'usd-to-btc');
  });

  it('should validate precious metal pairs with friendly slug aliases (XAU → USD, USD → XAU, XAG → ZAR)', () => {
    const xauToUsd = validatePair('XAU', 'USD');
    assert.ok(xauToUsd, 'XAU -> USD should be valid');
    if (!xauToUsd) throw new Error('Expected valid pair');
    assert.equal(xauToUsd.fromCode, 'XAU');
    assert.equal(xauToUsd.toCode, 'USD');
    assert.equal(xauToUsd.slug, 'gold-to-usd');
    assert.equal(xauToUsd.headline, 'Gold to USD Converter');

    const usdToXau = validatePair('USD', 'XAU');
    assert.ok(usdToXau, 'USD -> XAU should be valid');
    if (!usdToXau) throw new Error('Expected valid pair');
    assert.equal(usdToXau.fromCode, 'USD');
    assert.equal(usdToXau.toCode, 'XAU');
    assert.equal(usdToXau.slug, 'usd-to-gold');
    assert.equal(usdToXau.headline, 'USD to Gold Converter');

    const xagToZar = validatePair('XAG', 'ZAR');
    assert.ok(xagToZar, 'XAG -> ZAR should be valid');
    if (!xagToZar) throw new Error('Expected valid pair');
    assert.equal(xagToZar.fromCode, 'XAG');
    assert.equal(xagToZar.toCode, 'ZAR');
    assert.equal(xagToZar.slug, 'silver-to-zar');
    assert.equal(xagToZar.headline, 'Silver to ZAR Converter');
  });

  it('should reject unknown or invalid asset codes', () => {
    assert.equal(validatePair('UNKNOWN', 'USD'), null);
    assert.equal(validatePair('USD', 'FAKE'), null);
    assert.equal(validatePair('XYZ', 'ABC'), null);
    assert.equal(validatePair('', 'USD'), null);
    assert.equal(validatePair('USD', ''), null);
  });

  it('should reject same-asset pairs (e.g. USD → USD, BTC → BTC)', () => {
    assert.equal(validatePair('USD', 'USD'), null);
    assert.equal(validatePair('BTC', 'BTC'), null);
    assert.equal(validatePair('eur', 'EUR'), null);
    assert.equal(validatePair('XAU', 'xau'), null);
  });

  it('should normalize input whitespace and case', () => {
    const pair = validatePair('  usd  ', '  eur  ');
    assert.ok(pair);
    if (!pair) throw new Error('Expected valid pair');
    assert.equal(pair.fromCode, 'USD');
    assert.equal(pair.toCode, 'EUR');
  });
});

describe('M1.6 — URL Slug Handling & Metal Aliases', () => {
  it('should format slugs with canonical metal aliases', () => {
    assert.equal(formatPairSlug('USD', 'EUR'), 'usd-to-eur');
    assert.equal(formatPairSlug('BTC', 'USD'), 'btc-to-usd');
    assert.equal(formatPairSlug('XAU', 'USD'), 'gold-to-usd');
    assert.equal(formatPairSlug('USD', 'XAU'), 'usd-to-gold');
    assert.equal(formatPairSlug('XAG', 'USD'), 'silver-to-usd');
    assert.equal(formatPairSlug('USD', 'XAG'), 'usd-to-silver');
    assert.equal(formatPairSlug('XAG', 'ZAR'), 'silver-to-zar');
    assert.equal(formatPairSlug('XPT', 'USD'), 'platinum-to-usd');
    assert.equal(formatPairSlug('XPD', 'EUR'), 'palladium-to-eur');
  });

  it('should parse slugs back into canonical uppercase asset codes', () => {
    assert.deepEqual(parsePairSlug('usd-to-eur'), { from: 'USD', to: 'EUR' });
    assert.deepEqual(parsePairSlug('btc-to-usd'), { from: 'BTC', to: 'USD' });
    assert.deepEqual(parsePairSlug('gold-to-usd'), { from: 'XAU', to: 'USD' });
    assert.deepEqual(parsePairSlug('usd-to-gold'), { from: 'USD', to: 'XAU' });
    assert.deepEqual(parsePairSlug('silver-to-zar'), { from: 'XAG', to: 'ZAR' });
    assert.deepEqual(parsePairSlug('xau-to-usd'), { from: 'XAU', to: 'USD' });
  });

  it('should resolve pairs from slug using getPairFromSlug', () => {
    const pair1 = getPairFromSlug('usd-to-eur');
    assert.ok(pair1);
    if (!pair1) throw new Error('Expected valid pair');
    assert.equal(pair1.fromCode, 'USD');
    assert.equal(pair1.toCode, 'EUR');

    const pair2 = getPairFromSlug('gold-to-usd');
    assert.ok(pair2);
    if (!pair2) throw new Error('Expected valid pair');
    assert.equal(pair2.fromCode, 'XAU');
    assert.equal(pair2.toCode, 'USD');
  });

  it('should reject malformed or non-existent slugs', () => {
    assert.equal(parsePairSlug(''), null);
    assert.equal(parsePairSlug('usd-eur'), null);
    assert.equal(parsePairSlug('usd_to_eur'), null);
    assert.equal(parsePairSlug('usd-to-'), null);
    assert.equal(parsePairSlug('-to-usd'), null);
    assert.equal(parsePairSlug('usd-to-usd'), null);
    assert.equal(parsePairSlug('unknown-to-eur'), null);
    assert.equal(getPairFromSlug('invalid-slug'), null);
  });
});

describe('M1.6 — Static Route Generation & Featured Pair Registry', () => {
  it('should contain exactly 16 representative pairs in FEATURED_PAIR_DEFINITIONS', () => {
    assert.equal(FEATURED_PAIR_DEFINITIONS.length, 16);
  });

  it('should validate every configured featured pair successfully', () => {
    const featuredPairs = getFeaturedPairs();
    assert.equal(featuredPairs.length, 16);

    for (const pair of featuredPairs) {
      assert.ok(pair.fromCode, 'Must have fromCode');
      assert.ok(pair.toCode, 'Must have toCode');
      assert.ok(pair.slug, 'Must have slug');
      assert.ok(pair.title, 'Must have title');
      assert.ok(pair.description, 'Must have description');
      assert.ok(pair.headline, 'Must have headline');
      assert.ok(pair.fromAsset.enabled, 'Source asset must be enabled');
      assert.ok(pair.toAsset.enabled, 'Target asset must be enabled');
      assert.ok(hasRate(pair.fromCode), `Rate engine must have rate for ${pair.fromCode}`);
      assert.ok(hasRate(pair.toCode), `Rate engine must have rate for ${pair.toCode}`);
    }
  });

  it('should provide sensible related pairs for crawlable internal linking', () => {
    const related = getRelatedPairs('usd-to-eur', 4);
    assert.ok(related.length > 0 && related.length <= 4);
    assert.equal(related[0].slug, 'eur-to-usd');
    assert.ok(related.every((p) => p.slug !== 'usd-to-eur'));
  });
});

describe('M1.6 — Financial Conversion Precision (Big.js)', () => {
  it('should calculate 100 USD → EUR = 92', () => {
    const res = calculateConversion('100', 'USD', 'EUR');
    assert.equal(formatDisplayAmount(res.targetAmount), '92');
  });

  it('should calculate 100 EUR → USD ≈ 108.695652', () => {
    const res = calculateConversion('100', 'EUR', 'USD');
    assert.equal(formatDisplayAmount(res.targetAmount), '108.70');
    assert.ok(res.targetAmount.gt(108.69) && res.targetAmount.lt(108.70));
    assert.equal(res.targetAmount.toFixed(6), '108.695652');
  });

  it('should calculate 100 USD → BTC = 0.0015', () => {
    const res = calculateConversion('100', 'USD', 'BTC');
    assert.equal(formatDisplayAmount(res.targetAmount), '0.0015');
  });

  it('should calculate 100 BTC → USD ≈ 6,666,666.67', () => {
    const res = calculateConversion('100', 'BTC', 'USD');
    assert.equal(formatDisplayAmount(res.targetAmount), '6,666,666.67');
  });

  it('should reject negative numbers strictly', () => {
    assert.throws(() => calculateConversion('-100', 'USD', 'EUR'), /negative/);
  });

  it('should handle zero gracefully', () => {
    const res = calculateConversion('0', 'USD', 'EUR');
    assert.equal(formatDisplayAmount(res.targetAmount), '0');
  });
});

describe('M1.7 — Precious Metal Unit Toggle & Big.js Conversions', () => {
  it('should verify exact unit definition: 1 troy oz = 31.1034768 g', () => {
    assert.equal(GRAMS_PER_TROY_OUNCE_STR, '31.1034768');
    assert.equal(GRAMS_PER_TROY_OUNCE.toFixed(7), '31.1034768');

    const grams = convertTroyOzToGrams('1');
    assert.equal(grams.toFixed(7), '31.1034768');
  });

  it('should verify exact inverse unit definition: 31.1034768 g = 1 troy oz', () => {
    const troyOz = convertGramsToTroyOz('31.1034768');
    assert.equal(troyOz.toFixed(10), '1.0000000000');
    assert.equal(troyOz.eq(1), true);
  });

  it('should perform bidirectional unit conversions for small and large values', () => {
    // 0.001 troy oz -> grams
    const smallGrams = convertTroyOzToGrams('0.001');
    assert.equal(smallGrams.toFixed(10), '0.0311034768');
    const smallTroy = convertGramsToTroyOz(smallGrams);
    assert.equal(smallTroy.toFixed(10), '0.0010000000');

    // 10,000 troy oz -> grams
    const largeGrams = convertTroyOzToGrams('10000');
    assert.equal(largeGrams.toFixed(4), '311034.7680');
    const largeTroy = convertGramsToTroyOz(largeGrams);
    assert.equal(largeTroy.toFixed(4), '10000.0000');
  });

  it('should convert USD → XAU with troy oz (default)', () => {
    // Rate: 0.000416 troy oz per USD
    const res = calculateConversion('100', 'USD', 'XAU', { toUnit: 'troy-oz' });
    assert.equal(formatDisplayAmount(res.targetAmount), '0.0416');
    assert.equal(res.targetAmount.toFixed(4), '0.0416');
    assert.equal(res.toUnit, 'troy-oz');
  });

  it('should convert USD → XAU with grams', () => {
    // Rate: 0.000416 * 31.1034768 = 0.0129390463488 g per USD
    // 100 USD = 1.29390463488 g
    const res = calculateConversion('100', 'USD', 'XAU', { toUnit: 'g' });
    assert.equal(formatDisplayAmount(res.targetAmount), '1.2939');
    assert.equal(res.targetAmount.toFixed(11), '1.29390463488');
    assert.equal(res.toUnit, 'g');
  });

  it('should convert XAU → USD with troy oz (default)', () => {
    // 100 troy oz * (1 / 0.000416) = 240,384.61538... USD
    const res = calculateConversion('100', 'XAU', 'USD', { fromUnit: 'troy-oz' });
    assert.equal(formatDisplayAmount(res.targetAmount), '240,384.62');
    assert.ok(res.targetAmount.gt(240384.61) && res.targetAmount.lt(240384.62));
    assert.equal(res.fromUnit, 'troy-oz');
  });

  it('should convert XAU → USD with grams', () => {
    // 100 g XAU = (100 / 31.1034768) / 0.000416 = 7,728.5448... USD
    const res = calculateConversion('100', 'XAU', 'USD', { fromUnit: 'g' });
    assert.equal(formatDisplayAmount(res.targetAmount), '7,728.54');
    assert.ok(res.targetAmount.gt(7728.54) && res.targetAmount.lt(7728.55));
    assert.equal(res.fromUnit, 'g');
  });

  it('should convert between two precious metals with independent units (XAU g → XAG troy oz)', () => {
    // 31.1034768 g Gold (= 1 troy oz Gold) to Silver (0.0357 troy oz/USD)
    // 1 troy oz Gold = (1 / 0.000416) USD = 2403.846... USD
    // Silver = 2403.846... * 0.0357 = 85.81730769... troy oz
    const res = calculateConversion('31.1034768', 'XAU', 'XAG', { fromUnit: 'g', toUnit: 'troy-oz' });
    assert.equal(formatDisplayAmount(res.targetAmount), '85.8173');
    assert.equal(res.fromUnit, 'g');
    assert.equal(res.toUnit, 'troy-oz');
  });

  it('should identify precious metals accurately with isPreciousMetal', () => {
    assert.equal(isPreciousMetal('XAU'), true);
    assert.equal(isPreciousMetal('XAG'), true);
    assert.equal(isPreciousMetal('XPT'), true);
    assert.equal(isPreciousMetal('XPD'), true);
    assert.equal(isPreciousMetal('xau'), true);
    assert.equal(isPreciousMetal('USD'), false);
    assert.equal(isPreciousMetal('EUR'), false);
    assert.equal(isPreciousMetal('BTC'), false);
    assert.equal(isPreciousMetal('ETH'), false);
    assert.equal(isPreciousMetal(''), false);
    assert.equal(isPreciousMetal(null), false);
  });

  it('should format quantities and rates with explicit unit labeling', () => {
    assert.equal(formatQuantityWithUnit('100', 'USD'), '100 USD');
    assert.equal(formatQuantityWithUnit('0.0416', 'XAU', 'troy-oz'), '0.0416 troy oz XAU');
    assert.equal(formatQuantityWithUnit('1.2939', 'XAU', 'g'), '1.2939 g XAU');

    const rateBig = new Big('2403.8461538');
    assert.equal(
      formatUnitRateWithUnit(rateBig, 'XAU', 'USD', 'troy-oz'),
      '1 troy oz XAU = 2,403.85 USD'
    );
    assert.equal(
      formatUnitRateWithUnit(new Big('77.2854'), 'XAU', 'USD', 'g'),
      '1 g XAU = 77.2854 USD'
    );
    assert.equal(
      formatUnitRateWithUnit(new Big('0.92'), 'USD', 'EUR'),
      '1 USD = 0.92 EUR'
    );
  });

  it('should provide appropriate amount prefix for fiat/crypto and suffix for metals', () => {
    // Fiat prefixes
    assert.equal(getAssetAmountPrefix('USD'), '$');
    assert.equal(getAssetAmountPrefix('EUR'), '€');
    assert.equal(getAssetAmountPrefix('GBP'), '£');
    assert.equal(getAssetAmountPrefix('JPY'), '¥');
    assert.equal(getAssetAmountPrefix('ZAR'), 'R');
    assert.equal(getAssetAmountPrefix('CAD'), 'C$');
    assert.equal(getAssetAmountPrefix('AUD'), 'A$');
    assert.equal(getAssetAmountPrefix('INR'), '₹');
    assert.equal(getAssetAmountPrefix('AED'), 'د.إ');

    // Crypto prefixes (uses existing symbol or ticker)
    assert.equal(getAssetAmountPrefix('BTC'), '₿');
    assert.equal(getAssetAmountPrefix('ETH'), 'Ξ');
    assert.equal(getAssetAmountPrefix('SOL'), 'SOL');
    assert.equal(getAssetAmountPrefix('XRP'), 'XRP');
    assert.equal(getAssetAmountPrefix('DOGE'), 'DOGE');

    // Metals should NOT have prefixes (they use suffixes instead)
    assert.equal(getAssetAmountPrefix('XAU'), '');
    assert.equal(getAssetAmountPrefix('XAG'), '');
    assert.equal(getAssetAmountPrefix('XPT'), '');
    assert.equal(getAssetAmountPrefix('XPD'), '');

    // Metal suffixes
    assert.equal(getAssetAmountSuffix('XAU', 'troy-oz'), 'troy oz');
    assert.equal(getAssetAmountSuffix('XAU', 'g'), 'g');
    assert.equal(getAssetAmountSuffix('XAG', 'troy-oz'), 'troy oz');
    assert.equal(getAssetAmountSuffix('XAG', 'g'), 'g');

    // Non-metals should NOT have suffixes
    assert.equal(getAssetAmountSuffix('USD', 'troy-oz'), '');
    assert.equal(getAssetAmountSuffix('EUR', 'g'), '');
    assert.equal(getAssetAmountSuffix('BTC'), '');
  });
});

describe('M1.6 — Rate Engine & Mock Isolation Invariants', () => {
  it('should verify rate engine is operating in mock mode with USD base = 1', () => {
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(getRate('USD').toFixed(), '1');
  });

  it('should verify all 19 supported assets have valid rates', () => {
    const assets = getSupportedAssets();
    assert.equal(assets.length, 19);
    for (const asset of assets) {
      assert.ok(hasRate(asset.code), `Asset ${asset.code} must have a rate`);
      const r = getRate(asset.code);
      assert.ok(r.gt(0), `Rate for ${asset.code} must be strictly positive`);
    }
  });
});

describe('M1.6 — SEO Metadata & Structured Data', () => {
  it('should generate canonical URLs properly', () => {
    assert.equal(resolveCanonicalUrl('/usd-to-eur', 'https://allfinconverter.com'), 'https://allfinconverter.com/usd-to-eur');
    assert.equal(resolveCanonicalUrl('/gold-to-usd', 'https://allfinconverter.com/'), 'https://allfinconverter.com/gold-to-usd');
  });

  it('should generate valid BreadcrumbList structured data', () => {
    const breadcrumbs = getBreadcrumbStructuredData([
      { name: 'Home', url: 'https://allfinconverter.com/' },
      { name: 'USD to EUR', url: 'https://allfinconverter.com/usd-to-eur' },
    ]);
    assert.equal(breadcrumbs['@type'], 'BreadcrumbList');
    assert.equal(Array.isArray(breadcrumbs.itemListElement), true);
  });
});
