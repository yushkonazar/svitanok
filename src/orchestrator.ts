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
import {
  createKvStateStore,
  readKvEnv,
  readKvJson,
  writeKvJson,
  type KvStateOptions,
} from './core/state-kv.js';
import {
  applyModuleOverrides,
  applyTopicMutes,
  applyOwnerGeo,
  formatOverrides,
} from './core/settings-overrides.js';
import { createRunBus } from './core/bus.js';
import { createLLMClient, formatLlmDegradedMessage } from './core/llm.js';
import { createFetcher } from './core/fetcher.js';
import {
  createNotifier,
  buildProposalCallbackData,
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
import { BRIEFING_FEEDBACK_KEY, briefingBlockPreference } from '../web/core/brief/feedback.mjs';
import {
  buildDecisionBrief,
  buildDecisionSummaryPrompt,
  formatDecisionHeadline,
  parseDecisionAiSummary,
  type ReminderSnapshotForDecision,
} from './core/decision-brief.js';
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
import { createWeatherModule, signed, type WeatherToday } from './modules/weather.js';
import {
  createCalendarModule,
  CALENDAR_BUS_KEY,
  CALENDAR_SNAPSHOT_KEY,
  type CalendarEvent,
  type CalendarSnapshot,
} from './modules/calendar.js';
import { stoicModule } from './modules/stoic.js';
import { createNewsModule } from './modules/news.js';
import { jobsModule } from './modules/jobs.js';
import { factModule } from './modules/fact.js';
import { mockModule } from './modules/mock.js';
import { weeklyReviewModule } from './modules/weekly-review.js';
import { createCurrencyModule } from './modules/currency.js';
import { createOnThisDayModule } from './modules/onthisday.js';
import {
  createMailModule,
  MAIL_PROPOSAL_BUS_KEY,
  MAIL_TRIAGE_KEY,
  formatMailProposalMessage,
  pluralizeLysty,
  type MailProposalItem,
  type MailTriageState,
} from './modules/mail.js';
import { buildPruners } from './core/prune.js';

export interface RunOptions {
  dryRun?: boolean;
  /** Обійти лише годинне вікно; ідемпотентність за добу лишається (B2). */
  forceWindow?: boolean;
  /** Обійти і вікно, і ідемпотентність — перезаписує сьогоднішній брифінг. */
  forceSend?: boolean;
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
  // CF-креденшели для ПРЯМОГО KV-запису assistantPending (окремий ключ, не
  // блоб `state` — Worker читає лише його, H2-гонку з наївними писарями
  // блоба інакше не закрити per-key-мержем: цей запис трапляється РАЗ на
  // добу, поза звичайним flush-циклом стану). null -> локальний файловий
  // стан (dev/тести) — пропозиція листа просто не отримує кнопок ✅/❌ (Worker
  // однаково читає лише прод-KV, писати в локальний файл нема сенсу).
  kvEnv: KvStateOptions | null;
}

export type RunStatus = 'sent' | 'skipped' | 'dry-run';

export interface RunResult {
  status: RunStatus;
  reason: string;
  messages: string[]; // текст того, що йде в чат ([header] або [header, weekly] у неділю) — не блоки
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
  const forceWindow = opts.forceWindow ?? false;
  const forceSend = opts.forceSend ?? false;

  const lastSentDate = state.get<string>('lastSentDate') ?? null;
  const decision = sendGuard({
    sendHour: config.sendHour,
    sendWindowHours: config.sendWindowHours,
    clock,
    lastSentDate,
    forceWindow,
    forceSend,
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

  // Feedback діє лише на presentation повного briefing-а, а не на producer-и:
  // прихована «Погода» все одно має дати critical weather signal, прихований
  // «Календар» — перевірку перетинів. Інакше preference могла б тихо
  // вимкнути safety/decision layer замість одного інформаційного блока.
  const briefingFeedback = state.get<unknown>(BRIEFING_FEEDBACK_KEY);
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

  // Короткий рядок дня + детермінований decision layer: погода (перша
  // локація), календарний snapshot, D1/KV snapshot нагадувань і mail-triage
  // вже прораховані. Кожен сегмент опційний: застарілий/відсутній snapshot
  // не стає вигаданим фактом у повідомленні.
  // blockData — одна точка небезпечного каста Block.data (тип навмисно
  // unknown, §core/types.ts) замість дубльованого inline-каста на кожен блок.
  const blockData = <T>(id: string): T | undefined =>
    blocks.find((b) => b.id === id)?.data as T | undefined;
  const weatherLoc = blockData<{ locations?: WeatherToday[] }>('weather')?.locations?.[0];
  const firstEvent = ctx.bus.get<CalendarEvent[]>(CALENDAR_BUS_KEY)?.[0];
  const mailCount = blockData<{ count?: number }>('mail')?.count;
  const generatedAt = clock.now().toISOString();
  const deterministicDecision = buildDecisionBrief({
    todayKey: clock.todayKey(),
    generatedAt,
    calendar: state.get<CalendarSnapshot>(CALENDAR_SNAPSHOT_KEY),
    reminders: state.get<ReminderSnapshotForDecision>('remindersToday'),
    mail: state.get<MailTriageState>(MAIL_TRIAGE_KEY),
    weather: weatherLoc,
  });
  // LLM є лише надбудовою над уже зафіксованими фактами: вона отримує
  // обмежений список signal IDs і може дати короткий порядок/виклад. Помилка
  // або малформат не змінюють ані Telegram headline, ані детерміновані дані.
  let decisionBrief = deterministicDecision;
  if (deterministicDecision.signals.length > 0) {
    try {
      const aiText = await ctx.llm.complete(buildDecisionSummaryPrompt(deterministicDecision), {
        maxTokens: 180,
        timeoutMs: ctx.config.llm.timeoutMs,
        tag: 'decision-summary',
      });
      const ai = parseDecisionAiSummary(aiText, deterministicDecision.signals);
      if (ai) decisionBrief = { ...deterministicDecision, ai };
      else ctx.log.warn('decision-summary: LLM повернула невалідний strict JSON — пропущено');
    } catch (error) {
      ctx.log.warn(
        `decision-summary: необов'язкове ранжування пропущено: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const visibleBlocks = blocks
    .filter((block) => briefingBlockPreference(briefingFeedback, block.id) !== 'hidden')
    .map((block) => ({
      ...block,
      // «Менше такого» не змінює правдивість даних і не додає випадкову
      // частоту: блок лишається доступним, але стабільно опускається нижче.
      priority:
        block.priority + (briefingBlockPreference(briefingFeedback, block.id) === 'less' ? 100 : 0),
    }));
  const briefing = buildBriefingData(
    visibleBlocks,
    formatKyivDateLabel(clock.now()),
    generatedAt,
    decisionBrief,
  );
  const decisionHeadline = formatDecisionHeadline(decisionBrief);
  const summaryLine = joinSummarySegments([
    weatherLoc
      ? `${weatherLoc.emoji} ${escapeHtml(weatherLoc.name)} ${signed(weatherLoc.tempC)}`
      : null,
    firstEvent
      ? `📅 ${firstEvent.time ? `${firstEvent.time} ` : ''}${escapeHtml(firstEvent.title)}`
      : null,
    typeof mailCount === 'number' && mailCount > 0
      ? `📧 ${mailCount} ${pluralizeLysty(mailCount)}`
      : null,
  ]);
  const headerFull = [header, decisionHeadline, summaryLine].filter(Boolean).join('\n');

  // Щоденне сповіщення в чат: дата(+рядок дня), БЕЗ inline-кнопки апки (фідбек
  // власника, п.2) — постійний вхід у Mini App тепер ОКРЕМЕ закріплене вітальне
  // повідомлення (web/worker.js ensureAppWelcomePin, ставиться один раз через
  // /api/telegram/setup), а не щоденний inline-дубль під кожним брифінгом.
  // Усі блоки — лише в briefing.json, дашборд лишається єдиним місцем
  // перегляду повного вмісту. У неділю додається окреме недільне повідомлення
  // (Фаза B5, нижче) — messages може містити 1 або 2 елементи. messages — те,
  // що РЕАЛЬНО йде в чат (і для sent, і для dry-run-превʼю).
  const dailyMessage: OutboundMessage = {
    text: headerFull,
  };
  // Фаза B5: недільний підсумок тижня — окреме HTML-повідомлення в ТУ САМУ
  // тему (topicBriefing), одразу після щоденного. weekly-review вже в blocks
  // (Фаза 2, лише в неділю) — просто читаємо його data, без нового I/O.
  const weeklyData = clock.isSunday() ? blockData<WeeklyReviewData>('weekly-review') : undefined;
  const weeklyMessage: OutboundMessage | undefined = weeklyData
    ? { text: formatWeeklyReviewMessage(weeklyData) }
    : undefined;
  const toSend: OutboundMessage[] = weeklyMessage ? [dailyMessage, weeklyMessage] : [dailyMessage];
  const messages = toSend.map((m) => m.text);

  if (dryRun) {
    return { status: 'dry-run', reason: decision.reason, messages, quiet, briefing };
  }

  if (!deps.notifier) {
    throw new Error('Notifier відсутній у бойовому прогоні (немає критичних секретів)');
  }

  // Щоденне — критичне: провал кидає далі й блокує lastSentDate (§4.2, нижче).
  // Недільний підсумок шлемо ОКРЕМИМ send() best-effort — його провал (напр.
  // транзиєнтна HTTP-помилка чи задовгий текст) не має ретригерити повторну
  // відправку вже доставленого щоденного повідомлення при наступному запуску.
  await deps.notifier.send([dailyMessage]);

  if (weeklyMessage) {
    try {
      await deps.notifier.send([weeklyMessage]);
    } catch (e) {
      log.warn(
        `weekly-review: недільний підсумок не надіслано: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Запрошення на співбесіду, детектовані mail.ts (Блок P2c) — proposeCalendarChanges-
  // подібна пропозиція (той самий формат `assistantPending`, що агент P2b пише
  // з Worker-боку у ВЛАСНИЙ KV-ключ, не блоб `state` — резолвиться незалежно
  // від того, ХТО записав, web/worker.js resolveProposalCallback). Прямий
  // writeKvJson (не state.set) — ключ ОКРЕМИЙ від state, і Worker читає ЛИШЕ
  // прод-KV, тож без kvEnv (локальний файловий стан) писати нема куди. Запис —
  // ЛИШЕ після успішного send (не лишати «мертву» пропозицію без видимих кнопок).
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
      if (deps.kvEnv) {
        await writeKvJson(deps.kvEnv, 'assistantPending', {
          id: proposalId,
          items: proposal.items,
          createdMs: clock.now().getTime(),
        });
      }
    } catch (e) {
      log.warn(
        `mail: пропозицію співбесіди не надіслано: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Публічна мітка «живий сервіс» (GET /api/status на воркері) — ОКРЕМИЙ
  // KV-ключ, свідомо не поле в блобі `state`.
  //
  // ⚠️ ПІСЛЯ send, не до. Ендпоінт відповідає на питання «коли востаннє
  // приходив брифінг»; запис до відправки означав би, що він звітує про
  // брифінг, якого не було — а зовнішній бейдж саме на цьому й будує «сервіс
  // живий». Тут ми вже за успішним `notifier.send([dailyMessage])`, який на
  // провалі кидає далі й сюди не пускає.
  //
  // Окремий ключ, а не `state`, — бо ендпоінт ПУБЛІЧНИЙ: у блобі лежать
  // нагадування, прогрес роадмепу й стан асистента, і читати його заради
  // одного поля означало б тримати весь приватний стан за один баг від
  // публічної відповіді. Той самий прийом, що з `assistantPending` вище.
  if (deps.kvEnv) {
    await writeKvJson(deps.kvEnv, 'publicStatus', {
      lastBriefingAt: clock.now().toISOString(),
    });
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
    weeklyReviewModule,
  ];
}

/** Накласти тумблери Mini App на конфіг + залогувати, що саме змінилось (F2). */
function applyModuleOverridesFromKv(
  config: AppConfig,
  settings: Record<string, unknown> | null,
  log: Logger,
): AppConfig {
  const { config: next, changes } = applyModuleOverrides(config, settings);
  if (changes.length > 0) log.info(`налаштування Mini App: ${formatOverrides(changes)}`);
  // Приглушені теми ріжемо ТУТ, до прогону: кожна тема — окремий кредит NewsData,
  // тож клієнтський фільтр витрачав би їх намарно.
  const { config: pruned, muted } = applyTopicMutes(next, settings);
  if (muted.length > 0) log.info(`теми новин приглушено: ${muted.join(', ')}`);
  return pruned;
}

/**
 * Накласти геопозицію власника з KV на config.locations.
 *
 * Два ключі, два читання: `ownerGeoManual` (ручний вибір/пошук міста, несе
 * підтверджену назву) має пріоритет над `ownerGeo` (авто-детекція). Той самий
 * порядок, що в Mini App — інакше два екрани показували б різні міста одного
 * ранку.
 */
async function applyOwnerGeoFromKv(
  config: AppConfig,
  kv: KvStateOptions,
  log: Logger,
): Promise<AppConfig> {
  const [manual, auto] = await Promise.all([
    readKvJson(kv, 'ownerGeoManual'),
    readKvJson(kv, 'ownerGeo'),
  ]);
  const { config: next, source, name } = applyOwnerGeo(config, manual, auto);
  if (source) log.info(`локація з Mini App (${source}): ${name}`);
  return next;
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
  // --force-window: «хочу зараз, поза вікном» (ідемпотентність діє — саме вона
  // не дає повторному прогону перезаписати сьогоднішній брифінг майже порожнім).
  // --force-send: повний обхід, свідомий перезапис; лише ручний запуск людиною.
  const forceWindow = args.includes('--force-window');
  const forceSend = args.includes('--force-send') || args.includes('--force');

  const configYml = loadConfig();
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

  const kvEnv = readKvEnv();

  // F2: тумблери модулів із Mini App живуть у KV `settings` (пише Worker). Без
  // цього оверрайду перемикач у налаштуваннях нічого б не змінював: config.yml —
  // файл репозиторію, і ран у GitHub Actions про натискання не знає. Читання
  // best-effort: немає KV / немає ключа / збій -> дефолти config.yml.
  const withToggles = kvEnv
    ? applyModuleOverridesFromKv(configYml, await readKvJson({ ...kvEnv, log }, 'settings'), log)
    : configYml;

  // Геопозиція власника з Mini App (22.08): три способи вказати локацію —
  // авто-детекція, ручний вибір, пошук міста — писали в KV, але до брифінгу не
  // доходили, бо ран у Actions не має ні браузера, ні `request.cf`. Читання
  // best-effort і в тому самому стилі, що тумблери вище: немає KV / немає
  // ключа / збій -> лишається config.yml.
  const config = kvEnv
    ? await applyOwnerGeoFromKv(withToggles, { ...kvEnv, log }, log)
    : withToggles;

  // Стан: KV (CF env присутні — CI/прод) або файл (локально). KV прибирає крихку
  // git-гілку `state`. Асинхронне завантаження блоба перед реєстрацією модулів.
  const pruners = buildPruners(config, clock.now().getTime());
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

  // Клієнт памʼятає впалі виклики (A3) — після рану один раз попереджаємо в
  // «⚠️ Система», інакше деградований брифінг виглядає як нормальний.
  const llm = createLLMClient({
    model: config.llm.model,
    defaultTimeoutMs: config.llm.timeoutMs,
    maxCallsPerRun: config.llm.maxCallsPerRun,
    log,
  });

  const deps: RunDeps = {
    config,
    clock,
    state,
    bus: createRunBus(),
    llm,
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
    kvEnv: kvEnv ? { ...kvEnv, log } : null,
  };

  try {
    const result = await runBriefing(deps, { dryRun, forceWindow, forceSend });
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
    await systemNotify(
      `⚠️ Svitanok: брифінг впав — ${e instanceof Error ? e.message : String(e)}`,
      log,
      topicSystem,
    );
    process.exitCode = 1;
    return;
  }

  // A3: ран вижив, але LLM падав -> брифінг тихо деградований (jobs без скорингу,
  // fact/mock без блоку). Один плейн-текст у «⚠️ Система» — best-effort, ніколи
  // не валить уже успішний ран. У dry-run у чат не пишемо (лише в лог).
  const degraded = formatLlmDegradedMessage(llm.failures());
  if (degraded) {
    log.warn(degraded.split('\n')[0] ?? 'LLM деградація');
    if (!dryRun) await systemNotify(degraded, log, topicSystem);
  }
}

/** Плейн-текст напряму через bot token (§4.1): top-level fail-notify і
 *  попередження про деградацію (A3). threadId — тема «⚠️ Система»
 *  (TOPIC_SYSTEM), якщо задано; інакше unscoped/General. Ніколи не кидає. */
async function systemNotify(text: string, log: Logger, threadId?: string): Promise<void> {
  const token = optionalSecret('TELEGRAM_BOT_TOKEN');
  const chatId = optionalSecret('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    log.error('system-notify неможливий: немає TELEGRAM_BOT_TOKEN/CHAT_ID');
    return;
  }
  try {
    const notifier = createNotifier({ token, chatId, threadId, log });
    await notifier.failNotify(text);
  } catch (e) {
    log.error(`system-notify не вдався: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Запуск лише як CLI (не під час імпорту в тестах). pathToFileURL — крос-платформно.
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  void main();
}
