// @ts-ignore
import { describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('Precious-metal asset-code redirects', () => {
  it('defines permanent redirects for slashless and trailing-slash aliases', () => {
    const redirects = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8');
    const rules = redirects
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/));
    const expected = [
      ['/xau-to-usd', '/gold-to-usd'],
      ['/xau-to-usd/', '/gold-to-usd'],
      ['/usd-to-xau', '/usd-to-gold'],
      ['/usd-to-xau/', '/usd-to-gold'],
      ['/xag-to-usd', '/silver-to-usd'],
      ['/xag-to-usd/', '/silver-to-usd'],
      ['/usd-to-xag', '/usd-to-silver'],
      ['/usd-to-xag/', '/usd-to-silver'],
    ];

    for (const [source, destination] of expected) {
      const matchingRules = rules.filter(([ruleSource]) => ruleSource === source);
      assert.equal(matchingRules.length, 1, `Expected one redirect rule for ${source}`);
      assert.deepEqual(matchingRules[0], [source, destination, '301']);
    }
  });
});
