// Контракт аналізу ідеї по коду між ядром і скриптом Actions
// (scripts/idea-analysis.mjs): один модуль без Cloudflare-імпортів, який
// імпортують обидві сторони - замість двох копій і тесту парності між ними.

/** Репозиторії, доступні для аналізу (S-3-8). */
export const IDEA_REPOS = ['svitanok', 'portfolio', 'moviehouse', 'modern-blog'];

/** Inputs idea-analysis.yml = поля dispatch з ядра (парність з yml тримає тест скрипта). */
export const DISPATCH_INPUTS = ['run_id', 'idea_id', 'repo', 'sha', 'title', 'idea'];

/** Кап тексту ідеї в inputs (inputs воркфлоу ≤ 65 535 символів разом). */
export const DISPATCH_IDEA_MAX = 12_000;

/** Кап звіту в артефакті - у БАЙТАХ UTF-8: тіло /internal/* ≤ 128 KiB
 *  (MAX_INTERNAL_BODY_BYTES ядра), запас - на JSON-екранування й решту полів. */
export const ARTIFACT_MD_MAX_BYTES = 96_000;

/** Кап тіла ідеї/аналізу/плану в базі (реєстр ideas і analysis_md). */
export const IDEA_TEXT_MAX = 20_000;

/** Стеля job в Actions (07 §6, timeout-minutes у yml). */
export const JOB_TIMEOUT_MIN = 40;
