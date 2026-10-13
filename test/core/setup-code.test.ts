import { describe, expect, it } from 'vitest';
import { generateSetupCode, setupCodeMatches } from '../../src/core/setup-code/index.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

describe('generateSetupCode', () => {
  const codes = Array.from({ length: 10_000 }, generateSetupCode);

  it('is two groups of four easy-to-read characters (read off a log, typed by hand)', () => {
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('draws every symbol evenly, so no position is guessable', () => {
    const counts = new Map<string, number>();
    for (const code of codes)
      for (const ch of code.replace('-', '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const mean = (codes.length * 8) / ALPHABET.length;

    expect([...counts.keys()].sort().join('')).toBe(Array.from(ALPHABET).sort().join(''));
    for (const [symbol, count] of counts) {
      expect(Math.abs(count - mean) / mean, symbol).toBeLessThan(0.4);
    }
  });

  it('does not repeat', () => {
    expect(new Set(codes.slice(0, 1000)).size).toBe(1000);
  });
});

describe('setupCodeMatches', () => {
  const code = 'ABCD-EF23';

  it.each(['ABCD-EF23', 'abcd-ef23', ' ABCDEF23 ', 'abcd ef23', 'AB-CD-EF-23'])('accepts %j', (given) => {
    expect(setupCodeMatches(code, given)).toBe(true);
  });

  it.each(['ABCD-EF24', 'ABCD-EF2', 'ABCD-EF233', '', '--------', '----'])('rejects %j', (given) => {
    expect(setupCodeMatches(code, given)).toBe(false);
  });

  it('never matches when nothing was entered, even against an empty expected code', () => {
    expect(setupCodeMatches('', '')).toBe(false);
  });
});
