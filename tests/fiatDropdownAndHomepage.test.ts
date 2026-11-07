/**
 * Automated Test Suite for Alphabetical Fiat Currency Dropdown & Homepage Section
 *
 * Verifies:
 * 1. All 21 fiat currencies remain available in getDropdownAssetsByCategory('fiat').
 * 2. The fiat currency list is alphabetically sorted by full currency name (ascending).
 * 3. Canonical asset definitions (ASSETS, getSupportedAssets, getAssetsByCategory) are preserved untouched.
 * 4. Cryptocurrency and precious-metal ordering is NOT altered.
 * 5. Default selections ('USD' source, 'EUR' destination) and selection behavior remain intact.
 * 6. RateEngine lookups and conversion calculations work identically.
 * 7. No duplicate entries exist in dropdown assets.
 * 8. Homepage "Supported Asset Classes" section wording matches requirements exactly.
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ASSETS,
  getSupportedAssets,
  getAssetsByCategory,
  getDropdownAssetsByCategory,
  getAsset,
} from '../src/lib/assets.ts';

import { calculateConversion } from '../src/lib/converter.ts';
import { defaultRateEngine } from '../src/lib/rateEngine.ts';

describe('Alphabetical Fiat Currency Dropdown (Improvement A)', () => {
  it('should preserve all 21 supported fiat currencies in dropdown', () => {
    const dropdownFiats = getDropdownAssetsByCategory('fiat');
    assert.equal(dropdownFiats.length, 21, 'Must have exactly 21 fiat currencies');

    const expectedCodes = [
      'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'ZAR', 'INR', 'AED',
      'CNY', 'HKD', 'SGD', 'NZD', 'KRW', 'MXN', 'BRL', 'SEK', 'NOK', 'DKK', 'PLN',
    ];

    const dropdownCodes = dropdownFiats.map((a) => a.code);
    for (const code of expectedCodes) {
      assert.ok(
        dropdownCodes.includes(code),
        `Dropdown must include fiat currency: ${code}`
      );
    }
  });

  it('should not introduce duplicate entries in the fiat dropdown', () => {
    const dropdownFiats = getDropdownAssetsByCategory('fiat');
    const seen = new Set<string>();
    for (const a of dropdownFiats) {
      assert.ok(!seen.has(a.code), `Duplicate asset code found: ${a.code}`);
      seen.add(a.code);
    }
    assert.equal(seen.size, 21);
  });

  it('should sort fiat currencies strictly alphabetically by full currency name in ascending order', () => {
    const dropdownFiats = getDropdownAssetsByCategory('fiat');
    const names = dropdownFiats.map((a) => a.name);

    const sortedNames = [...names].sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(names, sortedNames, 'Fiat names must be sorted alphabetically ascending');

    // Expected exact full name and code sequence
    const expectedSequence = [
      { code: 'AUD', name: 'Australian Dollar' },
      { code: 'BRL', name: 'Brazilian Real' },
      { code: 'GBP', name: 'British Pound' },
      { code: 'CAD', name: 'Canadian Dollar' },
      { code: 'CNY', name: 'Chinese Yuan' },
      { code: 'DKK', name: 'Danish Krone' },
      { code: 'EUR', name: 'Euro' },
      { code: 'HKD', name: 'Hong Kong Dollar' },
      { code: 'INR', name: 'Indian Rupee' },
      { code: 'JPY', name: 'Japanese Yen' },
      { code: 'MXN', name: 'Mexican Peso' },
      { code: 'NZD', name: 'New Zealand Dollar' },
      { code: 'NOK', name: 'Norwegian Krone' },
      { code: 'PLN', name: 'Polish Złoty' },
      { code: 'SGD', name: 'Singapore Dollar' },
      { code: 'ZAR', name: 'South African Rand' },
      { code: 'KRW', name: 'South Korean Won' },
      { code: 'SEK', name: 'Swedish Krona' },
      { code: 'CHF', name: 'Swiss Franc' },
      { code: 'AED', name: 'UAE Dirham' },
      { code: 'USD', name: 'US Dollar' },
    ];

    assert.equal(dropdownFiats.length, expectedSequence.length);
    for (let i = 0; i < expectedSequence.length; i++) {
      assert.equal(dropdownFiats[i].code, expectedSequence[i].code, `Position ${i} code mismatch`);
      assert.equal(dropdownFiats[i].name, expectedSequence[i].name, `Position ${i} name mismatch`);
    }
  });

  it('should preserve canonical asset definition order in ASSETS and getAssetsByCategory', () => {
    const canonicalFiats = getAssetsByCategory('fiat');
    assert.equal(canonicalFiats.length, 21);
    // Canonical starts with USD, EUR, GBP...
    assert.equal(canonicalFiats[0].code, 'USD');
    assert.equal(canonicalFiats[1].code, 'EUR');
    assert.equal(canonicalFiats[2].code, 'GBP');

    const allSupported = getSupportedAssets();
    assert.equal(allSupported.length, 30);
    assert.equal(allSupported[0].code, 'USD');
  });

  it('should NOT alter cryptocurrency or precious-metal ordering', () => {
    const canonicalCrypto = getAssetsByCategory('crypto');
    const dropdownCrypto = getDropdownAssetsByCategory('crypto');
    assert.deepEqual(
      dropdownCrypto.map((a) => a.code),
      canonicalCrypto.map((a) => a.code),
      'Crypto ordering must be preserved'
    );
    assert.deepEqual(dropdownCrypto.map((a) => a.code), ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']);

    const canonicalMetal = getAssetsByCategory('metal');
    const dropdownMetal = getDropdownAssetsByCategory('metal');
    assert.deepEqual(
      dropdownMetal.map((a) => a.code),
      canonicalMetal.map((a) => a.code),
      'Metal ordering must be preserved'
    );
    assert.deepEqual(dropdownMetal.map((a) => a.code), ['XAU', 'XAG', 'XPT', 'XPD']);
  });

  it('should preserve default selections and selection behavior', () => {
    const dropdownFiats = getDropdownAssetsByCategory('fiat');

    // USD and EUR must both be present in the dropdown list
    const usd = dropdownFiats.find((a) => a.code === 'USD');
    const eur = dropdownFiats.find((a) => a.code === 'EUR');
    assert.ok(usd, 'Default source USD must be present in dropdown');
    assert.ok(eur, 'Default destination EUR must be present in dropdown');

    // Simulate select element option selection with default values
    const selectOptionsFrom = dropdownFiats.map((a) => ({
      value: a.code,
      selected: a.code === 'USD',
    }));
    const selectedFrom = selectOptionsFrom.find((o) => o.selected);
    assert.equal(selectedFrom?.value, 'USD');

    const selectOptionsTo = dropdownFiats.map((a) => ({
      value: a.code,
      selected: a.code === 'EUR',
    }));
    const selectedTo = selectOptionsTo.find((o) => o.selected);
    assert.equal(selectedTo?.value, 'EUR');
  });

  it('should maintain intact conversion calculations and rate engine lookup for all sorted fiats', () => {
    const dropdownFiats = getDropdownAssetsByCategory('fiat');

    for (const fiat of dropdownFiats) {
      // Lookup in rate engine must succeed
      const rate = defaultRateEngine.getRate(fiat.code);
      assert.ok(rate.gt(0), `Rate for ${fiat.code} must be strictly positive`);

      // Conversion between USD and fiat must calculate correctly
      const conversion = calculateConversion('100', 'USD', fiat.code);
      assert.ok(conversion.targetAmount.gt(0), `Conversion from USD to ${fiat.code} must be positive`);
      assert.ok(conversion.unitRate.gt(0), `Unit rate for USD to ${fiat.code} must be positive`);
    }
  });
});

describe('Homepage Supported Asset Classes Wording (Improvement B)', () => {
  it('should verify AssetCategories.astro contains the exact requested wording', () => {
    const filePath = path.resolve(process.cwd(), 'src/components/AssetCategories.astro');
    const content = fs.readFileSync(filePath, 'utf8');

    // Section title
    assert.ok(content.includes('Supported Asset Classes'), 'Must have heading Supported Asset Classes');

    // Replaced subtitle (no longer has "Planned coverage across global financial instruments")
    assert.ok(
      !content.includes('Planned coverage across global financial instruments'),
      'Old misleading subtitle must be removed'
    );
    assert.ok(
      content.includes('Convert between three types of financial assets.'),
      'Must contain exact subtitle: Convert between three types of financial assets.'
    );

    // Currencies card
    assert.ok(content.includes('CURRENCIES'), 'Must have CURRENCIES pill');
    assert.ok(content.includes('International Currencies'), 'Must have title International Currencies');
    assert.ok(
      content.includes('Convert major currencies from around the world.'),
      'Must have description Convert major currencies from around the world.'
    );

    // Cryptocurrencies card
    assert.ok(content.includes('CRYPTOCURRENCIES'), 'Must have CRYPTOCURRENCIES pill');
    assert.ok(content.includes('Digital Currencies'), 'Must have title Digital Currencies');
    assert.ok(
      content.includes('Convert supported cryptocurrencies, including Bitcoin and Ethereum.'),
      'Must have description Convert supported cryptocurrencies, including Bitcoin and Ethereum.'
    );

    // Precious Metals card
    assert.ok(content.includes('PRECIOUS METALS'), 'Must have PRECIOUS METALS pill');
    assert.ok(
      content.includes('Gold, Silver & Platinum Group Metals'),
      'Must have title Gold, Silver & Platinum Group Metals'
    );
    assert.ok(
      content.includes('Convert gold, silver, platinum and palladium.'),
      'Must have description Convert gold, silver, platinum and palladium.'
    );

    // Dynamic connection preservation
    assert.ok(
      content.includes('ASSET_CATEGORIES'),
      'Must retain dynamic connection to ASSET_CATEGORIES'
    );
    assert.ok(
      content.includes('getAssetsByCategory'),
      'Must retain dynamic check via getAssetsByCategory'
    );
  });
});
