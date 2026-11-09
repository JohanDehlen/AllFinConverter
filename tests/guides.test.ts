// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const guidePages = [
  {
    file: 'currency-exchange-rates.astro',
    title: 'Currency Exchange Rates Explained: Reference Rates vs Bank Rates',
    requiredContent: [
      'What an exchange rate represents',
      'reference rate',
      'European Central Bank',
      'may include a spread',
      'Fees may be separate',
      'Hypothetical example—not a current market rate or an offer',
      'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
      'href="/usd-to-eur"',
      'href="/how-it-works"',
    ],
  },
  {
    file: 'bitcoin-prices-across-exchanges.astro',
    title: 'Why Bitcoin Prices Differ Between Exchanges',
    requiredContent: [
      'Independent markets, independent quotes',
      'liquidity',
      'volume-weighted average',
      'https://support.coinmarketcap.com/hc/en-us/articles/360015968632-How-are-prices-calculated-on-CoinMarketCap',
      'every six hours',
      '24-hour age limit',
      'href="/btc-to-usd"',
      'href="/how-it-works"',
    ],
  },
  {
    file: 'troy-ounce-vs-gram.astro',
    title: 'Troy Ounce vs Gram: How Gold and Silver Prices Are Measured',
    requiredContent: [
      'ordinary avoirdupois ounce',
      '31.1034768 grams',
      'divide the per-ounce price by 31.1034768',
      'Hypothetical worked example—not a current gold or silver price',
      'fabrication',
      'spreads',
      'taxes',
      'https://www.lbma.org.uk/wonders-of-gold/items/the-troy-ounce',
      'href="/gold-to-usd"',
      'href="/silver-to-usd"',
      'href="/how-it-works"',
    ],
  },
] as const;

describe('Educational guides', () => {
  it('creates the guides index and all three article route files', () => {
    for (const file of [
      'index.astro',
      ...guidePages.map(({ file }) => file),
    ]) {
      assert.ok(
        existsSync(new URL(`../src/pages/guides/${file}`, import.meta.url)),
        `Expected guide route source: ${file}`
      );
    }
  });

  it('links from the guides index to each article with a useful description', () => {
    const index = readFileSync(new URL('../src/pages/guides/index.astro', import.meta.url), 'utf8');

    assert.match(index, /<h1 class="info-title">Guides<\/h1>/);
    for (const { file, title } of guidePages) {
      const slug = file.replace(/\.astro$/, '');
      assert.ok(index.includes(`href="/guides/${slug}"`), `Guides index must link to ${slug}`);
      assert.ok(index.includes(title), `Guides index must name ${title}`);
    }
    assert.match(index, /Instantly convert between currencies, cryptocurrencies, and precious metals/);
  });

  it('gives each article a unique title, article metadata, and relevant content and links', () => {
    const titles = new Set(guidePages.map(({ title }) => title));
    assert.equal(titles.size, guidePages.length, 'Article titles must be unique');

    for (const { file, title, requiredContent } of guidePages) {
      const article = readFileSync(new URL(`../src/pages/guides/${file}`, import.meta.url), 'utf8');
      assert.ok(article.includes(`const pageTitle = '${title}';`), `${file} must set its title`);
      assert.match(article, /const pageDescription =\s*'[^']+'/);
      assert.ok(article.includes('<h1 class="info-title">{pageTitle}</h1>'), `${file} must have one clear H1`);
      assert.ok(article.includes('ogType="article"'), `${file} must use article Open Graph metadata`);

      for (const content of requiredContent) {
        assert.ok(article.includes(content), `${file} must include: ${content}`);
      }
    }
  });

  it('adds a Guides link to the existing footer navigation', () => {
    const footer = readFileSync(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');
    assert.match(footer, /<a href="\/guides" class="footer-nav-link">Guides<\/a>/);
  });
});
