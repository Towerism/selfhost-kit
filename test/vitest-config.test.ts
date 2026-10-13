import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

// Branch, statement, function and line thresholds per area, set by risk (ADR-0008).
const all = (pct: number) => ({ branches: pct, statements: pct, functions: pct, lines: pct });

describe('vitest config', () => {
  it('gates coverage by risk, exactly as ADR-0008 sets it', () => {
    expect(config.test?.coverage?.thresholds).toEqual({
      ...all(90),
      'src/core/vault/**': all(100),
      'src/core/logging/redact*': all(100),
      'src/core/secrets/**': all(95),
      'src/core/runtime/**': all(95),
      'src/core/security/client-address*': all(95),
    });
  });

  it('measures core and nitro, never the testing helpers', () => {
    const coverage = config.test?.coverage as { include?: string[]; exclude?: string[] };
    expect(coverage.include).toEqual(['src/core/**', 'src/nitro/**']);
    expect(coverage.exclude).toEqual(expect.arrayContaining(['src/testing/**', '**/*.test.ts']));
  });

  it('runs every test in UTC', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });
});
