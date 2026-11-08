/**
 * Automated Test Suite for Converter Navigation on SEO Pair Pages
 *
 * Verifies:
 * 1. Changing either asset on an SEO pair page navigates to homepage ('/') if the pair no longer matches.
 * 2. Swapping assets on an SEO pair page navigates to homepage ('/') if the pair no longer matches.
 * 3. Changing to the exact same pair on an SEO pair page does NOT trigger navigation.
 * 4. Normal converter operation on the homepage ('/') never triggers navigation.
 * 5. Selected first asset, second asset, and entered amount are preserved across navigation via sessionStorage.
 * 6. Homepage restores the preserved state (from, to, amount, units, active side) and recalculates correctly.
 * 7. Storage item is consumed and cleared upon homepage load so subsequent visits use default state.
 * 8. Invalid or unknown asset codes in storage are safely ignored.
 */

// @ts-ignore
import { describe, it, beforeEach } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Big from 'big.js';

import { getAsset } from '../src/lib/assets.ts';
import { calculateConversion, formatDisplayAmount } from '../src/lib/converter.ts';

/**
 * In-memory Mock Storage for simulating browser sessionStorage.
 */
class MockStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Simulates the Converter client-side navigation logic from Converter.astro.
 */
class SimulatedConverterClient {
  isPairPage: boolean;
  expectedFrom: string;
  expectedTo: string;
  assetFrom: string;
  assetTo: string;
  amountFrom: string;
  amountTo: string;
  activeSide: 'from' | 'to';
  fromUnit: 'troy-oz' | 'g';
  toUnit: 'troy-oz' | 'g';
  navigatedTo: string | null = null;
  storage: MockStorage;

  static readonly STORAGE_KEY = 'allfin_nav_state';

  constructor(options: {
    isPairPage: boolean;
    expectedFrom?: string;
    expectedTo?: string;
    initialFrom?: string;
    initialTo?: string;
    initialAmount?: string;
    storage?: MockStorage;
  }) {
    this.isPairPage = options.isPairPage;
    this.expectedFrom = options.expectedFrom ?? (options.isPairPage ? (options.initialFrom ?? 'USD') : '');
    this.expectedTo = options.expectedTo ?? (options.isPairPage ? (options.initialTo ?? 'EUR') : '');
    this.assetFrom = options.initialFrom ?? 'USD';
    this.assetTo = options.initialTo ?? 'EUR';
    this.amountFrom = options.initialAmount ?? '1';
    this.amountTo = '';
    this.activeSide = 'from';
    this.fromUnit = 'troy-oz';
    this.toUnit = 'troy-oz';
    this.storage = options.storage ?? new MockStorage();

    this.init();
  }

  init(): void {
    // On the homepage, restore state if visitor navigated from an SEO pair page
    if (!this.isPairPage) {
      try {
        const rawNav = this.storage.getItem(SimulatedConverterClient.STORAGE_KEY);
        if (rawNav) {
          this.storage.removeItem(SimulatedConverterClient.STORAGE_KEY);
          const navState = JSON.parse(rawNav);
          if (navState && typeof navState === 'object') {
            if (typeof navState.from === 'string' && getAsset(navState.from)) {
              this.assetFrom = navState.from;
            }
            if (typeof navState.to === 'string' && getAsset(navState.to)) {
              this.assetTo = navState.to;
            }
            if (navState.fromUnit === 'troy-oz' || navState.fromUnit === 'g') {
              this.fromUnit = navState.fromUnit;
            }
            if (navState.toUnit === 'troy-oz' || navState.toUnit === 'g') {
              this.toUnit = navState.toUnit;
            }
            if (typeof navState.amount === 'string' && navState.amount.trim() !== '') {
              if (navState.activeSide === 'to') {
                this.amountTo = navState.amount;
                this.activeSide = 'to';
              } else {
                this.amountFrom = navState.amount;
                this.activeSide = 'from';
              }
            }
          }
        }
      } catch {}
    }

    // Ensure designated pair is restored if browser restored form state on an SEO pair page
    this.restoreDesignatedPair();

    this.recalculate();
  }

  restoreDesignatedPair(): boolean {
    if (!this.isPairPage || !this.expectedFrom || !this.expectedTo) return false;
    if (this.assetFrom !== this.expectedFrom || this.assetTo !== this.expectedTo) {
      this.assetFrom = this.expectedFrom;
      this.assetTo = this.expectedTo;
      this.fromUnit = 'troy-oz';
      this.toUnit = 'troy-oz';
      this.activeSide = 'from';
      this.amountTo = '';
      this.recalculate();
      return true;
    }
    return false;
  }

  handlePageShow(persisted: boolean): void {
    if (!this.isPairPage || !this.expectedFrom || !this.expectedTo) return;
    if (persisted || this.assetFrom !== this.expectedFrom || this.assetTo !== this.expectedTo) {
      this.restoreDesignatedPair();
    }
  }

  checkPairPageNavigation(): boolean {
    if (!this.isPairPage || !this.expectedFrom || !this.expectedTo) return false;
    const currentFrom = this.assetFrom;
    const currentTo = this.assetTo;
    if (currentFrom !== this.expectedFrom || currentTo !== this.expectedTo) {
      try {
        const activeInputVal = this.activeSide === 'to' ? this.amountTo : this.amountFrom;
        const state = {
          from: currentFrom,
          to: currentTo,
          amount: activeInputVal,
          activeSide: this.activeSide,
          fromUnit: this.fromUnit,
          toUnit: this.toUnit,
        };
        this.storage.setItem(SimulatedConverterClient.STORAGE_KEY, JSON.stringify(state));
      } catch {}
      this.navigatedTo = '/';
      return true;
    }
    return false;
  }

  changeAssetFrom(newCode: string): void {
    this.assetFrom = newCode;
    this.fromUnit = 'troy-oz';
    if (this.checkPairPageNavigation()) return;
    this.recalculate();
  }

  changeAssetTo(newCode: string): void {
    this.assetTo = newCode;
    this.toUnit = 'troy-oz';
    if (this.checkPairPageNavigation()) return;
    this.recalculate();
  }

  swap(): void {
    const prevFromCode = this.assetFrom;
    const prevToCode = this.assetTo;
    this.assetFrom = prevToCode;
    this.assetTo = prevFromCode;

    const prevFromVal = this.amountFrom;
    const prevToVal = this.amountTo;
    this.amountFrom = prevToVal;
    this.amountTo = prevFromVal;

    const prevFromUnit = this.fromUnit;
    this.fromUnit = this.toUnit;
    this.toUnit = prevFromUnit;

    this.activeSide = 'from';

    if (this.checkPairPageNavigation()) return;

    this.recalculate();
  }

  recalculate(): void {
    try {
      if (this.activeSide === 'from') {
        const res = calculateConversion(this.amountFrom || '0', this.assetFrom, this.assetTo);
        this.amountTo = formatDisplayAmount(res.targetAmount, this.assetTo);
      } else {
        const res = calculateConversion(this.amountTo || '0', this.assetTo, this.assetFrom);
        this.amountFrom = formatDisplayAmount(res.targetAmount, this.assetFrom);
      }
    } catch {}
  }
}

describe('SEO Pair Page Converter Navigation & State Preservation', () => {
  let sharedStorage: MockStorage;

  beforeEach(() => {
    sharedStorage = new MockStorage();
  });

  it('should navigate to homepage and save state when assetFrom is changed on a pair page', () => {
    // Given: visitor is on the PLN to USD pair page (/pln-to-usd/)
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'PLN',
      initialTo: 'USD',
      initialAmount: '100',
      storage: sharedStorage,
    });

    assert.equal(pairClient.navigatedTo, null, 'Should not navigate on initial load');

    // When: visitor changes source asset from PLN to EUR
    pairClient.changeAssetFrom('EUR');

    // Then: client navigates to homepage and state is saved in storage
    assert.equal(pairClient.navigatedTo, '/');
    const saved = JSON.parse(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY)!);
    assert.deepEqual(saved, {
      from: 'EUR',
      to: 'USD',
      amount: '100',
      activeSide: 'from',
      fromUnit: 'troy-oz',
      toUnit: 'troy-oz',
    });

    // When: homepage loads in the browser
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });

    // Then: homepage displays the visitor-selected EUR to USD with preserved amount 100
    assert.equal(homeClient.assetFrom, 'EUR');
    assert.equal(homeClient.assetTo, 'USD');
    assert.equal(homeClient.amountFrom, '100');
    assert.ok(Number(homeClient.amountTo) > 0, 'Target amount must be calculated');
    assert.equal(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY), null, 'Storage must be cleared after consumption');
  });

  it('should navigate to homepage and save state when assetTo is changed on a pair page', () => {
    // Given: visitor is on the USD to JPY pair page (/usd-to-jpy/)
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'USD',
      initialTo: 'JPY',
      initialAmount: '250',
      storage: sharedStorage,
    });

    // When: visitor changes target asset to CAD
    pairClient.changeAssetTo('CAD');

    // Then: client navigates to homepage
    assert.equal(pairClient.navigatedTo, '/');
    const saved = JSON.parse(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY)!);
    assert.equal(saved.from, 'USD');
    assert.equal(saved.to, 'CAD');
    assert.equal(saved.amount, '250');

    // When: homepage loads
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });

    // Then: homepage displays USD to CAD with amount 250
    assert.equal(homeClient.assetFrom, 'USD');
    assert.equal(homeClient.assetTo, 'CAD');
    assert.equal(homeClient.amountFrom, '250');
  });

  it('should navigate to homepage when swap is clicked on a pair page', () => {
    // Given: visitor is on the PLN to USD pair page (/pln-to-usd/)
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'PLN',
      initialTo: 'USD',
      initialAmount: '500',
      storage: sharedStorage,
    });

    // When: visitor clicks swap button
    pairClient.swap();

    // Then: navigates to homepage with swapped pair (USD to PLN)
    assert.equal(pairClient.navigatedTo, '/');
    const saved = JSON.parse(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY)!);
    assert.equal(saved.from, 'USD');
    assert.equal(saved.to, 'PLN');

    // When: homepage loads
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });

    assert.equal(homeClient.assetFrom, 'USD');
    assert.equal(homeClient.assetTo, 'PLN');
  });

  it('should NOT navigate if selected pair still matches the SEO page', () => {
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'USD',
      initialTo: 'EUR',
      initialAmount: '100',
      storage: sharedStorage,
    });

    // Selecting the same asset
    pairClient.changeAssetFrom('USD');
    assert.equal(pairClient.navigatedTo, null, 'Must not navigate when pair still matches');
    assert.equal(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY), null);

    pairClient.changeAssetTo('EUR');
    assert.equal(pairClient.navigatedTo, null, 'Must not navigate when pair still matches');
    assert.equal(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY), null);
  });

  it('should NOT navigate on the homepage when changing assets or swapping', () => {
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      initialFrom: 'USD',
      initialTo: 'EUR',
      initialAmount: '100',
      storage: sharedStorage,
    });

    homeClient.changeAssetFrom('GBP');
    assert.equal(homeClient.navigatedTo, null, 'Homepage must never navigate on from change');
    assert.equal(homeClient.assetFrom, 'GBP');

    homeClient.changeAssetTo('JPY');
    assert.equal(homeClient.navigatedTo, null, 'Homepage must never navigate on to change');
    assert.equal(homeClient.assetTo, 'JPY');

    homeClient.swap();
    assert.equal(homeClient.navigatedTo, null, 'Homepage must never navigate on swap');
    assert.equal(homeClient.assetFrom, 'JPY');
    assert.equal(homeClient.assetTo, 'GBP');
  });

  it('should use one as the initial amount and preserve the entered amount when changing either asset', () => {
    const converterSource = readFileSync(
      new URL('../src/components/Converter.astro', import.meta.url),
      'utf8'
    );
    assert.match(converterSource, /initialAmount = '1'/);
    assert.match(converterSource, /amountFrom\.value = prevToVal;\s*amountTo\.value = prevFromVal;/);

    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      initialFrom: 'USD',
      initialTo: 'EUR',
      storage: sharedStorage,
    });
    assert.equal(homeClient.amountFrom, '1');

    homeClient.amountFrom = '25.50';
    homeClient.recalculate();
    homeClient.changeAssetFrom('GBP');
    assert.equal(homeClient.amountFrom, '25.50');

    homeClient.changeAssetTo('JPY');
    assert.equal(homeClient.amountFrom, '25.50');
  });

  it('should preserve the entered amount on the destination side when swapping assets', () => {
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      initialFrom: 'USD',
      initialTo: 'EUR',
      initialAmount: '5',
      storage: sharedStorage,
    });

    const convertedAmount = homeClient.amountTo;
    homeClient.swap();

    assert.equal(homeClient.assetFrom, 'EUR');
    assert.equal(homeClient.assetTo, 'USD');
    assert.equal(new Big(homeClient.amountFrom).eq(new Big(convertedAmount)), true);
    assert.equal(new Big(homeClient.amountTo).eq(new Big('5')), true);
  });

  it('should preserve activeSide when destination amount was edited', () => {
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'USD',
      initialTo: 'EUR',
      initialAmount: '100',
      storage: sharedStorage,
    });

    // Simulate user editing amountTo
    pairClient.amountTo = '42.50';
    pairClient.activeSide = 'to';

    // User changes assetFrom to CAD
    pairClient.changeAssetFrom('CAD');

    assert.equal(pairClient.navigatedTo, '/');
    const saved = JSON.parse(sharedStorage.getItem(SimulatedConverterClient.STORAGE_KEY)!);
    assert.equal(saved.activeSide, 'to');
    assert.equal(saved.amount, '42.50');

    // Homepage loads
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });

    assert.equal(homeClient.assetFrom, 'CAD');
    assert.equal(homeClient.assetTo, 'EUR');
    assert.equal(homeClient.activeSide, 'to');
    assert.equal(homeClient.amountTo, '42.50');
  });

  it('should safely ignore corrupted or unknown asset codes in storage', () => {
    sharedStorage.setItem(
      SimulatedConverterClient.STORAGE_KEY,
      JSON.stringify({
        from: 'FAKE_ASSET_XYZ',
        to: 'USD',
        amount: '100',
      })
    );

    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });

    // from remains default USD because FAKE_ASSET_XYZ is invalid
    assert.equal(homeClient.assetFrom, 'USD');
    assert.equal(homeClient.assetTo, 'USD');
  });

  it('should handle unparseable JSON in storage gracefully', () => {
    sharedStorage.setItem(SimulatedConverterClient.STORAGE_KEY, '{ invalid json');

    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });

    assert.equal(homeClient.assetFrom, 'USD');
    assert.equal(homeClient.assetTo, 'EUR');
  });

  it('should restore designated pair and recalculate when browser Back returns to pair page via bfcache', () => {
    const newPairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'PLN',
      initialTo: 'USD',
      storage: sharedStorage,
    });
    assert.equal(newPairClient.amountFrom, '1', 'a newly opened converter must start with amount 1');

    // Given: visitor is on the PLN to USD pair page (/pln-to-usd/)
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'PLN',
      initialTo: 'USD',
      initialAmount: '100',
      storage: sharedStorage,
    });

    pairClient.amountFrom = '250';
    pairClient.recalculate();
    const initialUsdTarget = pairClient.amountTo;
    assert.ok(Number(initialUsdTarget) > 0, 'Target amount must be calculated for USD initially');

    // When: visitor changes destination currency from USD to EUR
    pairClient.changeAssetTo('EUR');

    // Then: redirects to homepage
    assert.equal(pairClient.navigatedTo, '/');

    // Simulated bfcache state before pageshow: assetTo is EUR, but amountTo is still old USD conversion
    assert.equal(pairClient.assetFrom, 'PLN');
    assert.equal(pairClient.assetTo, 'EUR');
    assert.equal(pairClient.amountTo, initialUsdTarget, 'amountTo retained stale USD value prior to restoration');

    // When: homepage loads and consumes saved state
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      storage: sharedStorage,
    });
    assert.equal(homeClient.assetFrom, 'PLN');
    assert.equal(homeClient.assetTo, 'EUR');

    // When: visitor clicks browser Back button returning to /pln-to-usd/ (bfcache pageshow fires)
    pairClient.handlePageShow(true);

    // Then: designated pair PLN -> USD is fully restored
    assert.equal(pairClient.assetFrom, 'PLN', 'assetFrom must be PLN');
    assert.equal(pairClient.assetTo, 'USD', 'assetTo must be USD');
    assert.equal(pairClient.amountFrom, '250', 'the entered source amount must be preserved');
    assert.equal(pairClient.activeSide, 'from', 'activeSide must be from');

    // And: calculated result agrees with displayed currencies
    const expectedConversion = calculateConversion('250', 'PLN', 'USD');
    const expectedTarget = formatDisplayAmount(expectedConversion.targetAmount, 'USD');
    assert.equal(pairClient.amountTo, expectedTarget, 'Calculated result must agree with PLN -> USD');
  });

  it('should restore designated pair when user swapped on pair page and then navigated back via bfcache', () => {
    // Given: visitor is on the PLN to USD pair page (/pln-to-usd/)
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'PLN',
      initialTo: 'USD',
      initialAmount: '100',
      storage: sharedStorage,
    });

    // When: visitor clicks swap button
    pairClient.swap();
    assert.equal(pairClient.navigatedTo, '/');

    // Simulated bfcache state has swapped values (USD -> PLN)
    assert.equal(pairClient.assetFrom, 'USD');
    assert.equal(pairClient.assetTo, 'PLN');

    // When: visitor clicks browser Back button returning to /pln-to-usd/
    const preservedSourceAmount = pairClient.amountFrom;
    pairClient.handlePageShow(true);

    // Then: designated pair PLN -> USD is restored
    assert.equal(pairClient.assetFrom, 'PLN');
    assert.equal(pairClient.assetTo, 'USD');
    assert.equal(pairClient.amountFrom, preservedSourceAmount);

    const expectedConversion = calculateConversion(preservedSourceAmount, 'PLN', 'USD');
    assert.equal(pairClient.amountTo, formatDisplayAmount(expectedConversion.targetAmount, 'USD'));
  });

  it('should restore designated pair on non-bfcache navigation when browser restored stale form state', () => {
    // Simulating browser form autofill restoring modified select value on page reload / history navigation
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      expectedFrom: 'PLN',
      expectedTo: 'USD',
      initialFrom: 'PLN',
      initialTo: 'EUR', // Stale restored form value
      initialAmount: '100',
      storage: sharedStorage,
    });

    // Upon initialization, designated pair must be enforced
    assert.equal(pairClient.assetFrom, 'PLN');
    assert.equal(pairClient.assetTo, 'USD');
    assert.equal(pairClient.amountFrom, '100');

    const expectedConversion = calculateConversion('100', 'PLN', 'USD');
    assert.equal(pairClient.amountTo, formatDisplayAmount(expectedConversion.targetAmount, 'USD'));
  });

  it('should preserve entered amount when browser Back returns to pair page and pair was NOT changed', () => {
    // Given: visitor on /pln-to-usd/ enters custom amount 500 without changing pair
    const pairClient = new SimulatedConverterClient({
      isPairPage: true,
      initialFrom: 'PLN',
      initialTo: 'USD',
      initialAmount: '100',
      storage: sharedStorage,
    });

    pairClient.amountFrom = '500';
    pairClient.recalculate();
    const expectedTarget500 = pairClient.amountTo;

    // When: visitor navigates away to another page (not converter-triggered) and clicks Back
    pairClient.handlePageShow(true);

    // Then: amount is preserved because the pair was never changed away from designated pair
    assert.equal(pairClient.assetFrom, 'PLN');
    assert.equal(pairClient.assetTo, 'USD');
    assert.equal(pairClient.amountFrom, '500');
    assert.equal(pairClient.amountTo, expectedTarget500);
  });

  it('should not alter homepage state when pageshow fires on homepage', () => {
    const homeClient = new SimulatedConverterClient({
      isPairPage: false,
      initialFrom: 'GBP',
      initialTo: 'JPY',
      initialAmount: '75',
      storage: sharedStorage,
    });

    const originalTarget = homeClient.amountTo;

    // When: pageshow fires on homepage
    homeClient.handlePageShow(true);

    // Then: homepage state is unchanged
    assert.equal(homeClient.assetFrom, 'GBP');
    assert.equal(homeClient.assetTo, 'JPY');
    assert.equal(homeClient.amountFrom, '75');
    assert.equal(homeClient.amountTo, originalTarget);
  });
});
