/**
 * The README's language count must match the code.
 *
 * It said "15 languages" in two places while supported-languages.js listed
 * sixteen — French was added and the prose was not. Nobody noticed because
 * nothing checked, and the number is the kind of claim that gets read aloud
 * in a demo or copied into a funding application before anyone counts.
 *
 * This is the same guard shape as env-template-completeness: a fact stated in
 * documentation, checked against the code that defines it.
 */

const fs = require('fs');
const path = require('path');

const README = path.resolve(__dirname, '../../README.md');
const { SUPPORTED_LANGUAGES, LANGUAGES } = require('../../bot/shared/config/supported-languages');

describe('README language count', () => {
  const readme = fs.readFileSync(README, 'utf-8');

  it('the config agrees with itself', () => {
    // A code in SUPPORTED_LANGUAGES with no LANGUAGES entry renders as its own
    // bare code in the picker ("pa-PK" rather than "پنجابی").
    expect(Object.keys(LANGUAGES).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it('every "N languages" claim in the README matches SUPPORTED_LANGUAGES', () => {
    const claims = [...readme.matchAll(/(\d+)\s+languages/gi)].map((m) => Number(m[1]));

    // If the phrasing changes entirely, this test should fail loudly rather
    // than pass vacuously by finding nothing to check.
    expect(claims.length).toBeGreaterThan(0);

    for (const claimed of claims) {
      expect(claimed).toBe(SUPPORTED_LANGUAGES.length);
    }
  });
});
