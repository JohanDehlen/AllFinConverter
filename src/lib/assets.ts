/**
 * WorthPair Asset Metadata Model
 *
 * Dedicated module for canonical asset definitions across all supported asset classes:
 * - Fiat Currencies
 * - Cryptocurrencies
 * - Precious Metals
 *
 * This module contains STATIC METADATA only.
 * Exchange rates and market prices are strictly decoupled and stored separately.
 */

export type AssetCategory = 'fiat' | 'crypto' | 'metal';

export type MetalUnit = 'troy-oz' | 'g';

/** Exact conversion constant: 1 troy ounce = 31.1034768 grams */
export const GRAMS_PER_TROY_OUNCE_STR = '31.1034768';

export const PRECIOUS_METAL_CODES: ReadonlySet<string> = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

export interface Asset {
  /** Canonical uppercase code (e.g., 'USD', 'BTC', 'XAU') */
  readonly code: string;
  /** Full English display name */
  readonly name: string;
  /** Primary asset category */
  readonly category: AssetCategory;
  /** Optional standard display symbol */
  readonly symbol?: string;
  /** Default reference unit for the asset (e.g., 'troy-ounce' for precious metals) */
  readonly defaultUnit?: string;
  /** Unit alias for backward compatibility */
  readonly unit?: string;
  /** Whether the asset is currently active in the interface */
  readonly enabled: boolean;
}

export const ASSET_CATEGORIES: readonly { id: AssetCategory; label: string; pill: string }[] = [
  { id: 'fiat', label: 'Currencies', pill: 'FIAT' },
  { id: 'crypto', label: 'Cryptocurrencies', pill: 'CRYPTO' },
  { id: 'metal', label: 'Precious Metals', pill: 'METAL' },
] as const;

export const ASSETS: readonly Asset[] = [
  // Fiat Currencies
  { code: 'USD', name: 'US Dollar', category: 'fiat', symbol: '$', enabled: true },
  { code: 'EUR', name: 'Euro', category: 'fiat', symbol: '€', enabled: true },
  { code: 'GBP', name: 'British Pound', category: 'fiat', symbol: '£', enabled: true },
  { code: 'JPY', name: 'Japanese Yen', category: 'fiat', symbol: '¥', enabled: true },
  { code: 'CHF', name: 'Swiss Franc', category: 'fiat', symbol: 'CHF', enabled: true },
  { code: 'CAD', name: 'Canadian Dollar', category: 'fiat', symbol: 'C$', enabled: true },
  { code: 'AUD', name: 'Australian Dollar', category: 'fiat', symbol: 'A$', enabled: true },
  { code: 'ZAR', name: 'South African Rand', category: 'fiat', symbol: 'R', enabled: true },
  { code: 'INR', name: 'Indian Rupee', category: 'fiat', symbol: '₹', enabled: true },
  { code: 'AED', name: 'UAE Dirham', category: 'fiat', symbol: 'د.إ', enabled: true },

  // Cryptocurrencies
  { code: 'BTC', name: 'Bitcoin', category: 'crypto', symbol: '₿', enabled: true },
  { code: 'ETH', name: 'Ethereum', category: 'crypto', symbol: 'Ξ', enabled: true },
  { code: 'SOL', name: 'Solana', category: 'crypto', symbol: 'SOL', enabled: true },
  { code: 'XRP', name: 'XRP', category: 'crypto', symbol: 'XRP', enabled: true },
  { code: 'DOGE', name: 'Dogecoin', category: 'crypto', symbol: 'DOGE', enabled: true },

  // Precious Metals (Reference/spot-style assets, default unit: troy-ounce; gram support is a future capability)
  { code: 'XAU', name: 'Gold', category: 'metal', symbol: 'Au', defaultUnit: 'troy-ounce', unit: 'troy-ounce', enabled: true },
  { code: 'XAG', name: 'Silver', category: 'metal', symbol: 'Ag', defaultUnit: 'troy-ounce', unit: 'troy-ounce', enabled: true },
  { code: 'XPT', name: 'Platinum', category: 'metal', symbol: 'Pt', defaultUnit: 'troy-ounce', unit: 'troy-ounce', enabled: true },
  { code: 'XPD', name: 'Palladium', category: 'metal', symbol: 'Pd', defaultUnit: 'troy-ounce', unit: 'troy-ounce', enabled: true },
] as const;

// Fast lookup map indexed by canonical uppercase asset code
const ASSET_MAP = new Map<string, Asset>(
  ASSETS.map((asset) => [asset.code, asset])
);

/**
 * Retrieves asset metadata by asset code.
 * Input is normalized (trimmed and converted to uppercase).
 * Returns undefined safely for unrecognized asset codes without throwing.
 */
export function getAsset(code: string | undefined | null): Asset | undefined {
  if (!code) return undefined;
  return ASSET_MAP.get(code.trim().toUpperCase());
}

/**
 * Returns all currently enabled assets.
 */
export function getSupportedAssets(): readonly Asset[] {
  return ASSETS.filter((a) => a.enabled);
}

/**
 * Returns all enabled assets within a specific category.
 */
export function getAssetsByCategory(category: AssetCategory): readonly Asset[] {
  return ASSETS.filter((a) => a.enabled && a.category === category);
}

/**
 * Returns user-facing category label (e.g. 'Currencies', 'Cryptocurrencies', 'Precious Metals').
 */
export function getCategoryLabel(category: AssetCategory): string {
  const cat = ASSET_CATEGORIES.find((c) => c.id === category);
  return cat ? cat.label : category;
}

/**
 * Returns short pill text for the category badge (e.g. 'FIAT', 'CRYPTO', 'METAL').
 */
export function getCategoryPill(category: AssetCategory): string {
  const cat = ASSET_CATEGORIES.find((c) => c.id === category);
  return cat ? cat.pill : category.toUpperCase();
}

/**
 * Checks whether an asset code represents a precious metal.
 */
export function isPreciousMetal(code: string | undefined | null): boolean {
  if (!code) return false;
  const upper = code.trim().toUpperCase();
  return PRECIOUS_METAL_CODES.has(upper);
}

/**
 * Returns the human-readable label for a metal unit ('troy oz' or 'g').
 */
export function getMetalUnitLabel(unit: MetalUnit | string | undefined | null): string {
  return unit === 'g' ? 'g' : 'troy oz';
}

/**
 * Returns the visual amount prefix for an asset (e.g. '$', '€', '£', '₿').
 * Returns empty string for precious metals (which use suffixes instead).
 */
export function getAssetAmountPrefix(assetCode: string | undefined | null): string {
  const asset = getAsset(assetCode);
  if (!asset || asset.category === 'metal') {
    return '';
  }
  return asset.symbol || asset.code;
}

/**
 * Returns the visual amount suffix for an asset and unit (e.g. 'troy oz', 'g').
 * Returns empty string for non-metal assets (which use prefixes instead).
 */
export function getAssetAmountSuffix(
  assetCode: string | undefined | null,
  unit?: MetalUnit | string | null
): string {
  if (!isPreciousMetal(assetCode)) {
    return '';
  }
  return getMetalUnitLabel(unit);
}

