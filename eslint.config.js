import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // web/app — React-дашборд із власним toolchain (Vite/TSX, свій tsc -b у CI);
  // кореневий eslint (node-globals, лише **/*.ts) його не покриває (роадмеп v3 E).
  // web/app — React-дашборд із власним toolchain (Vite/TSX, свій tsc -b у CI);
  // web/public/app — його зібраний артефакт (не лінтимо мініфікований бандл).
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'web/app/', 'web/public/app/'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // guard-core.mjs та scripts/*.mjs виконуються на «голому» node — звичайний JS
    files: ['**/*.mjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  prettier,
);
