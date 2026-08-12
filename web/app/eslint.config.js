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

      /* ── Успадкований борг: 7 місць, зафіксованих у момент увімкнення лінтера ──
         Обидва правила справедливі й описують РЕАЛЬНІ проблеми:
           set-state-in-effect (3) — CountUp, controls.tsx (скидання чернетки),
             saved.tsx (синхронізація Set зі списком). Кожне лікується
             переписуванням на похідний стан, а не глушником.
           refs (4) — KanbanBoard читає ref.current під час рендера, щоб
             позиціювати клон картки за пальцем.
         Це «warn», а не «off»: борг має бути видно в кожному прогоні. І не
         «error» — бо чесний фікс кожного з них є ЗМІНОЮ ПОВЕДІНКИ (анімація,
         драг, чернетка), тобто вимагає компонентних тестів на ті самі місця;
         тепер, коли harness є, вони робляться окремими задачами.
         ⚠️ Кількість запінено в скрипті lint (--max-warnings 7): нові
         порушення валять CI, старі не дають про себе забути. */
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  prettier,
);
