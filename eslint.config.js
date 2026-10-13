import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ADR-0006: the core is framework-free. These are the only specifiers it may never reach.
const FRAMEWORK = '^(h3|nitropack|nuxt|#imports)(/.*)?$';
const BOUNDARY_MESSAGE = 'src/core must stay framework-free (ADR-0006): put h3/Nitro/Nuxt code in src/nitro.';

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
      'no-restricted-imports': ['error', { patterns: [{ regex: FRAMEWORK, message: BOUNDARY_MESSAGE }] }],
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
);
