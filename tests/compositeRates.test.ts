/**
 * Automated Test Suite for AllFinConverter M2.0
 *
 * Multi-provider composite rate architecture foundation (mock-only).
 *
 * Verifies:
 * 1. Combining partial datasets from multiple independent providers
 * 2. Per-rate source identity and timestamp provenance tracking
 * 3. Source-failure resilience (one failed source doesn't discard others)
 * 4. Strict validation of invalid/malformed data in composite assembly
 * 5. Priority and timestamp-based conflict resolution
 * 6. Integration with existing RateEngine.setDataset() path
 * 7. Backward compatibility with single-provider mock path
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  mergeSourceDatasets,
  type SourceDataset,
  type RateProvenance,
} from '../src/lib/compositeRates.ts';

import {
  validateRatePayload,
  RateEngine,
} from '../src/lib/rateEngine.ts';

import type {
  NormalizedRateDataset,
  RawRatePayload,
} from '../src/lib/rates.ts';

import { MockRateProvider, MOCK_DATASET_TIMESTAMP } from '../src/lib/providers/mockProvider.ts';

// ---------------------------------------------------------------------------
// Test helpers: create validated datasets from raw payloads
// ---------------------------------------------------------------------------

function makeValidatedDataset(payload: RawRatePayload): NormalizedRateDataset {
  const result = validateRatePayload(payload);
  if (!result.valid || !result.dataset) {
    throw new Error(`Test helper: payload validation failed: ${result.errors.join('; ')}`);
  }
  return result.dataset;
}

/** Simulated fiat-only provider (like Frankfurter) */
function makeFiatDataset(timestamp: number): NormalizedRateDataset {
  return makeValidatedDataset({
    providerId: 'frankfurter',
    providerName: 'Frankfurter FX',
    timestamp,
    isMock: false,
    rates: {
      USD: '1',
      EUR: '0.91',
      GBP: '0.78',
      JPY: '156.0',
      CHF: '0.89',
      CAD: '1.37',
      AUD: '1.53',
      ZAR: '18.50',
      INR: '84.00',
      AED: '3.67',
    },
  });
}

/** Simulated crypto-only provider (like CoinGecko) */
function makeCryptoDataset(timestamp: number): NormalizedRateDataset {
  return makeValidatedDataset({
    providerId: 'coingecko',
    providerName: 'CoinGecko Crypto',
    timestamp,
    isMock: false,
    rates: {
      USD: '1',
      BTC: '0.000014',
      ETH: '0.00035',
      SOL: '0.0065',
      XRP: '1.90',
      DOGE: '8.50',
    },
  });
}

/** Simulated precious metals provider (like Gold API) */
function makeMetalsDataset(timestamp: number): NormalizedRateDataset {
  return makeValidatedDataset({
    providerId: 'goldapi',
    providerName: 'Gold API',
    timestamp,
    isMock: false,
    rates: {
      USD: '1',
      XAU: '0.000410',
      XAG: '0.035',
      XPT: '0.00100',
      XPD: '0.00098',
    },
  });
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe('M2.0 — Composite Assembly: Combining Multiple Sources', () => {
  it('should merge fiat, crypto and metals sources into one dataset', () => {
    const ts = Date.now();
    const fiat = makeFiatDataset(ts);
    const crypto = makeCryptoDataset(ts);
    const metals = makeMetalsDataset(ts);

    const result = mergeSourceDatasets([
      { dataset: fiat },
      { dataset: crypto },
      { dataset: metals },
    ]);

    assert.ok(result.dataset, 'Composite dataset should be produced');
    const ds = result.dataset!;

    // Should contain all rates from all three sources (unique codes merged)
    // fiat: USD EUR GBP JPY CHF CAD AUD ZAR INR AED = 10
    // crypto: USD BTC ETH SOL XRP DOGE = 6 (USD already in fiat, so +5 new)
    // metals: USD XAU XAG XPT XPD = 5 (USD already present, so +4 new)
    // Total unique: 10 + 5 + 4 = 19
    assert.equal(ds.rates.size, 19, 'Should have 19 unique asset rates');

    // USD base is correct
    assert.ok(ds.rates.get('USD')!.eq(1), 'USD must be exactly 1');
    assert.equal(ds.baseAsset, 'USD');

    // Fiat rates present
    assert.ok(ds.rates.get('EUR')!.eq(new Big('0.91')));
    assert.ok(ds.rates.get('GBP')!.eq(new Big('0.78')));

    // Crypto rates present
    assert.ok(ds.rates.get('BTC')!.eq(new Big('0.000014')));
    assert.ok(ds.rates.get('ETH')!.eq(new Big('0.00035')));

    // Metals rates present
    assert.ok(ds.rates.get('XAU')!.eq(new Big('0.000410')));
    assert.ok(ds.rates.get('XAG')!.eq(new Big('0.035')));
  });

  it('should report all contributing sources', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
      { dataset: makeCryptoDataset(ts) },
      { dataset: makeMetalsDataset(ts) },
    ]);

    assert.ok(result.dataset);
    assert.equal(result.contributingSources.length, 3);
    assert.ok(result.contributingSources.includes('frankfurter'));
    assert.ok(result.contributingSources.includes('coingecko'));
    assert.ok(result.contributingSources.includes('goldapi'));
  });

  it('should produce a valid composite from a single source', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([{ dataset: makeFiatDataset(ts) }]);

    assert.ok(result.dataset);
    assert.equal(result.dataset!.rates.size, 10);
    assert.equal(result.contributingSources.length, 1);
    assert.ok(result.contributingSources.includes('frankfurter'));
  });
});

describe('M2.0 — Per-Rate Provenance and Timestamp Tracking', () => {
  it('should track the correct source provider for each rate', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
      { dataset: makeCryptoDataset(ts) },
      { dataset: makeMetalsDataset(ts) },
    ]);

    assert.ok(result.provenance.size > 0);

    // Fiat rates should trace to frankfurter
    const eurProv = result.provenance.get('EUR')!;
    assert.equal(eurProv.sourceId, 'frankfurter');
    assert.equal(eurProv.sourceName, 'Frankfurter FX');
    assert.equal(eurProv.timestamp, ts);

    // Crypto rates should trace to coingecko
    const btcProv = result.provenance.get('BTC')!;
    assert.equal(btcProv.sourceId, 'coingecko');
    assert.equal(btcProv.sourceName, 'CoinGecko Crypto');
    assert.equal(btcProv.timestamp, ts);

    // Metals rates should trace to goldapi
    const xauProv = result.provenance.get('XAU')!;
    assert.equal(xauProv.sourceId, 'goldapi');
    assert.equal(xauProv.sourceName, 'Gold API');
    assert.equal(xauProv.timestamp, ts);
  });

  it('should not imply all rates share one update timestamp', () => {
    const ts1 = 1700000000000; // Fiat was updated earlier
    const ts2 = 1700001000000; // Crypto updated later
    const ts3 = 1700002000000; // Metals updated latest

    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts1) },
      { dataset: makeCryptoDataset(ts2) },
      { dataset: makeMetalsDataset(ts3) },
    ]);

    assert.ok(result.dataset);

    // Each rate's provenance timestamp reflects its actual source update time
    assert.equal(result.provenance.get('EUR')!.timestamp, ts1);
    assert.equal(result.provenance.get('BTC')!.timestamp, ts2);
    assert.equal(result.provenance.get('XAU')!.timestamp, ts3);

    // The composite dataset timestamp is the most recent
    assert.equal(result.dataset!.timestamp, ts3);

    // Verify that different rates have different timestamps (not one shared timestamp)
    assert.notEqual(
      result.provenance.get('EUR')!.timestamp,
      result.provenance.get('BTC')!.timestamp,
      'EUR and BTC should not share a timestamp'
    );
    assert.notEqual(
      result.provenance.get('BTC')!.timestamp,
      result.provenance.get('XAU')!.timestamp,
      'BTC and XAU should not share a timestamp'
    );
  });

  it('should report provenance for every rate in the composite', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
      { dataset: makeCryptoDataset(ts) },
      { dataset: makeMetalsDataset(ts) },
    ]);

    assert.ok(result.dataset);

    // Every rate in the composite should have a provenance entry
    for (const code of result.dataset!.rates.keys()) {
      assert.ok(
        result.provenance.has(code),
        `Rate '${code}' should have provenance metadata`
      );
      const prov = result.provenance.get(code)!;
      assert.ok(prov.sourceId, `Provenance for '${code}' should have sourceId`);
      assert.ok(prov.sourceName, `Provenance for '${code}' should have sourceName`);
      assert.ok(prov.timestamp > 0, `Provenance for '${code}' should have positive timestamp`);
    }
  });
});

describe('M2.0 — Source Failure Resilience', () => {
  it('should retain valid rates when one source fails (null dataset)', () => {
    const ts = Date.now();
    const fiat = makeFiatDataset(ts);

    // Simulate crypto provider failure: pass null
    // Metals provider succeeds
    const metals = makeMetalsDataset(ts);

    const result = mergeSourceDatasets([
      { dataset: fiat },
      { dataset: null as unknown as NormalizedRateDataset } as unknown as SourceDataset,
      { dataset: metals },
    ]);

    assert.ok(result.dataset, 'Composite should still succeed despite one null source');
    assert.ok(result.dataset!.rates.has('EUR'), 'Fiat rates should be present');
    assert.ok(result.dataset!.rates.has('XAU'), 'Metals rates should be present');
    assert.ok(!result.dataset!.rates.has('BTC'), 'Crypto rates should be absent (source failed)');
  });

  it('should retain valid rates when one source produces an empty dataset', () => {
    const ts = Date.now();
    const fiat = makeFiatDataset(ts);

    // Simulate crypto provider returning valid but empty dataset
    const emptyDataset: NormalizedRateDataset = {
      providerId: 'coingecko',
      providerName: 'CoinGecko Crypto',
      baseAsset: 'USD',
      timestamp: ts,
      rates: new Map<string, Big>(),
      isMock: false,
    };

    const result = mergeSourceDatasets([
      { dataset: fiat },
      { dataset: emptyDataset },
    ]);

    assert.ok(result.dataset, 'Composite should still succeed despite empty source');
    assert.ok(result.dataset!.rates.has('EUR'), 'Fiat rates should be present');
    assert.equal(result.contributingSources.length, 1, 'Only fiat source contributed');
    assert.ok(result.contributingSources.includes('frankfurter'));
  });

  it('should retain last-known-good from previous composite when merging with stale+fresh data', () => {
    const tsOld = 1700000000000;
    const tsNew = 1700001000000;

    // First assembly: all three sources available
    const first = mergeSourceDatasets([
      { dataset: makeFiatDataset(tsOld) },
      { dataset: makeCryptoDataset(tsOld) },
      { dataset: makeMetalsDataset(tsOld) },
    ]);
    assert.ok(first.dataset);
    assert.equal(first.dataset!.rates.size, 19);

    // Second assembly: crypto failed, fiat updated, metals retained from old dataset
    // Simulate by using old metals + new fiat, no crypto
    const second = mergeSourceDatasets([
      { dataset: makeFiatDataset(tsNew) },        // Fresh fiat
      { dataset: makeMetalsDataset(tsOld) },       // Retained old metals (last-known-good)
      // crypto omitted — source failure
    ]);

    assert.ok(second.dataset);
    assert.ok(second.dataset!.rates.has('EUR'), 'Fresh fiat should be present');
    assert.ok(second.dataset!.rates.has('XAU'), 'Stale metals should be retained');
    assert.ok(!second.dataset!.rates.has('BTC'), 'Crypto absent — source failed');

    // Verify fiat got the newer timestamp
    assert.equal(second.provenance.get('EUR')!.timestamp, tsNew);
    // Metals kept the old timestamp
    assert.equal(second.provenance.get('XAU')!.timestamp, tsOld);
  });
});

describe('M2.0 — Conflict Resolution (Overlapping Asset Codes)', () => {
  it('should prefer the newer timestamp when two sources provide the same asset', () => {
    const tsOld = 1700000000000;
    const tsNew = 1700001000000;

    // Both fiat and crypto provide USD (always). Also test overlapping EUR.
    const fiatOld = makeValidatedDataset({
      providerId: 'fiat-old',
      providerName: 'Fiat Old',
      timestamp: tsOld,
      rates: { USD: '1', EUR: '0.90' },
    });

    const fiatNew = makeValidatedDataset({
      providerId: 'fiat-new',
      providerName: 'Fiat New',
      timestamp: tsNew,
      rates: { USD: '1', EUR: '0.93' },
    });

    const result = mergeSourceDatasets([
      { dataset: fiatOld },
      { dataset: fiatNew },
    ]);

    assert.ok(result.dataset);
    // The newer EUR should win
    assert.ok(result.dataset!.rates.get('EUR')!.eq(new Big('0.93')), 'Newer EUR should win');
    assert.equal(result.provenance.get('EUR')!.sourceId, 'fiat-new');
    assert.equal(result.provenance.get('EUR')!.timestamp, tsNew);
  });

  it('should use priority to break ties when timestamps are equal', () => {
    const ts = Date.now();

    const sourceA = makeValidatedDataset({
      providerId: 'source-a',
      providerName: 'Source A',
      timestamp: ts,
      rates: { USD: '1', EUR: '0.90' },
    });

    const sourceB = makeValidatedDataset({
      providerId: 'source-b',
      providerName: 'Source B',
      timestamp: ts,
      rates: { USD: '1', EUR: '0.93' },
    });

    const result = mergeSourceDatasets([
      { dataset: sourceA, priority: 1 },
      { dataset: sourceB, priority: 10 },
    ]);

    assert.ok(result.dataset);
    // Source B has higher priority, should win
    assert.ok(result.dataset!.rates.get('EUR')!.eq(new Big('0.93')));
    assert.equal(result.provenance.get('EUR')!.sourceId, 'source-b');
  });

  it('should use last-writer-wins when timestamps and priorities are equal', () => {
    const ts = Date.now();

    const sourceA = makeValidatedDataset({
      providerId: 'source-a',
      providerName: 'Source A',
      timestamp: ts,
      rates: { USD: '1', EUR: '0.90' },
    });

    const sourceB = makeValidatedDataset({
      providerId: 'source-b',
      providerName: 'Source B',
      timestamp: ts,
      rates: { USD: '1', EUR: '0.93' },
    });

    // Same timestamp, same default priority — last in array wins
    const result = mergeSourceDatasets([
      { dataset: sourceA },
      { dataset: sourceB },
    ]);

    assert.ok(result.dataset);
    assert.ok(result.dataset!.rates.get('EUR')!.eq(new Big('0.93')), 'Last writer should win');
    assert.equal(result.provenance.get('EUR')!.sourceId, 'source-b');
  });
});

describe('M2.0 — Invalid Data and Edge Cases', () => {
  it('should return null dataset when no sources are provided', () => {
    const result = mergeSourceDatasets([]);
    assert.equal(result.dataset, null);
    assert.equal(result.provenance.size, 0);
    assert.equal(result.contributingSources.length, 0);
  });

  it('should return null dataset when all sources are null', () => {
    const result = mergeSourceDatasets([
      { dataset: null as unknown as NormalizedRateDataset } as unknown as SourceDataset,
      { dataset: null as unknown as NormalizedRateDataset } as unknown as SourceDataset,
    ]);
    assert.equal(result.dataset, null);
  });

  it('should return null dataset when sources have no USD base', () => {
    // Manually construct a dataset without USD (bypassing normal validation for this test)
    const noUsdDataset: NormalizedRateDataset = {
      providerId: 'bad-source',
      providerName: 'Bad Source',
      baseAsset: 'USD',
      timestamp: Date.now(),
      rates: new Map([['EUR', new Big('0.92')]]),
      isMock: false,
    };

    const result = mergeSourceDatasets([{ dataset: noUsdDataset }]);
    assert.equal(result.dataset, null, 'Should fail without USD base rate');
    assert.ok(result.summary.includes('USD'), 'Summary should mention USD');
  });

  it('should correctly mark composite as mock when any contributing source is mock', () => {
    const ts = Date.now();
    const fiat = makeFiatDataset(ts); // isMock: false
    const mock = makeValidatedDataset({
      providerId: 'mock-crypto',
      providerName: 'Mock Crypto',
      timestamp: ts,
      isMock: true,
      rates: { USD: '1', BTC: '0.000015' },
    });

    const result = mergeSourceDatasets([
      { dataset: fiat },
      { dataset: mock },
    ]);

    assert.ok(result.dataset);
    assert.equal(result.dataset!.isMock, true, 'Composite should be marked mock if any source is mock');
  });

  it('should correctly mark composite as non-mock when all sources are non-mock', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
      { dataset: makeCryptoDataset(ts) },
    ]);

    assert.ok(result.dataset);
    assert.equal(result.dataset!.isMock, false, 'Composite should be non-mock when all sources are non-mock');
  });

  it('should generate a meaningful summary string', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
      { dataset: makeCryptoDataset(ts) },
    ]);

    assert.ok(result.summary.includes('Composite assembled'));
    assert.ok(result.summary.includes('2 source(s)'));
    assert.ok(result.summary.includes('frankfurter'));
    assert.ok(result.summary.includes('coingecko'));
  });

  it('should allow custom composite ID and name', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets(
      [{ dataset: makeFiatDataset(ts) }],
      'my-composite',
      'My Custom Composite'
    );

    assert.ok(result.dataset);
    assert.equal(result.dataset!.providerId, 'my-composite');
    assert.equal(result.dataset!.providerName, 'My Custom Composite');
  });
});

describe('M2.0 — Integration with RateEngine', () => {
  it('should accept a composite dataset via RateEngine.setDataset()', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
      { dataset: makeCryptoDataset(ts) },
      { dataset: makeMetalsDataset(ts) },
    ]);

    assert.ok(result.dataset);

    // Create a fresh engine and inject the composite dataset
    const engine = new RateEngine(new MockRateProvider());
    engine.setDataset(result.dataset!);

    // Verify rates are accessible through the engine
    assert.ok(engine.getRate('USD').eq(1));
    assert.ok(engine.getRate('EUR').eq(new Big('0.91')));
    assert.ok(engine.getRate('BTC').eq(new Big('0.000014')));
    assert.ok(engine.getRate('XAU').eq(new Big('0.000410')));
    assert.equal(engine.isAvailable(), true);
  });

  it('should preserve engine LKG behaviour when composite is set then cleared', () => {
    const ts = Date.now();
    const result = mergeSourceDatasets([
      { dataset: makeFiatDataset(ts) },
    ]);

    assert.ok(result.dataset);

    const engine = new RateEngine(new MockRateProvider());
    engine.setDataset(result.dataset!);

    // Verify composite is active
    assert.ok(engine.getRate('EUR').eq(new Big('0.91')));

    // Clear and verify the engine falls back gracefully
    engine.clear();
    assert.equal(engine.isAvailable(), false);
  });
});

describe('M2.0 — Backward Compatibility', () => {
  it('should keep mock provider as default — single provider path unchanged', () => {
    const engine = new RateEngine();
    assert.equal(engine.isMock(), true);
    assert.equal(engine.getActiveProviderId(), 'mock-local');
    assert.ok(engine.isAvailable());
    assert.ok(engine.getRate('USD').eq(1));
    assert.ok(engine.getRate('EUR').eq(new Big('0.92')));
    assert.ok(engine.getRate('BTC').eq(new Big('0.000015')));
    assert.ok(engine.getRate('XAU').eq(new Big('0.000416')));
  });

  it('should not alter validateRatePayload behaviour', () => {
    // Valid payload
    const valid = validateRatePayload({
      providerId: 'test',
      providerName: 'Test',
      timestamp: Date.now(),
      rates: { USD: '1', EUR: '0.92' },
    });
    assert.equal(valid.valid, true);
    assert.ok(valid.dataset);

    // Invalid: missing timestamp
    const noTs = validateRatePayload({
      providerId: 'test',
      providerName: 'Test',
      rates: { USD: '1' },
    });
    assert.equal(noTs.valid, false);

    // Invalid: negative rate
    const negRate = validateRatePayload({
      providerId: 'test',
      providerName: 'Test',
      timestamp: Date.now(),
      rates: { USD: '1', EUR: '-0.5' },
    });
    assert.equal(negRate.valid, true); // Payload is valid but EUR should be warned/skipped
    assert.ok(negRate.warnings.some((w) => w.includes('EUR')));

    // Invalid: null payload
    const nullPayload = validateRatePayload(null);
    assert.equal(nullPayload.valid, false);
  });
});
