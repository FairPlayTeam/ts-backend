import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules', 'dist'],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
