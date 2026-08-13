import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Лінт Mini App (аудит C2: «ESLint взагалі не покриває web/app»).
//
// Кореневий конфіг цю теку ІГНОРУЄ навмисно — тут інший світ: браузерні
// глобали, JSX, хуки. Тому власний конфіг поруч із власним package.json, як і
// решта toolchain'у (vite, tsc -b, vitest).
//
// ЩО САМЕ ЛОВИМО. Головне — `react-hooks`: правила залежностей і порядку
// викликів ловлять клас помилок, який не видно ні типам, ні збірці, а
// проявляється як «дані не оновились» чи «ефект стрельнув двічі». Саме на них
// у коді стояли декоративні `eslint-disable`-коментарі, які ніхто не перевіряв
// — бо лінтера не було.
//
// ⚠️ jsx-a11y СВІДОМО НЕ ПІДКЛЮЧЕНО: eslint-plugin-jsx-a11y@6 не підтримує
// ESLint 10 (peer ≤9), а відкочувати лінтер на стару мажорну заради нього —
// гірший розмін. Знахідки доступності з аудиту (F8 Sheet без role="dialog",
// F9 тапи по чартах без клавіатури) лишаються ручними задачами; щойно вийде
// сумісна версія — додати сюди.
export default tseslint.config(
  { ignores: ['dist/', '../public/app/'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      /* ── Борг ЗАКРИТО, правила підняті до 'error' ─────────────────────────
         Було сім успадкованих порушень, зафіксованих у момент увімкнення
         лінтера. Обидва правила описували РЕАЛЬНІ проблеми, і кожне полікували
         переписуванням, а не глушником:
           set-state-in-effect (3) — CountUp, controls.tsx (скидання чернетки),
             saved.tsx (вливання Set зі списку). Усі три переведені на
             КОРИГУВАННЯ СТАНУ ПІД ЧАС РЕНДЕРА — патерн, який React документує
             саме для «скинути стан, коли проп змінився». Заразом це прибрало
             зайвий коміт: кадр зі старим значенням більше не встигає на екран.
           refs (4) — KanbanBoard читав ref.current під час рендера, щоб
             позиціювати клон картки за пальцем. Ref для цього непридатний за
             побудовою: рендер не перезапускається від його зміни, і картинка
             збігалася лише тому, що поруч оновлювався `pos`. Тепер це стан.
         'error', а не 'warn': борг закрито, і повертатись йому нема куди.
         Кожне місце покрите компонентними тестами, написаними ДО рефактора. */
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/refs': 'error',
    },
  },
  prettier,
);
