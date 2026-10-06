/**
 * AllFinConverter SEO Architecture & Helpers
 *
 * Provides reusable metadata schemas, canonical URL resolution,
 * JSON-LD structured data generators, and future pair-page slug conventions.
 */

import { getAsset } from './assets.ts';

/**
 * Standard page metadata interface for BaseLayout.
 */
export interface PageMetadata {
  /** Page title (e.g. 'AllFinConverter — Currency, Crypto & Precious Metals Converter') */
  readonly title: string;
  /** Meta description for search engines */
  readonly description: string;
  /** Explicit canonical URL or computed from pathname + site */
  readonly canonicalUrl?: string;
  /** Open Graph card type (default: 'website') */
  readonly ogType?: 'website' | 'article';
  /** Optional social share image path or URL */
  readonly ogImage?: string;
  /** Robots meta directive (default: 'index, follow') */
  readonly robots?: string;
  /** Optional JSON-LD structured data object(s) */
  readonly structuredData?: Record<string, unknown> | readonly Record<string, unknown>[];
}

/**
 * Normalizes and resolves a canonical URL safely.
 *
 * Rules:
 * - Strips query parameters and hashes.
 * - If site is provided (configured Astro.site or SITE_URL env), produces a fully qualified URL.
 * - If site is not configured (e.g., local development before domain registration), returns clean pathname.
 */
export function resolveCanonicalUrl(pathname: string, site?: URL | string): string {
  const cleanPath = pathname.split('?')[0].split('#')[0] || '/';
  const normalizedPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;

  if (site) {
    try {
      return new URL(normalizedPath, site).href;
    } catch {
      return normalizedPath;
    }
  }

  return normalizedPath;
}

/**
 * Generates Schema.org WebSite structured data.
 */
export function getWebSiteStructuredData(siteUrl = 'https://allfinconverter.com'): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'AllFinConverter',
    alternateName: 'AllFinConverter Converter',
    url: siteUrl,
    description: 'Fast, high-precision currency, cryptocurrency, and precious metals converter.',
  };
}

/**
 * Generates Schema.org WebApplication structured data for the converter utility.
 */
export function getWebApplicationStructuredData(siteUrl = 'https://allfinconverter.com'): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'AllFinConverter Financial Converter',
    url: siteUrl,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'All',
    browserRequirements: 'Requires JavaScript. Requires HTML5.',
    description: 'Calculate cross-rates between fiat currencies, cryptocurrencies, and precious metals instantly.',
  };
}

/**
 * Generates Schema.org BreadcrumbList structured data.
 */
export function getBreadcrumbStructuredData(
  items: readonly { name: string; url: string }[]
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Human-friendly slug aliases for precious metals in future pair URLs.
 * Maps standard ISO 4217 commodity codes (XAU, XAG, XPT, XPD) to readable URL terms.
 */
export const ASSET_SLUG_MAP: Readonly<Record<string, string>> = {
  XAU: 'gold',
  XAG: 'silver',
  XPT: 'platinum',
  XPD: 'palladium',
};

/**
 * Reverse mapping from friendly slug term to canonical asset code.
 */
export const SLUG_TO_ASSET_MAP: Readonly<Record<string, string>> = {
  gold: 'XAU',
  silver: 'XAG',
  platinum: 'XPT',
  palladium: 'XPD',
};

/**
 * Formats a canonical asset code into its future URL slug segment.
 * E.g., 'USD' -> 'usd', 'BTC' -> 'btc', 'XAU' -> 'gold'.
 */
export function assetCodeToSlug(code: string): string {
  const upper = code.trim().toUpperCase();
  return ASSET_SLUG_MAP[upper] ?? upper.toLowerCase();
}

/**
 * Resolves a URL slug segment back to its canonical uppercase asset code.
 * E.g., 'usd' -> 'USD', 'gold' -> 'XAU', 'xau' -> 'XAU'.
 */
export function slugToAssetCode(slug: string): string | undefined {
  const lower = slug.trim().toLowerCase();
  const mapped = SLUG_TO_ASSET_MAP[lower];
  if (mapped) return mapped;

  const candidate = lower.toUpperCase();
  const asset = getAsset(candidate);
  return asset ? asset.code : undefined;
}

/**
 * Formats a conversion pair into the standard URL convention: `/{from}-to-{to}`.
 * E.g., ('USD', 'EUR') -> 'usd-to-eur', ('XAU', 'USD') -> 'gold-to-usd'.
 */
export function formatPairSlug(fromCode: string, toCode: string): string {
  const fromSlug = assetCodeToSlug(fromCode);
  const toSlug = assetCodeToSlug(toCode);
  return `${fromSlug}-to-${toSlug}`;
}

/**
 * Parses and validates a future pair URL slug into canonical asset codes.
 * Returns null if the slug format is invalid or references unsupported assets.
 * E.g., 'usd-to-eur' -> { from: 'USD', to: 'EUR' }, 'gold-to-zar' -> { from: 'XAU', to: 'ZAR' }.
 */
export function parsePairSlug(pairSlug: string): { from: string; to: string } | null {
  const parts = pairSlug.trim().toLowerCase().split('-to-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const fromCode = slugToAssetCode(parts[0]);
  const toCode = slugToAssetCode(parts[1]);

  if (!fromCode || !toCode || fromCode === toCode) {
    return null;
  }

  return { from: fromCode, to: toCode };
}

/**
 * Metadata definition for future dedicated pair pages.
 */
export interface PairPageDefinition {
  readonly fromCode: string;
  readonly toCode: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}
