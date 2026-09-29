import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // core/ はシード付き PRNG のみを使い、UI・DOM・ネットワークに依存しない（CLAUDE.md）。
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'core/ ではシード付き PRNG（prng.ts）を使うこと。' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'core/ から通信しない。データは引数で受け取る。' },
        { name: 'window', message: 'core/ は DOM に依存させない。' },
        { name: 'document', message: 'core/ は DOM に依存させない。' },
        { name: 'self', message: 'core/ は Worker 環境に依存させない。worker/ で扱う。' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'node:*', '../ui/*', '../worker/*'],
              message: 'core/ は UI・Node・Worker に依存させない。',
            },
          ],
        },
      ],
    },
  },
);
