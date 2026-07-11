// Курований (НЕ скопійований вербатим з roadmap.sh) кістяк IT-роадмепу для
// junior Full Stack (той самий профіль, що config.yml modules.jobs.profile/
// modules.mock.profile: JS/TS, React, Node.js, HTML/CSS). Блок P3.
//
// interface Subtopic { id: string; title: string }
// interface Topic { id: string; title: string; subtopics: Subtopic[] }
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
    subtopics: [
      { id: 'core-web-vitals', title: 'Core Web Vitals' },
      { id: 'lazy-loading', title: 'Lazy loading, code splitting' },
      { id: 'a11y-basics', title: 'Доступність: семантика, клавіатура, ARIA' },
    ],
  },
];
