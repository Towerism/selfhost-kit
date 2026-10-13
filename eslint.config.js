import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ADR-0006: the core is framework-free. These are the specifiers it may never reach.
const FRAMEWORK = '^(h3|nitropack|nuxt|#imports|vitest)(/.*)?$';
const BOUNDARY_MESSAGE = 'src/core must stay framework-free (ADR-0006): put h3/Nitro/Nuxt code in src/nitro.';
// ADR-0006: /testing is never imported by production code.
const TESTING = '(^|/)testing(/|$)';
const TESTING_MESSAGE = 'src/testing is for tests only (ADR-0006): production code may not import it.';

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
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
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
    files: ['src/nitro/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: TESTING, message: TESTING_MESSAGE }] }],
    },
  },
);
