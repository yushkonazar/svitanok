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
    id: 'tools',
    title: '🛠 Git / Тестування / Деплой',
    subtopics: [
      { id: 'git-basics', title: 'Git: коміти, гілки, merge' },
      { id: 'git-workflow', title: 'Git-flow, Pull Request, code review' },
      { id: 'testing-basics', title: 'Юніт-тести основи' },
      { id: 'ci-basics', title: 'CI/CD основи' },
      { id: 'deployment', title: 'Деплой (Docker/хмарний хостинг)' },
    ],
  },
];
