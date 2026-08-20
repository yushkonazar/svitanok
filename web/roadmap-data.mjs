// @ts-check
// Курований (НЕ скопійований вербатим з roadmap.sh) кістяк IT-роадмепу для
// junior Full Stack (той самий профіль, що config.yml modules.jobs.profile/
// modules.mock.profile: JS/TS, React, Node.js, HTML/CSS). Блок P3.
//
// interface Material { title: string; url: string }
// interface Subtopic { id: string; title: string }
// interface Topic { id: string; title: string; materials: Material[]; subtopics: Subtopic[] }
//
// materials (F5) — КУРОВАНИЙ список: 1-2 канонічні джерела на тему, не
// автогенерація й не пошуковий запит. Беремо офіційну документацію та сталі
// підручники — вони найменше гниють; де є українська версія, беремо її.
// Живить «Вивчити» в картці питання дня (F4) і кнопки-посилання в /roadmap.
//
// id — ЛОКАЛЬНИЙ слаг, БЕЗ символів ':' (парситься з callback_data у
// roadmap-core.mjs, `:` — роздільник полів) і '.' (roadmap-core.mjs:
// progressKey клеїть "topicId.subtopicId" — крапка в id спричинить
// колізію ключів прогресу двох різних пунктів). Глобальний ключ прогресу
// збирається окремо (progressKey), тут не дублюється. Обидва обмеження
// перевірені тестом (tests/roadmap-core.test.ts).
//
// Ревізія 2026-07 (аудит): додано TypeScript/Безпека/HTTP-мережі/Тестування
// (поглиблено)/Тулінг-екосистему/AI-у-розробці/Продуктивність+a11y — сучасні
// теми співбесід 2026 (roadmap.sh), яких бракувало (профіль скрізь TS, а
// роадмеп його не мав). Наявні react/backend/tools доповнено (Next.js/React
// Query, черги/rate-limiting, Docker глибше/serverless). MOCK_TOPICS
// (src/modules/mock.ts) розширено дзеркально (Безпека, AI/LLM) — той самий
// словник тем для інтерв'ю-питань і роадмепу, без окремої логіки звʼязку.

export const ROADMAP_TOPICS = [
  {
    id: 'frontend',
    title: '🌐 Frontend основи',
    materials: [
      {
        title: 'MDN — навчання вебу',
        url: 'https://developer.mozilla.org/uk/docs/Learn_web_development',
      },
      { title: 'JavaScript.info (укр)', url: 'https://uk.javascript.info/' },
    ],
    subtopics: [
      { id: 'html-semantics', title: 'HTML: семантична розмітка' },
      { id: 'css-layout', title: 'CSS: flexbox, grid, адаптивність' },
      { id: 'js-fundamentals', title: 'JavaScript: типи, функції, замикання' },
      { id: 'dom-events', title: 'DOM: маніпуляції, події, делегування' },
      { id: 'async-js', title: 'Асинхронність: Promise, async/await' },
      { id: 'fetch-api', title: 'Fetch/HTTP-запити з браузера' },
      { id: 'devtools', title: 'DevTools: дебаг, Network, Performance' },
    ],
  },
  {
    id: 'typescript',
    title: '🟦 TypeScript',
    materials: [
      {
        title: 'TypeScript Handbook',
        url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
      },
      { title: 'Type Challenges', url: 'https://github.com/type-challenges/type-challenges' },
    ],
    subtopics: [
      { id: 'ts-types-basics', title: 'Типи, інтерфейси, generics' },
      { id: 'ts-narrowing', title: 'Звуження типів, union/intersection' },
      { id: 'ts-react-typing', title: 'Типізація React (props, hooks)' },
      { id: 'ts-strict-config', title: 'tsconfig: strict-режим' },
      { id: 'ts-runtime-validation', title: 'Валідація API-відповідей (zod)' },
    ],
  },
  {
    id: 'react',
    title: '⚛️ React',
    materials: [
      { title: 'React — вчитися', url: 'https://react.dev/learn' },
      {
        title: 'TanStack Query',
        url: 'https://tanstack.com/query/latest/docs/framework/react/overview',
      },
    ],
    subtopics: [
      { id: 'jsx-components', title: 'JSX, компоненти, композиція' },
      { id: 'props-state', title: 'Props і state' },
      { id: 'hooks-basics', title: 'Хуки: useState, useEffect' },
      { id: 'hooks-advanced', title: 'Хуки: useMemo, useCallback, custom hooks' },
      { id: 'forms', title: 'Форми і валідація' },
      { id: 'routing', title: 'Маршрутизація (react-router)' },
      { id: 'state-management', title: 'Керування станом (Context/бібліотеки)' },
      { id: 'nextjs-ssr', title: 'Next.js: SSR/RSC — огляд' },
      { id: 'server-state', title: 'Серверний стан (React Query/SWR)' },
    ],
  },
  {
    id: 'backend',
    title: '🖥 Backend / Node.js',
    materials: [
      { title: 'Node.js — вчитися', url: 'https://nodejs.org/en/learn' },
      { title: 'Express — гайд', url: 'https://expressjs.com/en/guide/routing.html' },
    ],
    subtopics: [
      { id: 'node-basics', title: 'Node.js: модулі, event loop' },
      { id: 'express-http', title: 'Express: маршрути, middleware' },
      { id: 'rest-api-design', title: 'Дизайн REST API' },
      { id: 'auth-basics', title: 'Автентифікація: сесії/JWT' },
      { id: 'error-handling', title: 'Обробка помилок і валідація вводу' },
      { id: 'env-config', title: 'Конфігурація, змінні середовища, секрети' },
      { id: 'logging', title: 'Логування й базовий моніторинг' },
      { id: 'queues-jobs', title: 'Черги й фонові задачі' },
      { id: 'rate-limiting', title: 'Rate limiting' },
    ],
  },
  {
    id: 'databases',
    title: '🗄 Бази даних / SQL',
    materials: [
      {
        title: 'PostgreSQL — туторіал',
        url: 'https://www.postgresql.org/docs/current/tutorial.html',
      },
      { title: 'Use The Index, Luke', url: 'https://use-the-index-luke.com/' },
    ],
    subtopics: [
      { id: 'relational-model', title: 'Реляційна модель, нормалізація' },
      { id: 'sql-basics', title: 'SQL: SELECT/JOIN/GROUP BY' },
      { id: 'sql-advanced', title: 'SQL: транзакції, індекси' },
      { id: 'orm', title: 'ORM (напр. Prisma/TypeORM)' },
      { id: 'nosql-basics', title: 'NoSQL основи (документні БД)' },
      { id: 'migrations', title: 'Міграції схеми БД' },
    ],
  },
  {
    id: 'algorithms',
    title: '🧮 Алгоритми та структури даних',
    materials: [
      { title: 'NeetCode — роадмеп', url: 'https://neetcode.io/roadmap' },
      { title: 'VisuAlgo — візуалізації', url: 'https://visualgo.net/en' },
    ],
    subtopics: [
      { id: 'complexity', title: 'Складність алгоритмів (Big O)' },
      { id: 'arrays-lists', title: 'Масиви, списки, рядки' },
      { id: 'sorting-searching', title: 'Сортування й пошук' },
      { id: 'recursion', title: 'Рекурсія' },
      { id: 'hash-tables', title: 'Хеш-таблиці' },
      { id: 'stacks-queues', title: "Стек, черга, зв'язний список" },
    ],
  },
  {
    id: 'security',
    title: '🔐 Веб-безпека',
    materials: [
      { title: 'OWASP Top 10', url: 'https://owasp.org/www-project-top-ten/' },
      { title: 'OWASP Cheat Sheets', url: 'https://cheatsheetseries.owasp.org/' },
    ],
    subtopics: [
      { id: 'owasp-top10', title: 'OWASP Top 10 — огляд' },
      { id: 'xss-csrf', title: 'XSS/CSRF на практиці' },
      { id: 'secrets-storage', title: 'Зберігання секретів, env' },
      { id: 'oauth-oidc', title: 'OAuth2/OIDC — флоу авторизації' },
      { id: 'input-validation', title: 'Валідація і санітизація вводу' },
    ],
  },
  {
    id: 'networking',
    title: '📡 HTTP / мережі (поглиблено)',
    materials: [
      { title: 'MDN — HTTP', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP' },
      { title: 'High Performance Browser Networking', url: 'https://hpbn.co/' },
    ],
    subtopics: [
      { id: 'http-caching', title: 'Кешування: ETag, Cache-Control' },
      { id: 'cors-deep', title: 'CORS по-справжньому' },
      { id: 'websockets-sse', title: 'WebSockets/SSE' },
      { id: 'http2-http3', title: 'HTTP/2, HTTP/3 — огляд' },
    ],
  },
  {
    id: 'testing-adv',
    title: '🧪 Тестування (поглиблено)',
    materials: [
      { title: 'Playwright — старт', url: 'https://playwright.dev/docs/intro' },
      { title: 'Testing Library', url: 'https://testing-library.com/docs/' },
    ],
    subtopics: [
      { id: 'integration-tests', title: 'Інтеграційні тести' },
      { id: 'e2e-playwright', title: 'E2E (Playwright/Cypress)' },
      { id: 'mocking', title: 'Мокування залежностей' },
      { id: 'api-testing', title: 'Тестування API' },
      { id: 'tdd-mindset', title: 'TDD: мислення тестами наперед' },
    ],
  },
  {
    id: 'tools',
    title: '🛠 Git / Тестування / Деплой',
    materials: [
      { title: 'Pro Git (укр)', url: 'https://git-scm.com/book/uk/v2' },
      { title: 'Docker — старт', url: 'https://docs.docker.com/get-started/' },
    ],
    subtopics: [
      { id: 'git-basics', title: 'Git: коміти, гілки, merge' },
      { id: 'git-workflow', title: 'Git-flow, Pull Request, code review' },
      { id: 'testing-basics', title: 'Юніт-тести основи' },
      { id: 'ci-basics', title: 'CI/CD основи' },
      { id: 'deployment', title: 'Деплой (Docker/хмарний хостинг)' },
      { id: 'docker-deep', title: 'Docker глибше (multi-stage, compose)' },
      { id: 'serverless-workers', title: 'Serverless (Cloudflare Workers)' },
    ],
  },
  {
    id: 'ecosystem',
    title: '📦 Тулінг / екосистема',
    materials: [
      { title: 'Vite — гайд', url: 'https://vite.dev/guide/' },
      { title: 'npm — semver', url: 'https://docs.npmjs.com/about-semantic-versioning' },
    ],
    subtopics: [
      { id: 'package-managers', title: 'npm/pnpm, semver, lock-файли' },
      { id: 'bundlers', title: 'Vite/бандлінг' },
      { id: 'lint-format', title: 'ESLint/Prettier' },
      { id: 'monorepo-basics', title: 'Основи монорепо' },
    ],
  },
  {
    id: 'ai-dev',
    title: '🤖 AI-у-розробці',
    materials: [
      {
        title: 'Anthropic — інженерія промптів',
        url: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview',
      },
      { title: 'Anthropic — огляд API', url: 'https://docs.anthropic.com/en/api/overview' },
    ],
    subtopics: [
      { id: 'ai-assisted-coding', title: 'Ефективна робота з AI-асистентами' },
      { id: 'llm-api-basics', title: 'LLM API: промпти, структуровані відповіді' },
      { id: 'rag-embeddings', title: 'Основи RAG/embeddings' },
      { id: 'llm-output-limits', title: 'Межі й перевірка виводу LLM' },
    ],
  },
  {
    id: 'perf-a11y',
    title: '⚡ Продуктивність і доступність',
    materials: [
      { title: 'web.dev — Core Web Vitals', url: 'https://web.dev/articles/vitals' },
      { title: 'A11y Project — чеклист', url: 'https://www.a11yproject.com/checklist/' },
    ],
    subtopics: [
      { id: 'core-web-vitals', title: 'Core Web Vitals' },
      { id: 'lazy-loading', title: 'Lazy loading, code splitting' },
      { id: 'a11y-basics', title: 'Доступність: семантика, клавіатура, ARIA' },
    ],
  },
];
