// Оркестратор (§4.1): рання валідація секретів -> guard -> producers ->
// consumers -> render -> send -> set lastSentDate -> flush. Один впалий модуль не
// валить брифінг (allSettled). Семантика at-least-once: send -> set -> flush;
// git-коміт стану у гілку `state` робить brief.yml (§4.3).
//
// runBriefing виділено для тестів (інжектовані залежності); main() зшиває реальні.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './core/config.js';
import { createClock, type Clock } from './core/clock.js';
import { createLogger } from './core/logger.js';
import { createStateStore } from './core/state.js';
import { createKvStateStore, readKvEnv } from './core/state-kv.js';
import { createRunBus } from './core/bus.js';
import { createLLMClient } from './core/llm.js';
import { createFetcher } from './core/fetcher.js';
import {
  createNotifier,
  buildProposalCallbackData,
  buildMiniAppButton,
  escapeHtml,
  type Notifier,
  type OutboundMessage,
} from './core/telegram.js';
import {
  formatKyivDateHeader,
  formatKyivDateLabel,
  joinSummarySegments,
  formatWeeklyReviewMessage,
  type WeeklyReviewData,
} from './core/render.js';
import { buildBriefingData, type BriefingData } from './core/briefing.js';
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
import { createWeatherModule, type WeatherToday } from './modules/weather.js';
import { createCalendarModule, CALENDAR_BUS_KEY, type CalendarEvent } from './modules/calendar.js';
import { stoicModule } from './modules/stoic.js';
import { createNewsModule } from './modules/news.js';
import { jobsModule } from './modules/jobs.js';
import { factModule } from './modules/fact.js';
import { mockModule } from './modules/mock.js';
import { nextStepModule } from './modules/next-step.js';
import { weeklyReviewModule } from './modules/weekly-review.js';
import { createCurrencyModule } from './modules/currency.js';
import { createOnThisDayModule } from './modules/onthisday.js';
import {
  createMailModule,
  MAIL_PROPOSAL_BUS_KEY,
  formatMailProposalMessage,
  pluralizeLysty,
  type MailProposalItem,
} from './modules/mail.js';
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
  // Другий Notifier, зіскопований на TOPIC_ASSISTANT (Блок P2c) — для
  // проактивних пропозицій (mail.ts's MAIL_PROPOSAL_BUS_KEY), окремо від
  // основного брифінгу (TOPIC_BRIEFING). null -> TOPIC_ASSISTANT не задано
  // (DM/без тем) чи немає критичних секретів — пропозиція просто не шлеться.
  assistantNotifier: Notifier | null;
  // chat_id, куди йде сповіщення — фолбек-логіка кнопки Mini App, коли
  // botUsername не задано (web_app лише в приватних чатах, url у групі;
  // §core/telegram.ts buildMiniAppButton). null -> трактується як приватний чат.
  chatId?: string | null;
  // Username бота (без "@") -> Direct Link Mini App (t.me/<username>?startapp),
  // працює з initData і в групі, і в приватному чаті. Потребує одноразового
  // owner-кроку в @BotFather (Configure Mini App, .env.example). Не задано ->
  // фолбек за chatId (стара поведінка).
  botUsername?: string | null;
  // URL Mini App для кнопки в щоденному сповіщенні. null -> сповіщення йде
  // лише з датою, без кнопки (graceful — не блокує брифінг).
  miniAppUrl: string | null;
}

export type RunStatus = 'sent' | 'skipped' | 'dry-run';

export interface RunResult {
  status: RunStatus;
  reason: string;
  messages: string[]; // текст того, що йде в чат (тепер: [header]) — не блоки
  quiet: boolean;
  briefing: BriefingData; // дані для Mini App (briefing.json) — повний вміст блоків
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

  const emptyBriefing = buildBriefingData(
    [],
    formatKyivDateLabel(clock.now()),
    clock.now().toISOString(),
  );
  if (!decision.send && !dryRun) {
    return {
      status: 'skipped',
      reason: decision.reason,
      messages: [],
      quiet: false,
      briefing: emptyBriefing,
    };
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

  // quiet лишається метаданим (тестується напряму) — контент блоків більше не
  // йде в чат, тож на рендер сповіщення вже не впливає.
  const quiet = isQuietDay(config, producedIds) && !clock.isSunday();
  const header = formatKyivDateHeader(clock.now());
  const briefing = buildBriefingData(
    blocks,
    formatKyivDateLabel(clock.now()),
    clock.now().toISOString(),
  );

  // Короткий рядок дня (Фаза B3): погода (перша локація) + перша подія
  // календаря сьогодні + «N листів» — усі блоки вже прораховані (Фаза
  // producers+consumers вище), реордеринг не потрібен. Кожен сегмент
  // опційний (graceful — відсутній блок просто не додає сегмент).
  const weatherLoc = (
    blocks.find((b) => b.id === 'weather')?.data as { locations?: WeatherToday[] } | undefined
  )?.locations?.[0];
  const firstEvent = ctx.bus.get<CalendarEvent[]>(CALENDAR_BUS_KEY)?.[0];
  const mailCount = (blocks.find((b) => b.id === 'mail')?.data as { count?: number } | undefined)
    ?.count;
  const summaryLine = joinSummarySegments([
    weatherLoc
      ? `${weatherLoc.emoji} ${weatherLoc.name} ${weatherLoc.tempC > 0 ? '+' : ''}${weatherLoc.tempC}°`
      : null,
    firstEvent
      ? `📅 ${firstEvent.time ? `${firstEvent.time} ` : ''}${escapeHtml(firstEvent.title)}`
      : null,
    typeof mailCount === 'number' && mailCount > 0
      ? `📧 ${mailCount} ${pluralizeLysty(mailCount)}`
      : null,
  ]);
  const headerFull = summaryLine ? `${header}\n${summaryLine}` : header;

  // Єдине сповіщення в чат: дата(+рядок дня) + кнопка відкрити Mini App (усі
  // блоки — лише в briefing.json, дашборд лишається єдиним місцем перегляду
  // повного вмісту). messages — те, що РЕАЛЬНО йде в чат (і для sent, і для
  // dry-run-превʼю).
  const dailyMessage: OutboundMessage = {
    text: headerFull,
    ...(deps.miniAppUrl
      ? {
          buttons: [
            [
              buildMiniAppButton(
                '📊 Відкрити Mini App',
                deps.miniAppUrl,
                deps.chatId,
                deps.botUsername,
              ),
            ],
          ],
        }
      : {}),
  };
  // Фаза B5: недільний підсумок тижня — окреме HTML-повідомлення в ТУ САМУ
  // тему (topicBriefing), одразу після щоденного. weekly-review вже в blocks
  // (Фаза 2, лише в неділю) — просто читаємо його data, без нового I/O.
  const weeklyBlock = blocks.find((b) => b.id === 'weekly-review');
  const toSend: OutboundMessage[] = [dailyMessage];
  if (clock.isSunday() && weeklyBlock?.data) {
    toSend.push({ text: formatWeeklyReviewMessage(weeklyBlock.data as WeeklyReviewData) });
  }
  const messages = toSend.map((m) => m.text);

  if (dryRun) {
    return { status: 'dry-run', reason: decision.reason, messages, quiet, briefing };
  }

  if (!deps.notifier) {
    throw new Error('Notifier відсутній у бойовому прогоні (немає критичних секретів)');
  }

  await deps.notifier.send(toSend);

  // Запрошення на співбесіду, детектовані mail.ts (Блок P2c) — proposeCalendarChanges-
  // подібна пропозиція (той самий формат state.assistantPending, що агент P2b пише
  // з Worker-боку; resolveProposalCallback у web/worker.js резолвить її незалежно
  // від того, ХТО записав). state.set — ЛИШЕ після успішного send (не лишати
  // «мертву» пропозицію без видимих кнопок).
  const proposal = ctx.bus.get<{ items: MailProposalItem[] }>(MAIL_PROPOSAL_BUS_KEY);
  const proposalId = crypto.randomUUID().slice(0, 8);
  const acceptCb = buildProposalCallbackData('a', proposalId);
  const cancelCb = buildProposalCallbackData('c', proposalId);
  if (proposal && proposal.items.length > 0 && deps.assistantNotifier && acceptCb && cancelCb) {
    try {
      await deps.assistantNotifier.send([
        {
          text: formatMailProposalMessage(proposal.items),
          buttons: [
            [
              { text: '✅ Додати в календар', callback_data: acceptCb },
              { text: '❌ Ні', callback_data: cancelCb },
            ],
          ],
        },
      ]);
      state.set('assistantPending', {
        id: proposalId,
        items: proposal.items,
        createdMs: clock.now().getTime(),
      });
    } catch (e) {
      log.warn(
        `mail: пропозицію співбесіди не надіслано: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // at-least-once: send пройшов -> фіксуємо стан (§4.2).
  state.set('lastSentDate', clock.todayKey());
  state.prune();
  await state.flush();
  log.info(`брифінг надіслано (${messages.length} повідомл.), стан оновлено`);

  return { status: 'sent', reason: decision.reason, messages, quiet, briefing };
}

/** Зібрати всі модулі MVP. Нові додаються тут (consumer-и після producer-ів). */
function buildModules(): Module<AppConfig>[] {
  return [
    createWeatherModule(),
    createCalendarModule(),
    createMailModule(),
    stoicModule,
    factModule,
    createNewsModule(),
    jobsModule,
    mockModule,
    createCurrencyModule(),
    createOnThisDayModule(),
    nextStepModule,
    weeklyReviewModule,
  ];
}

/** Хости allowlist для SourceFetcher — з jobs.sources (§8). Новини тепер через
 *  фіксований NewsData API (прямий fetch, не allowlisted). */
function fetchAllowlist(config: AppConfig): string[] {
  const hosts = new Set<string>();
  const add = (url: string) => {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      /* ігноруємо невалідний source URL */
    }
  };
  config.modules.jobs.sources.forEach(add);
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

  // Стан: KV (CF env присутні — CI/прод) або файл (локально). KV прибирає крихку
  // git-гілку `state`. Асинхронне завантаження блоба перед реєстрацією модулів.
  const pruners = buildPruners(config, clock.now().getTime());
  const kvEnv = readKvEnv();
  const state = kvEnv
    ? await createKvStateStore({ ...kvEnv, log, pruners })
    : createStateStore({ path: process.env.STATE_FILE ?? 'state.json', log, pruners });
  // TOPIC_BRIEFING — опційний thread_id теми «☀️ Брифінг» forum-супергрупи
  // (Блок «Теми»). Не задано -> дефолтна тема/DM, як і зараз.
  const topicBriefing = optionalSecret('TOPIC_BRIEFING');
  const notifier = secrets
    ? createNotifier({
        token: secrets.botToken,
        chatId: secrets.chatId,
        threadId: topicBriefing,
        log,
      })
    : null;
  // TOPIC_ASSISTANT — та сама тема, куди Worker-агент (Блок P2b) шле пропозиції;
  // тут orchestrator (Блок P2c, mail.ts) шле СВОЇ (запрошення на співбесіду) тим
  // самим шляхом. Не задано -> пропозиція просто не надсилається (mail.ts і далі
  // рахує "N листів" у брифінг, лише без interactive-кнопок).
  const topicAssistant = optionalSecret('TOPIC_ASSISTANT');
  const assistantNotifier =
    secrets && topicAssistant
      ? createNotifier({
          token: secrets.botToken,
          chatId: secrets.chatId,
          threadId: topicAssistant,
          log,
        })
      : null;
  // TOPIC_SYSTEM — тема «⚠️ Система» (Фаза B): fail-notify (нижче) сюди замість
  // завжди-General. Не задано -> лишається стара поведінка (unscoped/General).
  const topicSystem = optionalSecret('TOPIC_SYSTEM');
  // MINI_APP_URL — origin розгорнутого Worker/Mini App (напр. https://svitanok.
  // <акаунт>.workers.dev), для кнопки в щоденному сповіщенні. Не задано ->
  // сповіщення йде без кнопки (graceful, не блокує брифінг).
  const miniAppUrl = optionalSecret('MINI_APP_URL') ?? null;
  // TELEGRAM_BOT_USERNAME — Direct Link Mini App (t.me/<username>?startapp),
  // зберігає initData з групи (.env.example). Не задано -> фолбек за chatId.
  const botUsername = optionalSecret('TELEGRAM_BOT_USERNAME') ?? null;

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
      allowlist: fetchAllowlist(config),
      timeoutMs: config.fetch.timeoutMs,
      retries: config.fetch.retries,
      log,
    }),
    log,
    modules: buildModules(),
    notifier,
    assistantNotifier,
    chatId: secrets?.chatId ?? null,
    botUsername,
    miniAppUrl,
  };

  try {
    const result = await runBriefing(deps, { dryRun, force });
    // briefing.json для Mini App (публікує brief.yml у гілку дашборда).
    const briefingFile = process.env.BRIEFING_FILE;
    if (briefingFile && result.status !== 'skipped') {
      writeFileSync(briefingFile, JSON.stringify(result.briefing, null, 2));
      log.info(`briefing.json записано: ${briefingFile}`);
    }
    if (result.status === 'dry-run') {
      log.info(`--- DRY RUN (${result.briefing.blocks.length} блоків, quiet=${result.quiet}) ---`);
      // Повний вміст блоків — лише для локальної перевірки (у чат тепер не йде).
      result.briefing.blocks.forEach((b) =>
        console.log(`\n[${b.icon ?? ''} ${b.title}]\n${b.summary}`),
      );
      console.log(`\n[повідомлення в чат]\n${result.messages.join('\n')}`);
    }
  } catch (e) {
    log.error(`оркестратор впав: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    await failNotify(e, log, topicSystem);
    process.exitCode = 1;
  }
}

/** Top-level fail-notify напряму через bot token (§4.1). threadId — тема
 *  «⚠️ Система» (TOPIC_SYSTEM), якщо задано; інакше unscoped/General. */
async function failNotify(error: unknown, log: Logger, threadId?: string): Promise<void> {
  const token = optionalSecret('TELEGRAM_BOT_TOKEN');
  const chatId = optionalSecret('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    log.error('fail-notify неможливий: немає TELEGRAM_BOT_TOKEN/CHAT_ID');
    return;
  }
  try {
    const notifier = createNotifier({ token, chatId, threadId, log });
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
