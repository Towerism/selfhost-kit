import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ADR-0006: the core is framework-free. These are the specifiers it may never reach.
const FRAMEWORK = '^(h3|nitropack|nuxt|#imports|vitest)(/.*)?$';
const BOUNDARY_MESSAGE = 'src/core must stay framework-free (ADR-0006): put h3/Nitro/Nuxt code in src/nitro.';
// ADR-0006: /testing is never imported by production code.
const TESTING = '(^|/)testing(/|$)';
const TESTING_MESSAGE = 'src/testing is for tests only (ADR-0006): production code may not import it.';
// ADR-0006: the adapters import the core and h3 only, never Nitro or Nuxt themselves.
const NITRO_FRAMEWORK = '^(nitropack|nuxt|#imports)(/.*)?$';
const NITRO_MESSAGE =
  'src/nitro may import only the core and h3 (ADR-0006): the app passes Nitro values in as arguments.';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'test/fixtures/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: FRAMEWORK, message: BOUNDARY_MESSAGE },
            { regex: TESTING, message: TESTING_MESSAGE },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        // esquery regex literals end at the first unescaped "/".
        {
          selector: `ImportExpression[source.value=/${FRAMEWORK.replaceAll('/', '\\/')}/]`,
          message: BOUNDARY_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['src/cli/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: TESTING, message: TESTING_MESSAGE }] }],
    },
  },
  {
    files: ['src/nitro/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: NITRO_FRAMEWORK, message: NITRO_MESSAGE },
            { regex: TESTING, message: TESTING_MESSAGE },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportExpression[source.value=/${NITRO_FRAMEWORK.replaceAll('/', '\\/')}/]`,
          message: NITRO_MESSAGE,
        },
      ],
    },
  },
);
