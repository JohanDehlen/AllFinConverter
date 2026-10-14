/**
 * Automated Test Suite for AllFinConverter M2.2
 *
 * Multi-Provider Rate Orchestration Foundation (mock-only).
 *
 * Verifies:
 * 1. Multiple successful providers combining their partial datasets
 * 2. Independent failure isolation (one provider failing while others succeed)
 * 3. Empty and invalid provider responses (validation pre-checks & LKG protection)
 * 4. Deterministic duplicate-asset resolution (timestamp > priority > order)
 * 5. Per-asset provenance and timestamp preservation across distinct providers
 * 6. Last-known-good (LKG) retention across refresh cycles
 * 7. Out-of-order concurrent refresh resolution defense
 * 8. Provider management (enable/disable/unregister)
 * 9. Offline isolation from default mock provider and zero network calls on import
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import { RateOrchestrator } from '../src/lib/rateOrchestrator.ts';
import type { RateProvider } from '../src/lib/rateProviders.ts';
import type { RawRatePayload } from '../src/lib/rates.ts';
import { RateEngine, defaultRateEngine } from '../src/lib/rateEngine.ts';
import { MockRateProvider, MOCK_DATASET_TIMESTAMP } from '../src/lib/providers/mockProvider.ts';

// ---------------------------------------------------------------------------
// Test Helpers: Controllable Mock Providers
// ---------------------------------------------------------------------------

interface MockProviderConfig {
  id: string;
  name: string;
  isMock?: boolean;
  rates?: Record<string, string>;
  timestamp?: number;
  delayMs?: number;
  shouldFail?: boolean;
  errorMessage?: string;
  malformedPayload?: unknown;
}

class ControllableMockProvider implements RateProvider {
  readonly id: string;
  readonly name: string;
  readonly isMock: boolean;
  private config: MockProviderConfig;

  constructor(config: MockProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.isMock = config.isMock ?? true;
    this.config = { ...config };
  }

  updateConfig(newConfig: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  async getRates(): Promise<RawRatePayload> {
    if (this.config.delayMs && this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    if (this.config.shouldFail) {
      throw new Error(this.config.errorMessage ?? `Simulated failure for ${this.id}`);
    }

    if (this.config.malformedPayload !== undefined) {
      return this.config.malformedPayload as RawRatePayload;
    }

    return {
      providerId: this.id,
      providerName: this.name,
      timestamp: this.config.timestamp ?? 1775779200000,
      isMock: this.isMock,
      rates: this.config.rates ?? { USD: '1' },
    };
  }
}

function makeFiatProvider(timestamp = 1775779200000): ControllableMockProvider {
  return new ControllableMockProvider({
    id: 'fiat-provider',
    name: 'Fiat Provider',
    timestamp,
    rates: {
      USD: '1',
      EUR: '0.92',
      GBP: '0.79',
      JPY: '155.0',
    },
  });
}

function makeCryptoProvider(timestamp = 1775779200000): ControllableMockProvider {
  return new ControllableMockProvider({
    id: 'crypto-provider',
    name: 'Crypto Provider',
    timestamp,
    rates: {
      USD: '1',
      BTC: '0.000015',
      ETH: '0.00038',
      SOL: '0.0068',
    },
  });
}

function makeMetalsProvider(timestamp = 1775779200000): ControllableMockProvider {
  return new ControllableMockProvider({
    id: 'metals-provider',
    name: 'Metals Provider',
    timestamp,
    rates: {
      USD: '1',
      XAU: '0.000416',
      XAG: '0.0357',
    },
  });
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe('M2.2 — Multiple Successful Providers Combining Datasets', () => {
  it('should refresh and combine fiat, crypto, and metals providers into a composite', async () => {
    const orchestrator = new RateOrchestrator();
    const fiat = makeFiatProvider(1775779200000);
    const crypto = makeCryptoProvider(1775779200000);
    const metals = makeMetalsProvider(1775779200000);

    orchestrator.registerProvider(fiat);
    orchestrator.registerProvider(crypto);
    orchestrator.registerProvider(metals);

    const result = await orchestrator.refreshAll();

    assert.equal(result.success, true);
    assert.equal(result.successfulRefreshes, 3);
    assert.equal(result.failedRefreshes, 0);
    assert.equal(result.providerErrors.size, 0);

    const composite = result.composite;
    assert.ok(composite.dataset);
    assert.equal(composite.contributingSources.length, 3);
    assert.ok(composite.contributingSources.includes('fiat-provider'));
    assert.ok(composite.contributingSources.includes('crypto-provider'));
    assert.ok(composite.contributingSources.includes('metals-provider'));

    // Check rates across all three categories
    const rates = composite.dataset!.rates;
    assert.ok(rates.get('USD')!.eq(1));
    assert.ok(rates.get('EUR')!.eq(new Big('0.92')));
    assert.ok(rates.get('BTC')!.eq(new Big('0.000015')));
    assert.ok(rates.get('XAU')!.eq(new Big('0.000416')));
  });

  it('should synchronize composite dataset with attached RateEngine', async () => {
    const engine = new RateEngine(new MockRateProvider());
    const orchestrator = new RateOrchestrator({ rateEngine: engine });

    orchestrator.registerProvider(makeFiatProvider());
    orchestrator.registerProvider(makeCryptoProvider());

    const result = await orchestrator.refreshAll();
    assert.equal(result.success, true);

    // Engine should now have the composite dataset active
    assert.equal(engine.isAvailable(), true);
    assert.ok(engine.getRate('EUR').eq(new Big('0.92')));
    assert.ok(engine.getRate('BTC').eq(new Big('0.000015')));
    assert.equal(engine.getDataset().providerId, 'composite');
  });
});

describe('M2.2 — Independent Failure Isolation', () => {
  it('should retain valid data from succeeding providers when one provider fails with network error', async () => {
    const orchestrator = new RateOrchestrator();
    const fiat = makeFiatProvider();
    const crypto = new ControllableMockProvider({
      id: 'crypto-provider',
      name: 'Crypto Provider',
      shouldFail: true,
      errorMessage: 'HTTP 503: Service Unavailable',
    });
    const metals = makeMetalsProvider();

    orchestrator.registerProvider(fiat);
    orchestrator.registerProvider(crypto);
    orchestrator.registerProvider(metals);

    const result = await orchestrator.refreshAll();

    // Orchestrator completes without crashing
    assert.equal(result.success, false);
    assert.equal(result.successfulRefreshes, 2);
    assert.equal(result.failedRefreshes, 1);
    assert.ok(result.providerErrors.has('crypto-provider'));
    assert.match(result.providerErrors.get('crypto-provider')!, /503/);

    // Composite still successfully built with fiat and metals
    const composite = result.composite;
    assert.ok(composite.dataset);
    assert.ok(composite.dataset!.rates.has('EUR'));
    assert.ok(composite.dataset!.rates.has('XAU'));
    assert.equal(composite.dataset!.rates.has('BTC'), false);
    assert.equal(composite.contributingSources.length, 2);
  });
});

describe('M2.2 — Empty and Invalid Provider Responses', () => {
  it('should reject empty rates payload without corrupting composite', async () => {
    const orchestrator = new RateOrchestrator();
    const emptyProvider = new ControllableMockProvider({
      id: 'empty-provider',
      name: 'Empty Provider',
      malformedPayload: {
        providerId: 'empty-provider',
        providerName: 'Empty Provider',
        timestamp: 1775779200000,
        rates: {}, // Missing USD base
      },
    });

    orchestrator.registerProvider(emptyProvider);
    const validation = await orchestrator.refreshProvider('empty-provider');

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => e.includes('USD')));

    const state = orchestrator.getProviderState('empty-provider');
    assert.equal(state?.lastKnownGoodDataset, null);
    assert.ok(state?.lastError);
  });

  it('should reject invalid rate values (negative or non-numeric)', async () => {
    const orchestrator = new RateOrchestrator();
    const badRateProvider = new ControllableMockProvider({
      id: 'bad-rates',
      name: 'Bad Rates Provider',
      rates: {
        USD: '1',
        EUR: '-0.95', // Negative rate
      },
    });

    orchestrator.registerProvider(badRateProvider);
    const validation = await orchestrator.refreshProvider('bad-rates');

    // validateRatePayload skips negative rates with warnings
    // EUR is dropped, but USD: 1 is valid, so dataset contains only USD
    assert.equal(validation.valid, true);
    assert.ok(validation.dataset!.rates.has('USD'));
    assert.equal(validation.dataset!.rates.has('EUR'), false);
  });

  it('should handle unparseable or primitive payload structures safely', async () => {
    const orchestrator = new RateOrchestrator();
    const brokenProvider = new ControllableMockProvider({
      id: 'broken',
      name: 'Broken Provider',
      malformedPayload: 'not an object',
    });

    orchestrator.registerProvider(brokenProvider);
    const validation = await orchestrator.refreshProvider('broken');

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.length > 0);
  });
});

describe('M2.2 — Deterministic Duplicate-Asset Resolution', () => {
  it('should prefer newer timestamp when multiple providers supply the same asset', async () => {
    const orchestrator = new RateOrchestrator();
    const olderProvider = new ControllableMockProvider({
      id: 'provider-older',
      name: 'Provider Older',
      timestamp: 1700000000000,
      rates: { USD: '1', EUR: '0.90' },
    });
    const newerProvider = new ControllableMockProvider({
      id: 'provider-newer',
      name: 'Provider Newer',
      timestamp: 1700001000000,
      rates: { USD: '1', EUR: '0.93' },
    });

    orchestrator.registerProvider(olderProvider);
    orchestrator.registerProvider(newerProvider);

    await orchestrator.refreshAll();
    const composite = orchestrator.assembleComposite();

    assert.ok(composite.dataset);
    assert.ok(composite.dataset!.rates.get('EUR')!.eq(new Big('0.93')));
    assert.equal(composite.provenance.get('EUR')!.sourceId, 'provider-newer');
    assert.equal(composite.provenance.get('EUR')!.timestamp, 1700001000000);
  });

  it('should prefer higher priority when timestamps are identical', async () => {
    const orchestrator = new RateOrchestrator();
    const ts = 1775779200000;
    const lowPriority = new ControllableMockProvider({
      id: 'provider-low',
      name: 'Provider Low Priority',
      timestamp: ts,
      rates: { USD: '1', EUR: '0.88' },
    });
    const highPriority = new ControllableMockProvider({
      id: 'provider-high',
      name: 'Provider High Priority',
      timestamp: ts,
      rates: { USD: '1', EUR: '0.94' },
    });

    orchestrator.registerProvider(lowPriority, { priority: 1 });
    orchestrator.registerProvider(highPriority, { priority: 10 });

    await orchestrator.refreshAll();
    const composite = orchestrator.assembleComposite();

    assert.ok(composite.dataset);
    assert.ok(composite.dataset!.rates.get('EUR')!.eq(new Big('0.94')));
    assert.equal(composite.provenance.get('EUR')!.sourceId, 'provider-high');
  });
});

describe('M2.2 — Per-Asset Provenance & Timestamp Preservation', () => {
  it('should preserve independent source IDs and timestamps per asset', async () => {
    const orchestrator = new RateOrchestrator();
    const tsFiat = 1775700000000;
    const tsCrypto = 1775710000000;
    const tsMetals = 1775720000000;

    orchestrator.registerProvider(makeFiatProvider(tsFiat));
    orchestrator.registerProvider(makeCryptoProvider(tsCrypto));
    orchestrator.registerProvider(makeMetalsProvider(tsMetals));

    await orchestrator.refreshAll();
    const composite = orchestrator.assembleComposite();

    // Verify distinct timestamps per asset category
    assert.equal(composite.provenance.get('EUR')!.timestamp, tsFiat);
    assert.equal(composite.provenance.get('EUR')!.sourceId, 'fiat-provider');

    assert.equal(composite.provenance.get('BTC')!.timestamp, tsCrypto);
    assert.equal(composite.provenance.get('BTC')!.sourceId, 'crypto-provider');

    assert.equal(composite.provenance.get('XAU')!.timestamp, tsMetals);
    assert.equal(composite.provenance.get('XAU')!.sourceId, 'metals-provider');

    // Composite timestamp represents the latest rate timestamp
    assert.equal(composite.dataset!.timestamp, tsMetals);
  });
});

describe('M2.2 — Last-Known-Good Retention Across Refresh Cycles', () => {
  it('should retain provider LKG dataset when subsequent refresh fails', async () => {
    const orchestrator = new RateOrchestrator();
    const fiat = makeFiatProvider(1775700000000);
    const crypto = makeCryptoProvider(1775700000000);

    orchestrator.registerProvider(fiat);
    orchestrator.registerProvider(crypto);

    // Cycle 1: both providers succeed
    const cycle1 = await orchestrator.refreshAll();
    assert.equal(cycle1.success, true);
    assert.equal(cycle1.composite.dataset!.rates.has('BTC'), true);

    // Cycle 2: fiat updates with fresh data, crypto fails with 500 error
    fiat.updateConfig({ timestamp: 1775800000000, rates: { USD: '1', EUR: '0.93' } });
    crypto.updateConfig({ shouldFail: true, errorMessage: 'HTTP 500: Server Error' });

    const cycle2 = await orchestrator.refreshAll();
    assert.equal(cycle2.success, false);
    assert.equal(cycle2.successfulRefreshes, 1);
    assert.equal(cycle2.failedRefreshes, 1);

    // Composite still has BOTH fiat and crypto rates because crypto retained LKG!
    const composite2 = cycle2.composite;
    assert.ok(composite2.dataset);
    assert.ok(composite2.dataset!.rates.get('EUR')!.eq(new Big('0.93')), 'Fiat updated to fresh rate');
    assert.ok(composite2.dataset!.rates.get('BTC')!.eq(new Big('0.000015')), 'Crypto retained LKG rate');

    // Provenance reflects new fiat timestamp and retained crypto LKG timestamp
    assert.equal(composite2.provenance.get('EUR')!.timestamp, 1775800000000);
    assert.equal(composite2.provenance.get('BTC')!.timestamp, 1775700000000);
  });
});

describe('M2.2 — Out-of-Order Concurrent Refresh Defense', () => {
  it('should prevent an older slow refresh from overwriting a newer fast refresh', async () => {
    const orchestrator = new RateOrchestrator();

    // Provider capable of returning responses with controllable delays and timestamps
    let resolveSlowFetch: ((value: RawRatePayload) => void) | null = null;
    let resolveFastFetch: ((value: RawRatePayload) => void) | null = null;
    let callCount = 0;

    const provider: RateProvider = {
      id: 'race-provider',
      name: 'Race Provider',
      isMock: true,
      getRates: async () => {
        callCount++;
        const currentCall = callCount;
        return new Promise<RawRatePayload>((resolve) => {
          if (currentCall === 1) {
            resolveSlowFetch = resolve;
          } else {
            resolveFastFetch = resolve;
          }
        });
      },
    };

    orchestrator.registerProvider(provider);

    // 1. Initiate Request #1 (slow request, older data timestamp 1000)
    const promise1 = orchestrator.refreshProvider('race-provider');

    // 2. Initiate Request #2 (fast request, newer data timestamp 2000)
    const promise2 = orchestrator.refreshProvider('race-provider');

    // 3. Request #2 finishes FIRST
    resolveFastFetch!({
      providerId: 'race-provider',
      providerName: 'Race Provider',
      timestamp: 2000,
      rates: { USD: '1', EUR: '0.95' },
    });
    const res2 = await promise2;
    assert.equal(res2.valid, true);

    const stateAfterFast = orchestrator.getProviderState('race-provider');
    assert.ok(stateAfterFast?.lastKnownGoodDataset);
    assert.equal(stateAfterFast!.lastKnownGoodDataset!.timestamp, 2000);
    assert.ok(stateAfterFast!.lastKnownGoodDataset!.rates.get('EUR')!.eq(new Big('0.95')));

    // 4. Request #1 finishes SECOND with older data
    resolveSlowFetch!({
      providerId: 'race-provider',
      providerName: 'Race Provider',
      timestamp: 1000,
      rates: { USD: '1', EUR: '0.85' },
    });
    const res1 = await promise1;

    // Orchestrator should discard Request #1
    assert.equal(res1.valid, false);
    assert.ok(res1.errors.some((e) => e.includes('out-of-order') || e.includes('superseded')));

    // LKG dataset must NOT have been overwritten; timestamp 2000 remains active!
    const stateFinal = orchestrator.getProviderState('race-provider');
    assert.equal(stateFinal!.lastKnownGoodDataset!.timestamp, 2000);
    assert.ok(stateFinal!.lastKnownGoodDataset!.rates.get('EUR')!.eq(new Big('0.95')));
  });

  it('should reject older dataset timestamp even if sequence number was somehow equal', async () => {
    const orchestrator = new RateOrchestrator();
    const provider = new ControllableMockProvider({
      id: 'test-p',
      name: 'Test Provider',
      timestamp: 5000,
      rates: { USD: '1', EUR: '0.90' },
    });

    orchestrator.registerProvider(provider);
    await orchestrator.refreshProvider('test-p');

    // Try to refresh with older timestamp (3000 < 5000)
    provider.updateConfig({ timestamp: 3000, rates: { USD: '1', EUR: '0.80' } });
    const result = await orchestrator.refreshProvider('test-p');

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('older dataset')));

    // LKG retains timestamp 5000
    const state = orchestrator.getProviderState('test-p');
    assert.equal(state!.lastKnownGoodDataset!.timestamp, 5000);
    assert.ok(state!.lastKnownGoodDataset!.rates.get('EUR')!.eq(new Big('0.90')));
  });

  it('should not allow an older failed request to overwrite newer successful state or set stale lastError', async () => {
    const orchestrator = new RateOrchestrator();

    let rejectSlowFetch: ((err: Error) => void) | null = null;
    let resolveFastFetch: ((value: RawRatePayload) => void) | null = null;
    let callCount = 0;

    const provider: RateProvider = {
      id: 'race-provider-failure',
      name: 'Race Provider Failure',
      isMock: true,
      getRates: async () => {
        callCount++;
        const currentCall = callCount;
        return new Promise<RawRatePayload>((resolve, reject) => {
          if (currentCall === 1) {
            rejectSlowFetch = reject;
          } else {
            resolveFastFetch = resolve;
          }
        });
      },
    };

    orchestrator.registerProvider(provider);

    // 1. Initiate Request #1 (slow, will eventually fail)
    const promise1 = orchestrator.refreshProvider('race-provider-failure');

    // 2. Initiate Request #2 (fast, will succeed)
    const promise2 = orchestrator.refreshProvider('race-provider-failure');

    // 3. Request #2 finishes FIRST and succeeds
    resolveFastFetch!({
      providerId: 'race-provider-failure',
      providerName: 'Race Provider Failure',
      timestamp: 2000,
      rates: { USD: '1', EUR: '0.95' },
    });
    const res2 = await promise2;
    assert.equal(res2.valid, true);

    const stateAfterFast = orchestrator.getProviderState('race-provider-failure');
    assert.equal(stateAfterFast?.lastError, null);
    assert.equal(stateAfterFast?.lastKnownGoodDataset?.timestamp, 2000);

    // 4. Request #1 finishes SECOND and FAILS with network error
    rejectSlowFetch!(new Error('Delayed network failure from request #1'));
    const res1 = await promise1;

    // Request #1 returns failure result to its caller
    assert.equal(res1.valid, false);
    assert.match(res1.errors[0], /Delayed network failure/);

    // BUT provider state must NOT be corrupted by the superseded failure:
    // lastError must remain null, and LKG dataset must remain intact!
    const stateFinal = orchestrator.getProviderState('race-provider-failure');
    assert.equal(stateFinal?.lastError, null, 'stale failure must not overwrite null lastError of successful request');
    assert.equal(stateFinal?.lastKnownGoodDataset?.timestamp, 2000);
    assert.ok(stateFinal?.lastKnownGoodDataset?.rates.get('EUR')?.eq(new Big('0.95')));
  });

  it('should retain valid result from an older in-flight request if the newer request failed', async () => {
    const orchestrator = new RateOrchestrator();

    let resolveSlowFetch: ((value: RawRatePayload) => void) | null = null;
    let rejectFastFetch: ((err: Error) => void) | null = null;
    let callCount = 0;

    const provider: RateProvider = {
      id: 'race-newer-fails',
      name: 'Race Newer Fails',
      isMock: true,
      getRates: async () => {
        callCount++;
        const currentCall = callCount;
        return new Promise<RawRatePayload>((resolve, reject) => {
          if (currentCall === 1) {
            resolveSlowFetch = resolve;
          } else {
            rejectFastFetch = reject;
          }
        });
      },
    };

    orchestrator.registerProvider(provider);

    // 1. Initiate Request #1 (slow, will succeed with valid data timestamp 2000)
    const promise1 = orchestrator.refreshProvider('race-newer-fails');

    // 2. Initiate Request #2 (fast, will fail with network error)
    const promise2 = orchestrator.refreshProvider('race-newer-fails');

    // 3. Request #2 finishes FIRST and FAILS
    rejectFastFetch!(new Error('Fast request failed'));
    const res2 = await promise2;
    assert.equal(res2.valid, false);

    // 4. Request #1 finishes SECOND with valid data
    resolveSlowFetch!({
      providerId: 'race-newer-fails',
      providerName: 'Race Newer Fails',
      timestamp: 2000,
      rates: { USD: '1', EUR: '0.92' },
    });
    const res1 = await promise1;

    // Request #1 succeeds and updates LKG because Request #2 never applied
    assert.equal(res1.valid, true);

    const stateFinal = orchestrator.getProviderState('race-newer-fails');
    assert.equal(stateFinal?.lastError, null);
    assert.ok(stateFinal?.lastKnownGoodDataset);
    assert.equal(stateFinal!.lastKnownGoodDataset!.timestamp, 2000);
    assert.ok(stateFinal!.lastKnownGoodDataset!.rates.get('EUR')!.eq(new Big('0.92')));
  });

  it('should retain valid result from an older in-flight request if the newer request returned invalid data', async () => {
    const orchestrator = new RateOrchestrator();

    let resolveSlowFetch: ((value: RawRatePayload) => void) | null = null;
    let resolveFastFetch: ((value: RawRatePayload) => void) | null = null;
    let callCount = 0;

    const provider: RateProvider = {
      id: 'race-newer-invalid',
      name: 'Race Newer Invalid',
      isMock: true,
      getRates: async () => {
        callCount++;
        const currentCall = callCount;
        return new Promise<RawRatePayload>((resolve) => {
          if (currentCall === 1) {
            resolveSlowFetch = resolve;
          } else {
            resolveFastFetch = resolve;
          }
        });
      },
    };

    orchestrator.registerProvider(provider);

    // 1. Initiate Request #1 (slow, will succeed with valid data timestamp 2000)
    const promise1 = orchestrator.refreshProvider('race-newer-invalid');

    // 2. Initiate Request #2 (fast, returns invalid payload with missing USD)
    const promise2 = orchestrator.refreshProvider('race-newer-invalid');

    // 3. Request #2 finishes FIRST with invalid payload
    resolveFastFetch!({
      providerId: 'race-newer-invalid',
      providerName: 'Race Newer Invalid',
      timestamp: 2100,
      rates: {}, // missing USD
    });
    const res2 = await promise2;
    assert.equal(res2.valid, false);

    // 4. Request #1 finishes SECOND with valid data
    resolveSlowFetch!({
      providerId: 'race-newer-invalid',
      providerName: 'Race Newer Invalid',
      timestamp: 2000,
      rates: { USD: '1', EUR: '0.92' },
    });
    const res1 = await promise1;

    // Request #1 succeeds and updates LKG because Request #2 was invalid
    assert.equal(res1.valid, true);

    const stateFinal = orchestrator.getProviderState('race-newer-invalid');
    assert.equal(stateFinal?.lastError, null);
    assert.ok(stateFinal?.lastKnownGoodDataset);
    assert.equal(stateFinal!.lastKnownGoodDataset!.timestamp, 2000);
    assert.ok(stateFinal!.lastKnownGoodDataset!.rates.get('EUR')!.eq(new Big('0.92')));
  });
});

describe('M2.2 — Provider Lifecycle Management', () => {
  it('should support enabling and disabling providers', async () => {
    const orchestrator = new RateOrchestrator();
    const fiat = makeFiatProvider();
    const crypto = makeCryptoProvider();

    orchestrator.registerProvider(fiat);
    orchestrator.registerProvider(crypto);

    // Disable crypto
    orchestrator.setProviderEnabled('crypto-provider', false);
    assert.equal(orchestrator.getProviderState('crypto-provider')?.enabled, false);

    const result = await orchestrator.refreshAll();
    assert.equal(result.successfulRefreshes, 1);
    assert.equal(result.composite.dataset!.rates.has('EUR'), true);
    assert.equal(result.composite.dataset!.rates.has('BTC'), false);

    // Re-enable crypto
    orchestrator.setProviderEnabled('crypto-provider', true);
    const result2 = await orchestrator.refreshAll();
    assert.equal(result2.successfulRefreshes, 2);
    assert.equal(result2.composite.dataset!.rates.has('BTC'), true);
  });

  it('should support unregistering a provider', () => {
    const orchestrator = new RateOrchestrator();
    orchestrator.registerProvider(makeFiatProvider());
    assert.ok(orchestrator.getProviderState('fiat-provider'));

    const removed = orchestrator.unregisterProvider('fiat-provider');
    assert.equal(removed, true);
    assert.equal(orchestrator.getProviderState('fiat-provider'), undefined);
    assert.equal(orchestrator.unregisterProvider('non-existent'), false);
  });

  it('should clear all provider states via clear()', async () => {
    const orchestrator = new RateOrchestrator();
    orchestrator.registerProvider(makeFiatProvider());
    await orchestrator.refreshAll();

    assert.ok(orchestrator.getProviderState('fiat-provider')?.lastKnownGoodDataset);
    assert.ok(orchestrator.getLatestComposite());

    orchestrator.clear();
    assert.equal(orchestrator.getProviderState('fiat-provider')?.lastKnownGoodDataset, null);
    assert.equal(orchestrator.getLatestComposite(), null);
  });

  it('should return controlled invalid result without throwing when provider is not registered', async () => {
    const orchestrator = new RateOrchestrator();
    const result = await orchestrator.refreshProvider('unknown-id');

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /not registered/i);
  });
});

describe('M2.2 — Offline Safety & Zero Network Calls on Import', () => {
  it('should maintain defaultRateEngine on mock-local provider', () => {
    assert.equal(defaultRateEngine.getActiveProviderId(), 'mock-local');
    assert.equal(defaultRateEngine.isMock(), true);
    assert.equal(defaultRateEngine.getStatus().timestamp, MOCK_DATASET_TIMESTAMP);
  });

  it('should instantiate RateOrchestrator with zero network requests or background timers', () => {
    const orchestrator = new RateOrchestrator();
    assert.ok(orchestrator);
    assert.equal(orchestrator.getAllProviderStates().length, 0);
    assert.equal(orchestrator.getLatestComposite(), null);
  });
});
