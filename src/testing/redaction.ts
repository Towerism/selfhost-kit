import { describe, expect, it } from 'vitest';
import { BASE_KEY_NAMES, type Redactor, normalizeKey } from '../core/logging/redact.js';

/** `refreshToken` → refreshToken, refresh_token, refresh-token, REFRESH_TOKEN, Refresh-Token. */
export function keySpellings(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const camel = words.map((w, i) => (i === 0 ? w : cap(w))).join('');
  return [
    ...new Set([
      camel,
      words.join('_'),
      words.join('-'),
      words.join('_').toUpperCase(),
      words.map(cap).join('-'),
    ]),
  ];
}

const nest = (depth: number, leaf: Record<string, unknown>): Record<string, unknown> =>
  depth === 0 ? leaf : { level: nest(depth - 1, leaf) };

/** Distinct per key, and made only of characters the scrubber treats as part of one value. */
const valueFor = (key: string) => `Sx${normalizeKey(key)}Value7q`;

/**
 * Registers Vitest tests proving a redactor hides every key in `mustHide` (and always the base list) in
 * every spelling and position a log can carry it, and keeps every key in `mustShow` visible.
 *
 * Run it in each app against the redactor the app builds, with its own sensitive keys and the look-alikes
 * that must stay readable (for example `tokenCount`).
 */
export function describeRedactionContract(
  redactor: Redactor,
  opts: { mustHide: readonly string[]; mustShow: readonly string[] },
): void {
  const byNormal = new Map<string, string>();
  for (const key of [...BASE_KEY_NAMES, ...opts.mustHide]) byNormal.set(normalizeKey(key), key);
  const hidden = [...byNormal.values()];
  const leaks = (output: unknown, value: string) => JSON.stringify(output).includes(value);

  describe('redaction contract', () => {
    it.each(hidden)('hides %s in every spelling, at depth 1 and 7, and inside arrays', (key) => {
      const value = valueFor(key);
      for (const spelling of keySpellings(key)) {
        for (const shape of [
          { [spelling]: value },
          nest(1, { [spelling]: value }),
          nest(7, { [spelling]: value }),
          { list: [{ [spelling]: value }] },
        ]) {
          expect(leaks(redactor.redact(shape), value), `${spelling} in ${JSON.stringify(shape)}`).toBe(false);
        }
      }
    });

    it.each(hidden)('hides %s in name=value and JSON-style strings', (key) => {
      const value = valueFor(key);
      for (const spelling of keySpellings(key)) {
        for (const text of [
          `${spelling}=${value}`,
          `x=1&${spelling}=${value}&y=2`,
          `{"${spelling}":"${value}"}`,
        ]) {
          expect(redactor.scrub(text), text).not.toContain(value);
          expect(leaks(redactor.redact({ msg: text }), value), text).toBe(false);
        }
      }
    });

    it.each(hidden)("hides %s in an error's message, stack, fields and cause", (key) => {
      const value = valueFor(key);
      const cause = Object.assign(new Error(`inner ${key}=${value}`), { [key]: value });
      const err = Object.assign(new Error(`failed with ${key}=${value}`, { cause }), { [key]: value });
      expect(leaks(redactor.redact({ err }), value)).toBe(false);
    });

    it('hides Bearer credentials in any text', () => {
      for (const text of ['Bearer Sx.bearer-Value7q', 'authorization: bearer Sx.bearer-Value7q, next']) {
        expect(redactor.scrub(text)).not.toContain('Sx.bearer-Value7q');
      }
    });

    if (opts.mustShow.length > 0) {
      it.each([...opts.mustShow])('keeps %s visible', (key) => {
        const value = valueFor(key);
        expect(leaks(redactor.redact({ [key]: value }), value)).toBe(true);
        expect(redactor.scrub(`${key}=${value}`)).toContain(value);
      });
    }
  });
}
