// Оркестратор (§4.1): рання валідація секретів -> guard -> producers ->
// consumers -> render -> send -> set lastSentDate -> flush. Один впалий модуль не
// валить брифінг (allSettled). Семантика at-least-once: send -> set -> flush;
// git-коміт стану у гілку `state` робить brief.yml (§4.3).
//
// runBriefing виділено для тестів (інжектовані залежності); main() зшиває реальні.

import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './core/config.js';
import { createClock, type Clock } from './core/clock.js';
import { createLogger } from './core/logger.js';
import { createStateStore } from './core/state.js';
import { createRunBus } from './core/bus.js';
import { createLLMClient } from './core/llm.js';
import { createFetcher } from './core/fetcher.js';
import { createNotifier, type Notifier } from './core/telegram.js';
import { renderBriefing, formatKyivDateHeader } from './core/render.js';
import { partitionModules } from './core/registry.js';
import { sendGuard } from './core/guard.js';
import { requireCriticalSecrets, optionalSecret, MissingSecretsError } from './core/secrets.js';
import type {
  Module,
  Block,
  Ctx,
  StateStore,
  RunBus,
  LLMClient,
  SourceFetcher,
  Logger,
} from './core/types.js';
import { createWeatherModule } from './modules/weather.js';
import { createCalendarModule } from './modules/calendar.js';
import { stoicModule } from './modules/stoic.js';
import { todayModule } from './modules/today.js';
import { newsModule } from './modules/news.js';
import { nextStepModule } from './modules/next-step.js';
import { weeklyReviewModule } from './modules/weekly-review.js';
import { buildPruners } from './core/prune.js';

export interface RunOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface RunDeps {
  config: AppConfig;
  clock: Clock;
  state: StateStore;
  bus: RunBus;
  llm: LLMClient;
  fetcher: SourceFetcher;
  log: Logger;
  modules: Module<AppConfig>[];
  notifier: Notifier | null;
}

export type RunStatus = 'sent' | 'skipped' | 'dry-run';

export interface RunResult {
  status: RunStatus;
  reason: string;
  messages: string[];
  quiet: boolean;
}

/** Тихий день (§6): ВСІ активні trigger-джерела порожні. Якщо жодне з trigger-
 *  джерел не увімкнене — НЕ тихий день (нема чому «мовчати»). Неділя/weekly-review
 *  доопрацьовується у Зрізі 10. */
export function isQuietDay(config: AppConfig, producedIds: Set<string>): boolean {
  const mods = config.modules as Record<string, { enabled?: boolean }>;
  const active = config.quietDay.triggerOn.filter((t) => mods[t]?.enabled);
  if (active.length === 0) return false;
  return active.every((t) => !producedIds.has(t));
}

async function runPhase(
  modules: Module<AppConfig>[],
  ctx: Ctx<AppConfig>,
  blocks: Block[],
  producedIds: Set<string>,
): Promise<void> {
  const settled = await Promise.allSettled(modules.map((m) => m.run(ctx)));
  settled.forEach((r, i) => {
    const mod = modules[i]!;
    if (r.status === 'fulfilled') {
      if (r.value) {
        blocks.push(r.value);
        producedIds.add(mod.id);
      }
    } else {
      ctx.log.warn(`модуль ${mod.id} впав: ${String(r.reason).slice(0, 160)}`);
    }
  });
}

export async function runBriefing(deps: RunDeps, opts: RunOptions = {}): Promise<RunResult> {
  const { config, clock, state, log } = deps;
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  const lastSentDate = state.get<string>('lastSentDate') ?? null;
  const decision = sendGuard({
    sendHour: config.sendHour,
    sendWindowHours: config.sendWindowHours,
    clock,
    lastSentDate,
    force,
  });
  log.info(`[guard] send=${decision.send} :: ${decision.reason}`);

  if (!decision.send && !dryRun) {
    return { status: 'skipped', reason: decision.reason, messages: [], quiet: false };
  }

  const ctx: Ctx<AppConfig> = {
    clock,
    config,
    state,
    bus: deps.bus,
    llm: deps.llm,
    fetcher: deps.fetcher,
    log,
  };

  const enabled = deps.modules.filter((m) => m.enabled(config));
  const { producers, consumers } = partitionModules(enabled);

  const blocks: Block[] = [];
  const producedIds = new Set<string>();
  await runPhase(producers, ctx, blocks, producedIds); // Фаза 1
  await runPhase(consumers, ctx, blocks, producedIds); // Фаза 2

  // Неділя — ніколи не «тихий день»: weekly-review показується повністю (§4.1 п.5).
  const quiet = isQuietDay(config, producedIds) && !clock.isSunday();
  const header = formatKyivDateHeader(clock.now());
  const messages = renderBriefing(blocks, {
    maxChars: config.telegram.maxMessageChars,
    header,
    quiet,
  });

  if (dryRun) {
    return { status: 'dry-run', reason: decision.reason, messages, quiet };
  }

  if (!deps.notifier) {
    throw new Error('Notifier відсутній у бойовому прогоні (немає критичних секретів)');
  }

  await deps.notifier.send(messages);
  // at-least-once: send пройшов -> фіксуємо стан (§4.2).
  state.set('lastSentDate', clock.todayKey());
  state.prune();
  await state.flush();
  log.info(`брифінг надіслано (${messages.length} повідомл.), стан оновлено`);

  return { status: 'sent', reason: decision.reason, messages, quiet };
}

/** Зібрати всі модулі MVP. Нові додаються тут (consumer-и після producer-ів). */
function buildModules(): Module<AppConfig>[] {
  return [
    createWeatherModule(),
    createCalendarModule(),
    todayModule,
    stoicModule,
    newsModule,
    nextStepModule,
    weeklyReviewModule,
  ];
}

/** Хости allowlist для SourceFetcher — з config.modules.news.sources (§8). */
function newsAllowlist(config: AppConfig): string[] {
  const hosts = new Set<string>();
  for (const urls of Object.values(config.modules.news.sources)) {
    for (const url of urls) {
      try {
        hosts.add(new URL(url).hostname.toLowerCase());
      } catch {
        /* ігноруємо невалідний source URL */
      }
    }
  }
  return [...hosts];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const config = loadConfig();
  const clock = createClock();
  const log = createLogger();

  let secrets: { botToken: string; chatId: string } | null = null;
  try {
    secrets = requireCriticalSecrets();
  } catch (e) {
    if (e instanceof MissingSecretsError && dryRun) {
      log.warn(`${e.message} — dry-run без відправки`);
    } else {
      // Видимий failed-ран замість тиші (§4.1 п.0, §19.12).
      log.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
      return;
    }
  }

  // STATE_FILE -> стан із окремої гілки `state` у CI (§4.3); локально — state.json.
  const state = createStateStore({
    path: process.env.STATE_FILE ?? 'state.json',
    log,
    pruners: buildPruners(config, clock.now().getTime()),
  });
  const notifier = secrets
    ? createNotifier({ token: secrets.botToken, chatId: secrets.chatId, log })
    : null;

  const deps: RunDeps = {
    config,
    clock,
    state,
    bus: createRunBus(),
    llm: createLLMClient({
      model: config.llm.model,
      defaultTimeoutMs: config.llm.timeoutMs,
      maxCallsPerRun: config.llm.maxCallsPerRun,
      log,
    }),
    fetcher: createFetcher({
      allowlist: newsAllowlist(config),
      timeoutMs: config.fetch.timeoutMs,
      retries: config.fetch.retries,
      log,
    }),
    log,
    modules: buildModules(),
    notifier,
  };

  try {
    const result = await runBriefing(deps, { dryRun, force });
    if (result.status === 'dry-run') {
      log.info(`--- DRY RUN (${result.messages.length} повідомл., quiet=${result.quiet}) ---`);
      result.messages.forEach((m, i) => console.log(`\n[повідомлення ${i + 1}]\n${m}`));
    }
  } catch (e) {
    log.error(`оркестратор впав: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    await failNotify(e, log);
    process.exitCode = 1;
  }
}

/** Top-level fail-notify напряму через bot token (§4.1). */
async function failNotify(error: unknown, log: Logger): Promise<void> {
  const token = optionalSecret('TELEGRAM_BOT_TOKEN');
  const chatId = optionalSecret('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    log.error('fail-notify неможливий: немає TELEGRAM_BOT_TOKEN/CHAT_ID');
    return;
  }
  try {
    const notifier = createNotifier({ token, chatId, log });
    const msg = error instanceof Error ? error.message : String(error);
    await notifier.failNotify(`⚠️ Svitanok: брифінг впав — ${msg}`);
  } catch (e) {
    log.error(`fail-notify не вдався: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Запуск лише як CLI (не під час імпорту в тестах). pathToFileURL — крос-платформно.
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  void main();
}
