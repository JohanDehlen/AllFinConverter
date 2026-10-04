/**
 * Financial conversion calculation and formatting engine.
 * Uses Big.js exclusively for all arithmetic to avoid JavaScript floating-point inaccuracies.
 */

import Big from 'big.js';
import { getRate } from './rateEngine.ts';
import { isPreciousMetal, type MetalUnit } from './assets.ts';

export type { MetalUnit };

// Configure high precision for intermediate calculations
Big.DP = 30;

/**
 * Exact unit conversion constant: 1 troy ounce = 31.1034768 grams.
 */
export const GRAMS_PER_TROY_OUNCE = new Big('31.1034768');

/**
 * Converts a quantity from troy ounces to grams using Big.js.
 */
export function convertTroyOzToGrams(troyOz: Big | string): Big {
  const val = typeof troyOz === 'string' ? new Big(troyOz) : troyOz;
  return val.times(GRAMS_PER_TROY_OUNCE);
}

/**
 * Converts a quantity from grams to troy ounces using Big.js.
 */
export function convertGramsToTroyOz(grams: Big | string): Big {
  const val = typeof grams === 'string' ? new Big(grams) : grams;
  return val.div(GRAMS_PER_TROY_OUNCE);
}

export interface ConversionOptions {
  fromUnit?: MetalUnit | string;
  toUnit?: MetalUnit | string;
}

export interface ConversionResult {
  sourceAmount: Big;
  targetAmount: Big;
  unitRate: Big; // 1 fromAsset (in fromUnit) = X toAsset (in toUnit)
  inverseRate: Big; // 1 toAsset (in toUnit) = X fromAsset (in fromUnit)
  fromUnit: MetalUnit;
  toUnit: MetalUnit;
}

/**
 * Calculates cross-rate conversion between two assets using normalized USD rates
 * and optional precious metal unit selection ('troy-oz' | 'g').
 *
 * Mathematical derivation:
 * Base is USD.
 * 1 USD = fromUnitsPerUsd (source rate, in troy-oz for metals)
 * 1 USD = toUnitsPerUsd (target rate, in troy-oz for metals)
 *
 * If source is a metal in grams: sourceTroyOz = amount / 31.1034768
 * USD value = sourceTroyOz / fromUnitsPerUsd
 *
 * Target amount (in troy oz for metals) = USD value * toUnitsPerUsd
 * If target is a metal in grams: targetGrams = targetTroyOz * 31.1034768
 */
export function calculateConversion(
  amount: Big | string,
  fromAsset: string,
  toAsset: string,
  options?: ConversionOptions
): ConversionResult {
  const sourceBig = typeof amount === 'string' ? new Big(amount) : amount;

  if (sourceBig.lt(0)) {
    throw new Error('Financial conversion amount cannot be negative.');
  }

  const fromRate = getRate(fromAsset);
  const toRate = getRate(toAsset);

  const isFromMetal = isPreciousMetal(fromAsset);
  const isToMetal = isPreciousMetal(toAsset);

  const fromUnit: MetalUnit = isFromMetal && options?.fromUnit === 'g' ? 'g' : 'troy-oz';
  const toUnit: MetalUnit = isToMetal && options?.toUnit === 'g' ? 'g' : 'troy-oz';

  // 1. Normalize source amount to standard rate-engine units (troy oz for metals)
  let sourceNormalized = sourceBig;
  if (isFromMetal && fromUnit === 'g') {
    sourceNormalized = convertGramsToTroyOz(sourceBig);
  }

  // Same-asset conversion (e.g. XAU -> XAU or USD -> USD)
  if (fromAsset.toUpperCase() === toAsset.toUpperCase()) {
    let targetAmount = sourceNormalized;
    if (isToMetal && toUnit === 'g') {
      targetAmount = convertTroyOzToGrams(sourceNormalized);
    }

    let unitRate = new Big(1);
    if (isFromMetal && fromUnit === 'troy-oz' && toUnit === 'g') {
      unitRate = GRAMS_PER_TROY_OUNCE;
    } else if (isFromMetal && fromUnit === 'g' && toUnit === 'troy-oz') {
      unitRate = new Big(1).div(GRAMS_PER_TROY_OUNCE);
    }
    const inverseRate = new Big(1).div(unitRate);

    return {
      sourceAmount: sourceBig,
      targetAmount,
      unitRate,
      inverseRate,
      fromUnit,
      toUnit,
    };
  }

  // 2. Compute target amount in rate-engine standard units (troy oz for metals)
  const targetNormalized = sourceNormalized.times(toRate).div(fromRate);

  // 3. Convert target to requested unit if metal
  let targetAmount = targetNormalized;
  if (isToMetal && toUnit === 'g') {
    targetAmount = convertTroyOzToGrams(targetNormalized);
  }

  // 4. Compute unit rate (1 unit of fromAsset [in fromUnit] = X units of toAsset [in toUnit])
  let oneSourceNormalized = new Big(1);
  if (isFromMetal && fromUnit === 'g') {
    oneSourceNormalized = convertGramsToTroyOz(new Big(1));
  }
  const oneTargetNormalized = oneSourceNormalized.times(toRate).div(fromRate);
  let unitRate = oneTargetNormalized;
  if (isToMetal && toUnit === 'g') {
    unitRate = convertTroyOzToGrams(oneTargetNormalized);
  }

  // 5. Compute inverse rate (1 unit of toAsset [in toUnit] = X units of fromAsset [in fromUnit])
  let oneTargetFromUnit = new Big(1);
  if (isToMetal && toUnit === 'g') {
    oneTargetFromUnit = convertGramsToTroyOz(new Big(1));
  }
  const oneSourceInverseNormalized = oneTargetFromUnit.times(fromRate).div(toRate);
  let inverseRate = oneSourceInverseNormalized;
  if (isFromMetal && fromUnit === 'g') {
    inverseRate = convertTroyOzToGrams(oneSourceInverseNormalized);
  }

  return {
    sourceAmount: sourceBig,
    targetAmount,
    unitRate,
    inverseRate,
    fromUnit,
    toUnit,
  };
}

/**
 * Returns the unit exchange rate (1 unit of fromAsset = X units of toAsset)
 * with optional metal unit specifications.
 */
export function getUnitRate(
  fromAsset: string,
  toAsset: string,
  options?: ConversionOptions
): Big {
  return calculateConversion(new Big(1), fromAsset, toAsset, options).unitRate;
}

/**
 * Formats an asset amount with explicit metal unit labeling when applicable.
 */
export function formatQuantityWithUnit(
  amount: Big | string,
  assetCode: string,
  unit?: MetalUnit | string
): string {
  const formattedAmount = formatDisplayAmount(amount);
  if (isPreciousMetal(assetCode)) {
    const unitLabel = unit === 'g' ? 'g' : 'troy oz';
    return `${formattedAmount} ${unitLabel} ${assetCode}`;
  }
  return `${formattedAmount} ${assetCode}`;
}

/**
 * Formats a unit rate informational line with explicit metal unit labeling.
 * E.g., "1 USD = 0.0416 troy oz XAU" or "1 troy oz XAU = 2,403.85 USD" or "1 g XAU = 77.29 USD".
 */
export function formatUnitRateWithUnit(
  rate: Big,
  fromCode: string,
  toCode: string,
  fromUnit?: MetalUnit | string,
  toUnit?: MetalUnit | string
): string {
  const formattedRate = formatUnitRate(rate);
  const fromPart = isPreciousMetal(fromCode)
    ? `1 ${fromUnit === 'g' ? 'g' : 'troy oz'} ${fromCode}`
    : `1 ${fromCode}`;
  const toPart = isPreciousMetal(toCode)
    ? `${formattedRate} ${toUnit === 'g' ? 'g' : 'troy oz'} ${toCode}`
    : `${formattedRate} ${toCode}`;
  return `${fromPart} = ${toPart}`;
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
