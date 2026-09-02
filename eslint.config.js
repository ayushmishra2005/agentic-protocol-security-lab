import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'runs/**', 'coverage/**', '.specify/**', '.cursor/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Article II: the host must never hand a shell or an interpolated command
      // string to a child process. These bans are enforced by lint as well as by
      // the exec primitive's own validation.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              message: 'Use src/security/exec.ts, which forbids shell execution.',
            },
            {
              name: 'node:child_process',
              message: 'Use src/security/exec.ts, which forbids shell execution.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through src/config.ts.',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // The exec primitive is the single sanctioned child_process call site, and
    // config.ts is the single sanctioned process.env call site.
    files: ['src/security/exec.ts', 'src/config.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
      // node:test's describe/it return promises the runner already awaits.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['after', 'before', 'beforeEach', 'afterEach', 'describe', 'it', 'test'],
            },
          ],
        },
      ],
    },
  },
  {
    // Config files are plain JS and outside the type-checked project.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
