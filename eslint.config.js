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
    // host/**, scripts/** і генератори виконуються на «голому» node.
    files: ['**/*.mjs', '**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  {
    // ⚠️ Код Worker'а виконує workerd, а не node. Блок вище давав йому
    // node-глобали, тож `no-undef` мовчав би на `process.env` чи `Buffer` —
    // тобто рівно на тому, що в проді падає. Тут набір інший: глобали
    // service-worker-подібного рантайму (fetch/Response/crypto/caches/…).
    //
    // ⚠️ node-глобали доводиться гасити ПОІМЕННО ('off' на кожен). Конфіги в
    // flat config ЗЛИВАЮТЬСЯ, і `languageOptions.globals` мержиться вглиб —
    // `globals: {}` тут нічого не скидає, воно просто нічого не додає. Спокуса
    // «спростити» цей рядок саме так поверне node-глобали мовчки.
    files: ['web/*.mjs', 'web/worker.js'],
    languageOptions: {
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map((k) => [k, 'off'])),
        ...globals.serviceworker,
      },
    },
  },
  prettier,
);
