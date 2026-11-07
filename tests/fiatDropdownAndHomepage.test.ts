/**
 * Automated Test Suite for Fiat Currency Dropdown, Homepage Section & Result Precision
 *
 * Verifies:
 * 1. All 21 fiat currencies remain available in getDropdownAssetsByCategory('fiat').
 * 2. The fiat currency list is alphabetically sorted by currency code (ascending).
 * 3. Canonical asset definitions (ASSETS, getSupportedAssets, getAssetsByCategory) are preserved untouched.
 * 4. Cryptocurrency and precious-metal ordering is NOT altered.
 * 5. Default selections ('USD' source, 'EUR' destination) and selection behavior remain intact.
 * 6. RateEngine lookups and conversion calculations work identically.
 * 7. No duplicate entries exist in dropdown assets.
 * 8. Homepage "Supported Asset Classes" section wording matches requirements exactly.
 * 9. Decimal precision rules across fiat (2 fixed decimals), crypto (up to 8, trailing trimmed, small preserved),
 *    and metal (up to 4, trailing trimmed, small preserved).
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Big from 'big.js';

import {
  ASSETS,
  getSupportedAssets,
  getAssetsByCategory,
  getDropdownAssetsByCategory,
  getAsset,
} from '../src/lib/assets.ts';

import { calculateConversion, formatDisplayAmount } from '../src/lib/converter.ts';
import { defaultRateEngine } from '../src/lib/rateEngine.ts';

describe('Alphabetical Fiat Currency Dropdown by Currency Code (Improvement 1)', () => {
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

  it('should sort fiat currencies strictly alphabetically by currency code in ascending order', () => {
    const dropdownFiats = getDropdownAssetsByCategory('fiat');
    const codes = dropdownFiats.map((a) => a.code);

    const sortedCodes = [...codes].sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(codes, sortedCodes, 'Fiat codes must be sorted alphabetically ascending');

    // Expected exact code and full name sequence (all 21 fiats)
    const expectedSequence = [
      { code: 'AED', name: 'UAE Dirham' },
      { code: 'AUD', name: 'Australian Dollar' },
      { code: 'BRL', name: 'Brazilian Real' },
      { code: 'CAD', name: 'Canadian Dollar' },
      { code: 'CHF', name: 'Swiss Franc' },
      { code: 'CNY', name: 'Chinese Yuan' },
      { code: 'DKK', name: 'Danish Krone' },
      { code: 'EUR', name: 'Euro' },
      { code: 'GBP', name: 'British Pound' },
      { code: 'HKD', name: 'Hong Kong Dollar' },
      { code: 'INR', name: 'Indian Rupee' },
      { code: 'JPY', name: 'Japanese Yen' },
      { code: 'KRW', name: 'South Korean Won' },
      { code: 'MXN', name: 'Mexican Peso' },
      { code: 'NOK', name: 'Norwegian Krone' },
      { code: 'NZD', name: 'New Zealand Dollar' },
      { code: 'PLN', name: 'Polish Złoty' },
      { code: 'SEK', name: 'Swedish Krona' },
      { code: 'SGD', name: 'Singapore Dollar' },
      { code: 'USD', name: 'US Dollar' },
      { code: 'ZAR', name: 'South African Rand' },
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

describe('Conversion Result Decimal Precision (Improvement 2)', () => {
  describe('Fiat Currencies', () => {
    it('should always display exactly 2 decimal places for fiat amounts', () => {
      // Basic values
      assert.equal(formatDisplayAmount('123.4', 'USD'), '123.40');
      assert.equal(formatDisplayAmount('123.40', 'EUR'), '123.40');
      assert.equal(formatDisplayAmount('123', 'GBP'), '123.00');
      assert.equal(formatDisplayAmount('92', 'EUR'), '92.00');
      assert.equal(formatDisplayAmount('0', 'USD'), '0.00');
      assert.equal(formatDisplayAmount('0.0', 'JPY'), '0.00');
      assert.equal(formatDisplayAmount(new Big(0), 'GBP'), '0.00');
      assert.equal(formatDisplayAmount('0', 'fiat'), '0.00');

      // Comma thousand-separators with 2 decimal places
      assert.equal(formatDisplayAmount('1234.5', 'USD'), '1,234.50');
      assert.equal(formatDisplayAmount('1000000', 'EUR'), '1,000,000.00');
      assert.equal(formatDisplayAmount('1234567.891', 'fiat'), '1,234,567.89');

      // Works with Big instance
      assert.equal(formatDisplayAmount(new Big('45.6'), 'CAD'), '45.60');
      assert.equal(formatDisplayAmount(new Big('100'), 'AUD'), '100.00');
    });

    it('should format all 21 fiat currencies with exactly 2 decimal places', () => {
      const fiats = getDropdownAssetsByCategory('fiat');
      for (const fiat of fiats) {
        const formatted = formatDisplayAmount('100', fiat.code);
        assert.equal(formatted, '100.00', `Fiat ${fiat.code} must format to 100.00`);
      }
    });
  });

  describe('Cryptocurrencies', () => {
    it('should display up to 8 decimal places and remove unnecessary trailing zeros', () => {
      assert.equal(formatDisplayAmount('1.50000000', 'BTC'), '1.5');
      assert.equal(formatDisplayAmount('100.00000000', 'ETH'), '100');
      assert.equal(formatDisplayAmount('0.12345678', 'SOL'), '0.12345678');
      assert.equal(formatDisplayAmount('0.12345000', 'crypto'), '0.12345');
      assert.equal(formatDisplayAmount('1234.5678', 'XRP'), '1,234.5678');
      assert.equal(formatDisplayAmount('0', 'BTC'), '0');
      assert.equal(formatDisplayAmount('0.0', 'ETH'), '0');
      assert.equal(formatDisplayAmount(new Big(0), 'SOL'), '0');
      assert.equal(formatDisplayAmount('0', 'crypto'), '0');
    });

    it('should never round small non-zero values to zero merely to shorten display', () => {
      // Extremely small amount (< 1e-8)
      const smallAmount = '0.0000000012345';
      const formatted = formatDisplayAmount(smallAmount, 'BTC');
      assert.notEqual(formatted, '0', 'Small crypto value must not round to zero');
      assert.ok(formatted.startsWith('0.00000000123'), 'Small crypto precision must be preserved');

      const tinyAmount = '0.00000000000045';
      const tinyFormatted = formatDisplayAmount(tinyAmount, 'DOGE');
      assert.notEqual(tinyFormatted, '0', 'Tiny crypto value must not round to zero');
      assert.ok(tinyFormatted.includes('45'), 'Significant digits must be retained');
    });
  });

  describe('Precious Metals', () => {
    it('should display up to 4 decimal places and remove unnecessary trailing zeros', () => {
      assert.equal(formatDisplayAmount('25.5000', 'XAU'), '25.5');
      assert.equal(formatDisplayAmount('100.0000', 'XAG'), '100');
      assert.equal(formatDisplayAmount('0.0416', 'XAU'), '0.0416');
      assert.equal(formatDisplayAmount('1.2939', 'XPT'), '1.2939');
      assert.equal(formatDisplayAmount('1234.5678', 'metal'), '1,234.5678');
      assert.equal(formatDisplayAmount('0', 'XPD'), '0');
      assert.equal(formatDisplayAmount('0.0', 'XAG'), '0');
      assert.equal(formatDisplayAmount(new Big(0), 'XPT'), '0');
      assert.equal(formatDisplayAmount('0', 'metal'), '0');
    });

    it('should truncate metal beyond 4 decimals while preserving precision for small amounts', () => {
      // 5 decimals with non-zero 5th decimal
      assert.equal(formatDisplayAmount('1.23456', 'XAU'), '1.2346');

      // Small metal value
      const smallMetal = '0.000012';
      const formattedSmall = formatDisplayAmount(smallMetal, 'XAU');
      assert.notEqual(formattedSmall, '0', 'Small metal value must not round to zero');
    });
  });

  describe('Underlying Calculation Precision', () => {
    it('should preserve full Big.js precision in conversion calculations', () => {
      const conv = calculateConversion('100', 'USD', 'EUR');
      assert.equal(conv.targetAmount.toString(), '92');
      // Verify Big instance methods remain fully accurate
      assert.equal(conv.targetAmount instanceof Big, true);

      // Metal conversion precision
      const metalConv = calculateConversion('100', 'USD', 'XAU');
      assert.ok(metalConv.targetAmount.gt(0));
      // Display formatted value applies metal 4 decimals:
      const displayed = formatDisplayAmount(metalConv.targetAmount, 'XAU');
      assert.equal(displayed, '0.0416');
      // But raw calculation retains more digits:
      assert.ok(metalConv.targetAmount.toString().length > 5);
    });
  });

  describe('Initial Active Rate Display & Snapshot Consistency', () => {
    it('should reflect live snapshot rates when a valid production snapshot is active', () => {
      // Simulate live snapshot where EUR is 0.89823 (as in latestSnapshot.json)
      const liveSnapshot = {
        version: 1,
        providerId: 'allfin-live',
        providerName: 'AllFinConverter Live Composite',
        baseAsset: 'USD',
        timestamp: 1793219424781,
        isMock: false,
        rates: {
          USD: '1',
          EUR: '0.89823',
        },
      };

      const engine = new defaultRateEngine.constructor();
      engine.ingestPayload(liveSnapshot);

      const conv = calculateConversion('100', 'USD', 'EUR', { rateEngine: engine });
      const targetDisplay = formatDisplayAmount(conv.targetAmount, 'EUR');

      // Live rate: 100 USD * 0.89823 = 89.823 EUR -> 89.82 EUR
      assert.equal(targetDisplay, '89.82');
      assert.notEqual(targetDisplay, '92.00', 'Must not present fixed 92.00 when live rates differ');
    });
  });
});
