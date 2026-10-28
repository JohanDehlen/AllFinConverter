/**
 * AllFinConverter Production Rate Orchestrator Factory
 *
 * Assembles the authoritative production rate provider pipeline:
 * 1. FrankfurterRateProvider — European Central Bank daily reference rates for canonical fiat currencies.
 * 2. FixedPegRateProvider — Official fixed peg reference rate for UAE Dirham (AED: 1 USD = 3.6725 AED).
 * 3. CoinMarketCapRateProvider — Real-time spot quotes for cryptocurrencies (BTC, ETH, SOL, XRP, DOGE).
 * 4. GoldApiRateProvider — Spot reference prices for precious metals (XAU, XAG, XPT, XPD).
 *
 * Invariants:
 * - Does NOT use CoinGecko in production.
 * - Requires all 19 canonical assets to be supplied across the registered sources.
 * - Per-asset provenance is strictly preserved.
 * - Does NOT perform network calls upon instantiation.
 */

import { RateOrchestrator } from './rateOrchestrator.ts';
import {
  FrankfurterRateProvider,
  type FrankfurterProviderOptions,
} from './providers/frankfurterProvider.ts';
import {
  FixedPegRateProvider,
  type FixedPegProviderOptions,
} from './providers/fixedPegProvider.ts';
import {
  CoinMarketCapRateProvider,
  type CoinMarketCapProviderOptions,
} from './providers/coinmarketcapProvider.ts';
import {
  GoldApiRateProvider,
  type GoldApiProviderOptions,
} from './providers/goldApiProvider.ts';
import type { RateEngine } from './rateEngine.ts';

/**
 * Options for configuring the production rate orchestrator.
 */
export interface ProductionOrchestratorOptions {
  /** Optional custom options for FrankfurterRateProvider */
  readonly frankfurterOptions?: FrankfurterProviderOptions;
  /** Optional custom options for FixedPegRateProvider */
  readonly fixedPegOptions?: FixedPegProviderOptions;
  /** Optional custom options for CoinMarketCapRateProvider */
  readonly coinMarketCapOptions?: CoinMarketCapProviderOptions;
  /** Optional custom options for GoldApiRateProvider */
  readonly goldApiOptions?: GoldApiProviderOptions;
  /** Global custom fetch implementation applied as default to network providers */
  readonly fetch?: typeof globalThis.fetch;
  /** Global request timeout in milliseconds applied as default */
  readonly timeoutMs?: number;
  /** Optional RateEngine to synchronize with composite results */
  readonly rateEngine?: RateEngine;
  /** Optional composite dataset ID. Defaults to 'allfin-production-composite'. */
  readonly compositeId?: string;
  /** Optional composite dataset display name. Defaults to 'AllFinConverter Production Rates'. */
  readonly compositeName?: string;
}

/**
 * Factory assembling Frankfurter, Fixed-Peg AED, CoinMarketCap, and Gold-API providers
 * into a configured RateOrchestrator for production snapshot generation.
 */
export function createProductionRateOrchestrator(
  options?: ProductionOrchestratorOptions
): RateOrchestrator {
  const globalFetch = options?.fetch;
  const globalTimeout = options?.timeoutMs;

  // 1. Build options for Frankfurter
  const frankfurterOpts: FrankfurterProviderOptions = {
    ...(globalFetch !== undefined ? { fetch: globalFetch } : {}),
    ...(globalTimeout !== undefined ? { timeoutMs: globalTimeout } : {}),
    ...options?.frankfurterOptions,
  };

  // 2. Build options for FixedPeg (AED)
  const fixedPegOpts: FixedPegProviderOptions = {
    ...options?.fixedPegOptions,
  };

  // 3. Build options for CoinMarketCap
  const cmcOpts: CoinMarketCapProviderOptions = {
    ...(globalFetch !== undefined ? { fetch: globalFetch } : {}),
    ...(globalTimeout !== undefined ? { timeoutMs: globalTimeout } : {}),
    ...options?.coinMarketCapOptions,
  };

  // 4. Build options for Gold-API
  const goldApiOpts: GoldApiProviderOptions = {
    ...(globalFetch !== undefined ? { fetch: globalFetch } : {}),
    ...(globalTimeout !== undefined ? { timeoutMs: globalTimeout } : {}),
    ...options?.goldApiOptions,
  };

  const frankfurter = new FrankfurterRateProvider(frankfurterOpts);
  const fixedPeg = new FixedPegRateProvider(fixedPegOpts);
  const coinMarketCap = new CoinMarketCapRateProvider(cmcOpts);
  const goldApi = new GoldApiRateProvider(goldApiOpts);

  const orchestrator = new RateOrchestrator({
    compositeId: options?.compositeId ?? 'allfin-production-composite',
    compositeName: options?.compositeName ?? 'AllFinConverter Production Rates',
    rateEngine: options?.rateEngine,
  });

  // Register providers (priority 10 default)
  orchestrator.registerProvider(frankfurter, { priority: 10 });
  orchestrator.registerProvider(fixedPeg, { priority: 10 });
  orchestrator.registerProvider(coinMarketCap, { priority: 10 });
  orchestrator.registerProvider(goldApi, { priority: 10 });

  return orchestrator;
}
