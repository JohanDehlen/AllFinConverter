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
    this.amountFrom = options.initialAmount ?? '100';
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

    this.recalculate();
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
});
