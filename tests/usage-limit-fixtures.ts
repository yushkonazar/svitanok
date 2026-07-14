// Спільний фікстур-набір для трьох НАВМИСНО дубльованих копій USAGE_LIMIT_RE:
//   host/llm-host-core.mjs  (VPS-реле, окремий деплой)
//   web/agent-core.mjs      (Cloudflare Worker, має впізнати ліміт і зі СТАРОГО хоста)
//   src/core/llm.ts         (оркестратор у GitHub Actions, свій claude -p)
// Код вони не шарять свідомо (три різні деплої), але поведінка мусить збігатися.
// Ревʼю A: одна з копій народилась із втраченою гілкою patterns — цей набір і
// паритетні тести в кожному з трьох *.test.ts більше не дадуть їм тихо розʼїхатись.

/** Тексти claude CLI, що ОЗНАЧАЮТЬ вичерпаний ліміт підписки. */
export const USAGE_LIMIT_TEXTS = [
  'Claude AI usage limit reached|1752620400',
  "You've hit your session limit · resets 11pm",
  "You've hit your weekly limit",
  'Weekly limit reached. Try again later.',
  '5-hour limit reached',
  'Your limit will reset at 9am',
  'Upgrade to increase your usage limit',
  // Так само мусить ловитись, коли текст загорнутий у помилку оркестратора:
  'claude -p exit 1: Claude AI usage limit reached|1752620400',
];

/** Тексти, що лімітом НЕ є (не брехати власнику про причину). */
export const NON_LIMIT_TEXTS = [
  'overloaded',
  'claude -p таймаут 150000ms',
  'claude -p exit 1: spawn claude ENOENT',
  'LLM maxCallsPerRun (5) перевищено',
  'bad-output',
  '',
];
