import { defineConfig } from 'vitest/config';

// Coverage floors set by risk (ADR-0008). Globs that match no files yet start biting as K1 adds code.
const all = (pct: number) => ({ branches: pct, statements: pct, functions: pct, lines: pct });

export default defineConfig({
  test: {
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/nitro/**', 'scripts/**'],
      exclude: ['src/testing/**', '**/*.test.ts'],
      thresholds: {
        ...all(90),
        'src/core/vault/**': all(100),
        'src/core/logging/redact*': all(100),
        'src/core/secrets/**': all(95),
        'src/core/runtime/**': all(95),
        'src/core/security/client-address*': all(95),
        // A wrong answer from the release's npm check pushes a tag with nothing published.
        'scripts/**': all(100),
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/package/**', 'test/fixtures/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'package',
          include: ['test/package/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
