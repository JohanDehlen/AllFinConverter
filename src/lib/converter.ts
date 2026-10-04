/**
 * Financial conversion calculation and formatting engine.
 * Uses Big.js exclusively for all arithmetic to avoid JavaScript floating-point inaccuracies.
 */

import Big from 'big.js';
import { getRate } from './rateEngine';

// Configure high precision for intermediate calculations
Big.DP = 30;

export interface ConversionResult {
  sourceAmount: Big;
  targetAmount: Big;
  unitRate: Big; // 1 fromAsset = X toAsset
  inverseRate: Big; // 1 toAsset = X fromAsset
}

/**
 * Calculates cross-rate conversion between two assets using normalized USD rates.
 *
 * Mathematical derivation:
 * Base is USD.
 * 1 USD = fromUnitsPerUsd (source rate)
 * 1 USD = toUnitsPerUsd (target rate)
 *
 * Value of 1 unit of fromAsset in USD = 1 / fromUnitsPerUsd
 * Amount in USD = sourceAmount / fromUnitsPerUsd
 *
 * Target amount in toAsset = (sourceAmount / fromUnitsPerUsd) * toUnitsPerUsd
 *                          = sourceAmount * toUnitsPerUsd / fromUnitsPerUsd
 */
export function calculateConversion(
  amount: Big | string,
  fromAsset: string,
  toAsset: string
): ConversionResult {
  const sourceBig = typeof amount === 'string' ? new Big(amount) : amount;

  if (sourceBig.lt(0)) {
    throw new Error('Financial conversion amount cannot be negative.');
  }

  const fromRate = getRate(fromAsset);
  const toRate = getRate(toAsset);

  if (fromAsset.toUpperCase() === toAsset.toUpperCase()) {
    return {
      sourceAmount: sourceBig,
      targetAmount: sourceBig,
      unitRate: new Big(1),
      inverseRate: new Big(1),
    };
  }

  // Multiply first to maintain maximum precision before division
  const targetAmount = sourceBig.times(toRate).div(fromRate);
  const unitRate = toRate.div(fromRate);
  const inverseRate = fromRate.div(toRate);

  return {
    sourceAmount: sourceBig,
    targetAmount,
    unitRate,
    inverseRate,
  };
}

/**
 * Returns the unit exchange rate (1 unit of fromAsset = X units of toAsset).
 */
export function getUnitRate(fromAsset: string, toAsset: string): Big {
  const fromRate = getRate(fromAsset);
  const toRate = getRate(toAsset);
  return toRate.div(fromRate);
}

/**
 * Sanitizes raw user text input:
 * - Retains leading minus sign so negative numbers can be identified and rejected by the validator
 * - Normalizes commas to decimal dots if standard decimal input
 * - Discards secondary decimal points and non-numeric characters
 */
export function sanitizeAmountInput(input: string): string {
  const trimmed = input.trim();
  const isNegative = trimmed.startsWith('-');
  let cleaned = trimmed.replace(/[^\d.,]/g, '');

  // Normalize commas to dots if comma is used as decimal separator
  // If input contains both comma and dot (e.g. 1,000.50), strip commas
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    // Single comma treated as thousands or decimal separator
    // If followed by exactly 3 digits at the end and longer than 4 chars, treat as grouping comma
    const commaParts = cleaned.split(',');
    if (commaParts.length === 2 && commaParts[1].length !== 3) {
      cleaned = cleaned.replace(',', '.');
    } else if (commaParts.length > 2) {
      cleaned = cleaned.replace(/,/g, '');
    }
  }

  // Handle multiple decimal points (keep only the first)
  const parts = cleaned.split('.');
  if (parts.length > 2) {
    cleaned = parts[0] + '.' + parts.slice(1).join('');
  }

  return isNegative ? '-' + cleaned : cleaned;
}

/**
 * Formats a Big.js or string numeric value for clean financial display:
 * - Groups integer part with commas (e.g. 1000 -> 1,000)
 * - Retains sensible 2 decimal places for standard amounts (e.g. 1234.5 -> 1,234.50)
 * - Preserves meaningful digits for very small decimals (e.g. 0.000123) without rounding to 0
 * - Avoids scientific notation on large and small numbers
 * - Trims excessive trailing zeros where appropriate
 */
export function formatDisplayAmount(val: Big | string): string {
  const bigVal = typeof val === 'string' ? new Big(val) : val;

  if (bigVal.eq(0)) {
    return '0';
  }

  const str = bigVal.toFixed();
  const [intPart, decPart] = str.split('.');
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Exact integer with no decimal places
  if (!decPart) {
    return formattedInt;
  }

  // Values >= 100: Standard 2 decimal places with comma grouping
  if (bigVal.gte(100)) {
    const fixed = bigVal.toFixed(2);
    const [fInt, fDec] = fixed.split('.');
    return fInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fDec ? '.' + fDec : '');
  }

  // Values between 1 and 100: 2 to 4 decimal places, trimming trailing zeros past 2 decimals
  if (bigVal.gte(1)) {
    const fixed = bigVal.toFixed(4);
    let trimmed = fixed.replace(/0+$/, '');
    const [fInt, fDec] = trimmed.split('.');
    let dec = fDec || '';
    if (dec.length < 2) dec = dec.padEnd(2, '0');
    return fInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
  }

  // Values between 0 and 1: Preserve significant digits (never show 0 for small fractions)
  const match = decPart.match(/^(0*)([1-9]\d*)/);
  if (!match) return '0';
  const leadingZeros = match[1].length;
  const targetDp = Math.min(leadingZeros + 6, 12);
  const fixed = bigVal.toFixed(targetDp);
  const trimmed = fixed.replace(/0+$/, '');
  return trimmed;
}

/**
 * Formats a unit rate specifically for the informational rate line (e.g. "1 USD = 0.92 EUR").
 */
export function formatUnitRate(rate: Big): string {
  if (rate.gte(100)) {
    const fixed = rate.toFixed(2);
    const [fInt, fDec] = fixed.split('.');
    return fInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fDec ? '.' + fDec : '');
  }

  if (rate.gte(1)) {
    const fixed = rate.toFixed(4);
    let trimmed = fixed.replace(/0+$/, '');
    const [fInt, fDec] = trimmed.split('.');
    let dec = fDec || '';
    if (dec.length < 2) dec = dec.padEnd(2, '0');
    return fInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
  }

  return formatDisplayAmount(rate);
}
