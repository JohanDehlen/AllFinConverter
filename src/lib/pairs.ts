/**
 * WorthPair Conversion Pair Model & Registry
 *
 * Authoritative module for conversion pair definitions, validation,
 * slug generation, and static route generation.
 *
 * Uses the canonical asset model (assets.ts) and rate engine (rateEngine.ts).
 */

import { getAsset, type Asset } from './assets.ts';
import { hasRate } from './rateEngine.ts';
import { formatPairSlug, parsePairSlug } from './seo.ts';

/**
 * Validated conversion pair representation.
 */
export interface ConversionPair {
  /** Canonical uppercase source asset code (e.g., 'USD', 'BTC', 'XAU') */
  readonly fromCode: string;
  /** Canonical uppercase target asset code (e.g., 'EUR', 'USD') */
  readonly toCode: string;
  /** Canonical URL slug (e.g., 'usd-to-eur', 'gold-to-usd') */
  readonly slug: string;
  /** Full source asset metadata */
  readonly fromAsset: Asset;
  /** Full target asset metadata */
  readonly toAsset: Asset;
  /** Natural pair headline (e.g., 'USD to EUR Converter', 'Gold to USD Converter') */
  readonly headline: string;
  /** Human-readable page title */
  readonly title: string;
  /** Descriptive SEO page description */
  readonly description: string;
}

/**
 * Returns a human-friendly display identifier for a pair headline.
 * Precious metals use their common name (e.g., 'Gold', 'Silver') for readability,
 * while fiat currencies and cryptocurrencies use their recognized ticker/code ('USD', 'BTC').
 */
export function getAssetDisplayName(asset: Asset): string {
  if (asset.category === 'metal') {
    return asset.name;
  }
  return asset.code;
}

/**
 * Formats a natural pair headline (e.g., 'USD to EUR Converter', 'Gold to USD Converter').
 */
export function formatPairHeadline(fromAsset: Asset, toAsset: Asset): string {
  const fromDisplay = getAssetDisplayName(fromAsset);
  const toDisplay = getAssetDisplayName(toAsset);
  return `${fromDisplay} to ${toDisplay} Converter`;
}

/**
 * Validates whether a pair of asset codes can form a valid conversion pair.
 *
 * Strict validation rules:
 * 1. Both input parameters must be non-empty strings.
 * 2. Both assets must exist in the authoritative asset model (assets.ts).
 * 3. Both assets must be enabled.
 * 4. Source and target must be distinct (rejects same-asset pairs like USD → USD).
 * 5. Both assets must have valid exchange rates available in the rate engine.
 *
 * Returns a fully populated ConversionPair object if valid, or null if invalid.
 */
export function validatePair(fromInput: string, toInput: string): ConversionPair | null {
  if (!fromInput || !toInput || typeof fromInput !== 'string' || typeof toInput !== 'string') {
    return null;
  }

  const fromAsset = getAsset(fromInput);
  const toAsset = getAsset(toInput);

  if (!fromAsset || !toAsset) return null;
  if (!fromAsset.enabled || !toAsset.enabled) return null;
  if (fromAsset.code === toAsset.code) return null;

  if (!hasRate(fromAsset.code) || !hasRate(toAsset.code)) return null;

  const slug = formatPairSlug(fromAsset.code, toAsset.code);
  const headline = formatPairHeadline(fromAsset, toAsset);
  const title = `${headline} | WorthPair`;
  const description = `Convert ${fromAsset.name} (${fromAsset.code}) to ${toAsset.name} (${toAsset.code}) with WorthPair's simple ${fromAsset.code} to ${toAsset.code} converter.`;

  return {
    fromCode: fromAsset.code,
    toCode: toAsset.code,
    slug,
    fromAsset,
    toAsset,
    headline,
    title,
    description,
  };
}

/**
 * Resolves a URL slug (e.g. 'usd-to-eur', 'gold-to-usd') into a validated ConversionPair.
 * Returns null if the slug is invalid or refers to unsupported assets.
 */
export function getPairFromSlug(slug: string): ConversionPair | null {
  if (!slug || typeof slug !== 'string') return null;
  const parsed = parsePairSlug(slug);
  if (!parsed) return null;

  return validatePair(parsed.from, parsed.to);
}

/**
 * Initial curated list of featured representative conversion pairs for static generation.
 * Limited to 16 representative pairs across Fiat, Crypto, and Metals (M1.6 scope).
 */
export const FEATURED_PAIR_DEFINITIONS: readonly [string, string][] = [
  // Fiat Pairs (8)
  ['USD', 'EUR'],
  ['EUR', 'USD'],
  ['USD', 'GBP'],
  ['GBP', 'USD'],
  ['USD', 'ZAR'],
  ['ZAR', 'USD'],
  ['USD', 'INR'],
  ['USD', 'AED'],

  // Crypto Pairs (4)
  ['BTC', 'USD'],
  ['USD', 'BTC'],
  ['ETH', 'USD'],
  ['USD', 'ETH'],

  // Precious Metals Pairs (4)
  ['XAU', 'USD'],
  ['USD', 'XAU'],
  ['XAG', 'USD'],
  ['USD', 'XAG'],
] as const;

/**
 * Returns all validated featured pairs for static page generation and sitemap.
 */
export function getFeaturedPairs(): readonly ConversionPair[] {
  const pairs: ConversionPair[] = [];

  for (const [from, to] of FEATURED_PAIR_DEFINITIONS) {
    const pair = validatePair(from, to);
    if (pair) {
      pairs.push(pair);
    } else {
      console.warn(`[WorthPair] Configured featured pair '${from}' -> '${to}' is invalid.`);
    }
  }

  return Object.freeze(pairs);
}

/**
 * Finds related conversion pairs from the featured registry for crawlable internal linking.
 * Prioritizes the direct inverse pair and pairs sharing source/target assets or category.
 */
export function getRelatedPairs(currentSlug: string, limit = 4): readonly ConversionPair[] {
  const allPairs = getFeaturedPairs();
  const current = allPairs.find((p) => p.slug === currentSlug);
  if (!current) return [];

  const candidates = allPairs.filter((p) => p.slug !== currentSlug);

  const scored = candidates
    .map((pair) => {
      let score = 0;
      // Direct inverse pair (e.g. EUR->USD for USD->EUR)
      if (pair.fromCode === current.toCode && pair.toCode === current.fromCode) {
        score += 10;
      }
      // Same source asset
      if (pair.fromCode === current.fromCode) {
        score += 5;
      }
      // Same target asset
      if (pair.toCode === current.toCode) {
        score += 4;
      }
      // Same source asset category
      if (pair.fromAsset.category === current.fromAsset.category) {
        score += 2;
      }
      return { pair, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.pair);

  return scored.slice(0, limit);
}
