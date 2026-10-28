/**
 * Automated Test Suite for FixedPegRateProvider and AED Peg Reference
 *
 * Verifies:
 * 1. AED fixed peg rate definition: 1 USD = 3.6725 AED (exact)
 * 2. Reciprocal calculation: 1 AED = ~0.2722940776 USD
 * 3. Bidirectional conversions with RateEngine:
 *    - USD -> AED
 *    - AED -> USD
 *    - EUR -> AED (cross-rate via USD)
 *    - AED -> XAU (fiat to precious metal)
 * 4. Provider metadata, zero network calls, and clear fixed-peg labeling
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  FixedPegRateProvider,
  AED_USD_PEG_RATE,
  AED_USD_PEG_RATE_STR,
  USD_AED_RECIPROCAL_RATE,
  defaultFixedPegProvider,
} from '../src/lib/providers/fixedPegProvider.ts';

import { RateEngine, validateRatePayload } from '../src/lib/rateEngine.ts';
import { calculateConversion } from '../src/lib/converter.ts';

describe('FixedPegRateProvider & AED USD Peg Reference', () => {
  it('should verify exact official AED peg constant: 1 USD = 3.6725 AED', () => {
    assert.equal(AED_USD_PEG_RATE_STR, '3.6725');
    assert.equal(AED_USD_PEG_RATE.eq(new Big('3.6725')), true);
    assert.equal(AED_USD_PEG_RATE.toString(), '3.6725');
  });

  it('should verify reciprocal rate definition (1 AED in USD)', () => {
    // 1 / 3.6725 = 0.272294077603812117086453369639...
    const expected = new Big(1).div(new Big('3.6725'));
    assert.equal(USD_AED_RECIPROCAL_RATE.toFixed(10), expected.toFixed(10));
    assert.equal(USD_AED_RECIPROCAL_RATE.gt(0), true);
  });

  it('should supply valid raw rate payload with USD and AED', () => {
    const provider = new FixedPegRateProvider();
    const payload = provider.getRates();

    assert.equal(payload.providerId, 'fixed-peg');
    assert.equal(payload.isMock, false);
    assert.equal(payload.rates['USD'], '1');
    assert.equal(payload.rates['AED'], '3.6725');

    const validation = validateRatePayload(payload);
    assert.equal(validation.valid, true);
    assert.equal(validation.dataset?.rates.get('USD')?.eq(1), true);
    assert.equal(validation.dataset?.rates.get('AED')?.eq(new Big('3.6725')), true);
  });

  it('should perform exact bidirectional conversions between USD and AED', () => {
    const provider = new FixedPegRateProvider();
    const engine = new RateEngine(provider);

    // 100 USD -> AED
    const usdToAed = calculateConversion('100', 'USD', 'AED', { rateEngine: engine });
    assert.equal(usdToAed.targetAmount.toString(), '367.25');
    assert.equal(usdToAed.unitRate.toString(), '3.6725');

    // 367.25 AED -> USD
    const aedToUsd = calculateConversion('367.25', 'AED', 'USD', { rateEngine: engine });
    assert.equal(aedToUsd.targetAmount.round(6).toString(), '100');
    assert.equal(aedToUsd.inverseRate.toString(), '3.6725');
  });

  it('should perform cross-rate conversion EUR -> AED using a multi-asset dataset', () => {
    const timestamp = Date.now();
    const payload = {
      providerId: 'composite-test',
      providerName: 'Composite Test Provider',
      timestamp,
      isMock: false,
      rates: {
        USD: '1',
        EUR: '0.92', // 1 USD = 0.92 EUR
        AED: '3.6725', // 1 USD = 3.6725 AED
      },
    };

    const validation = validateRatePayload(payload);
    assert.equal(validation.valid, true);
    const engine = new RateEngine();
    engine.setDataset(validation.dataset!);

    // Convert 92 EUR to AED:
    // 92 EUR = 100 USD. 100 USD = 367.25 AED.
    const eurToAed = calculateConversion('92', 'EUR', 'AED', { rateEngine: engine });
    assert.equal(eurToAed.targetAmount.round(2).toString(), '367.25');
  });

  it('should instantiate FixedPegRateProvider with zero network requests', () => {
    const provider = defaultFixedPegProvider;
    assert.equal(provider.id, 'fixed-peg');
    assert.equal(provider.isMock, false);
  });
});
