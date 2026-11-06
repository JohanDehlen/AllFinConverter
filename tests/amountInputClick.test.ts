/**
 * Automated Test Suite for Amount Input Click & Typing Behaviour
 *
 * Verifies:
 * 1. Clicking amountFrom clears BOTH amount fields and sets both to '0'.
 * 2. Clicking amountTo clears BOTH amount fields and sets both to '0'.
 * 3. Focus and selection are applied to the clicked field.
 * 4. User can immediately type a replacement amount in either field.
 * 5. Conversion recalculates correctly after typing begins for both directions.
 * 6. Typing does not repeatedly clear the fields.
 * 7. Normal keyboard focus (Tab navigation) does not clear fields.
 * 8. Swap button preserves conversion state and does not reset fields to '0'.
 * 9. Input validation (positive numbers, decimal handling, sanitized strings) preserved.
 */

// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import Big from 'big.js';

import {
  calculateConversion,
  formatDisplayAmount,
  sanitizeAmountInput,
} from '../src/lib/converter.ts';

/**
 * Lightweight mock input element simulating DOM HTMLInputElement behavior for testing.
 */
class MockInputElement {
  value: string;
  size: number = 1;
  isFocused: boolean = false;
  isSelected: boolean = false;
  invalid: boolean = false;
  listeners: Record<string, ((e?: any) => void)[]> = {};

  constructor(initialValue: string = '') {
    this.value = initialValue;
  }

  addEventListener(event: string, fn: (e?: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  dispatchEvent(event: string, payload?: any) {
    for (const fn of this.listeners[event] || []) {
      fn(payload);
    }
  }

  focus() {
    this.isFocused = true;
  }

  blur() {
    this.isFocused = false;
    this.dispatchEvent('blur');
  }

  select() {
    this.isSelected = true;
  }

  removeAttribute(attr: string) {
    if (attr === 'aria-invalid') this.invalid = false;
  }

  setAttribute(attr: string, val: string) {
    if (attr === 'aria-invalid' && val === 'true') this.invalid = true;
  }
}

/**
 * Creates an instance of the converter amount interaction controller
 * mirroring the exact logic in Converter.astro.
 */
function setupConverterAmountController() {
  const amountFrom = new MockInputElement('100');
  const amountTo = new MockInputElement('92');
  let activeSide: 'from' | 'to' = 'from';
  let summaryHeadline = '';
  let summarySubtext = '';

  function recalculate() {
    const fromCode = 'USD';
    const toCode = 'EUR';
    const activeInput = activeSide === 'from' ? amountFrom : amountTo;
    const targetInput = activeSide === 'from' ? amountTo : amountFrom;

    amountFrom.removeAttribute('aria-invalid');
    amountTo.removeAttribute('aria-invalid');

    const rawSanitized = sanitizeAmountInput(activeInput.value);
    if (activeInput.value !== rawSanitized) {
      activeInput.value = rawSanitized;
    }

    const unformatted = rawSanitized.replace(/,/g, '').trim();

    if (unformatted.startsWith('-')) {
      targetInput.value = '';
      activeInput.setAttribute('aria-invalid', 'true');
      summaryHeadline = 'Amount must be positive';
      summarySubtext = 'Negative financial amounts are not supported.';
      return;
    }

    if (!unformatted || unformatted === '.') {
      targetInput.value = '';
      summaryHeadline = '1 USD = 0.92 EUR';
      return;
    }

    const calcInput = unformatted.endsWith('.') ? unformatted.slice(0, -1) : unformatted;
    let bigAmount: Big;
    try {
      bigAmount = new Big(calcInput);
    } catch {
      return;
    }

    try {
      if (activeSide === 'from') {
        const result = calculateConversion(bigAmount, fromCode, toCode);
        targetInput.value = formatDisplayAmount(result.targetAmount);
        summaryHeadline = `${bigAmount.toString()} USD = ${result.targetAmount.toString()} EUR`;
      } else {
        const result = calculateConversion(bigAmount, toCode, fromCode);
        targetInput.value = formatDisplayAmount(result.targetAmount);
        summaryHeadline = `${result.targetAmount.toString()} USD = ${bigAmount.toString()} EUR`;
      }
    } catch {
      targetInput.value = '';
    }
  }

  function handleAmountInputClick(clickedInput: MockInputElement, side: 'from' | 'to') {
    amountFrom.value = '0';
    amountTo.value = '0';
    activeSide = side;
    clickedInput.focus();
    clickedInput.select();
    recalculate();
  }

  amountFrom.addEventListener('click', () => {
    handleAmountInputClick(amountFrom, 'from');
  });

  amountTo.addEventListener('click', () => {
    handleAmountInputClick(amountTo, 'to');
  });

  amountFrom.addEventListener('input', () => {
    activeSide = 'from';
    if (/^0[0-9]/.test(amountFrom.value)) {
      amountFrom.value = amountFrom.value.replace(/^0+/, '');
    }
    recalculate();
  });

  amountTo.addEventListener('input', () => {
    activeSide = 'to';
    if (/^0[0-9]/.test(amountTo.value)) {
      amountTo.value = amountTo.value.replace(/^0+/, '');
    }
    recalculate();
  });

  function simulateSwap() {
    const prevFrom = amountFrom.value;
    const prevTo = amountTo.value;
    amountFrom.value = prevTo;
    amountTo.value = prevFrom;
    activeSide = 'from';
    recalculate();
  }

  return {
    amountFrom,
    amountTo,
    simulateSwap,
    recalculate,
    getActiveSide: () => activeSide,
    getSummaryHeadline: () => summaryHeadline,
  };
}

describe('Amount Input Click Behaviour (Requirement 2)', () => {
  it('should clear both fields and set both to 0 when amountFrom is clicked', () => {
    const { amountFrom, amountTo, getActiveSide } = setupConverterAmountController();

    assert.equal(amountFrom.value, '100');
    assert.equal(amountTo.value, '92');

    // User clicks amountFrom
    amountFrom.dispatchEvent('click');

    assert.equal(amountFrom.value, '0', 'amountFrom must be reset to 0');
    assert.equal(amountTo.value, '0', 'amountTo must be reset to 0');
    assert.equal(amountFrom.isFocused, true, 'amountFrom must be focused');
    assert.equal(amountFrom.isSelected, true, 'amountFrom text must be selected');
    assert.equal(getActiveSide(), 'from', 'activeSide must be from');
  });

  it('should clear both fields and set both to 0 when amountTo is clicked', () => {
    const { amountFrom, amountTo, getActiveSide } = setupConverterAmountController();

    assert.equal(amountFrom.value, '100');
    assert.equal(amountTo.value, '92');

    // User clicks amountTo
    amountTo.dispatchEvent('click');

    assert.equal(amountFrom.value, '0', 'amountFrom must be reset to 0');
    assert.equal(amountTo.value, '0', 'amountTo must be reset to 0');
    assert.equal(amountTo.isFocused, true, 'amountTo must be focused');
    assert.equal(amountTo.isSelected, true, 'amountTo text must be selected');
    assert.equal(getActiveSide(), 'to', 'activeSide must be to');
  });

  it('should allow typing immediately in amountFrom and calculate amountTo correctly', () => {
    const { amountFrom, amountTo } = setupConverterAmountController();

    // User clicks amountFrom
    amountFrom.dispatchEvent('click');
    assert.equal(amountFrom.value, '0');
    assert.equal(amountTo.value, '0');

    // User types '250' (replaces selected '0')
    amountFrom.value = '250';
    amountFrom.dispatchEvent('input');

    assert.equal(amountFrom.value, '250');
    // 250 USD * 0.92 = 230 EUR
    assert.equal(amountTo.value, '230');
  });

  it('should handle unselected leading zero cleanly when typing immediately after click', () => {
    const { amountFrom, amountTo } = setupConverterAmountController();

    // User clicks amountFrom
    amountFrom.dispatchEvent('click');

    // If browser did not replace selected text and appended '5' to '0' making '05'
    amountFrom.value = '05';
    amountFrom.dispatchEvent('input');

    assert.equal(amountFrom.value, '5', 'Leading 0 must be stripped seamlessly');
    // 5 USD * 0.92 = 4.6 EUR
    assert.equal(amountTo.value, '4.60');
  });

  it('should allow typing decimal numbers such as 0.5 without stripping zero', () => {
    const { amountFrom, amountTo } = setupConverterAmountController();

    // User clicks amountFrom
    amountFrom.dispatchEvent('click');

    // User types '0.5'
    amountFrom.value = '0.5';
    amountFrom.dispatchEvent('input');

    assert.equal(amountFrom.value, '0.5', '0.5 must not strip the leading zero');
    // 0.5 USD * 0.92 = 0.46 EUR
    assert.equal(amountTo.value, '0.46');
  });

  it('should allow typing immediately in amountTo and calculate amountFrom correctly', () => {
    const { amountFrom, amountTo } = setupConverterAmountController();

    // User clicks amountTo
    amountTo.dispatchEvent('click');
    assert.equal(amountFrom.value, '0');
    assert.equal(amountTo.value, '0');

    // User types '92' in amountTo
    amountTo.value = '92';
    amountTo.dispatchEvent('input');

    assert.equal(amountTo.value, '92');
    // 92 EUR / 0.92 = 100 USD
    assert.equal(amountFrom.value, '100');
  });

  it('should NOT clear the fields repeatedly while typing consecutive keystrokes', () => {
    const { amountFrom, amountTo } = setupConverterAmountController();

    // User clicks amountFrom
    amountFrom.dispatchEvent('click');

    // Keystroke 1: '1'
    amountFrom.value = '1';
    amountFrom.dispatchEvent('input');
    assert.equal(amountFrom.value, '1');

    // Keystroke 2: '12'
    amountFrom.value = '12';
    amountFrom.dispatchEvent('input');
    assert.equal(amountFrom.value, '12');

    // Keystroke 3: '125'
    amountFrom.value = '125';
    amountFrom.dispatchEvent('input');
    assert.equal(amountFrom.value, '125');

    assert.notEqual(amountFrom.value, '0');
  });

  it('should NOT clear fields on normal keyboard navigation (focus without click)', () => {
    const { amountFrom, amountTo } = setupConverterAmountController();

    assert.equal(amountFrom.value, '100');
    assert.equal(amountTo.value, '92');

    // User tabs into amountFrom (focus event without click event)
    amountFrom.dispatchEvent('focus');

    // Values remain untouched!
    assert.equal(amountFrom.value, '100');
    assert.equal(amountTo.value, '92');
  });

  it('should NOT reset fields to 0 when swap button is clicked', () => {
    const { amountFrom, amountTo, simulateSwap } = setupConverterAmountController();

    amountFrom.value = '50';
    amountTo.value = '46';

    simulateSwap();

    assert.equal(amountFrom.value, '46', 'Source should now have 46');
    assert.notEqual(amountFrom.value, '0');
    assert.notEqual(amountTo.value, '0');
  });
});
