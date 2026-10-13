import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

// Branch, statement, function and line thresholds per area, set by risk (ADR-0008).
const all = (pct: number) => ({ branches: pct, statements: pct, functions: pct, lines: pct });

describe('vitest config', () => {
  it('gates coverage by risk (ADR-0008), with the release scripts at 100%', () => {
    expect(config.test?.coverage?.thresholds).toEqual({
      ...all(90),
      'src/core/vault/**': all(100),
      'src/core/logging/redact*': all(100),
      'src/core/secrets/**': all(95),
      'src/core/runtime/**': all(95),
      'src/core/security/client-address*': all(95),
      // A wrong answer from the release's npm check pushes a tag with nothing published.
      'scripts/**': all(100),
    });
  });

  it('measures core, nitro and the release scripts, never the testing helpers', () => {
    const coverage = config.test?.coverage as { include?: string[]; exclude?: string[] };
    expect(coverage.include).toEqual(['src/core/**', 'src/nitro/**', 'scripts/**']);
    expect(coverage.exclude).toEqual(expect.arrayContaining(['src/testing/**', '**/*.test.ts']));
  });

  it('runs every test in UTC', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });
});
