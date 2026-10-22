import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { assistantHomeTarget } from './core/tg/home.mjs';
import { chainTarget } from './core/chains/state.mjs';
import { readTripBrief, runTripBrief, normalizeTripAnswers } from './core/tools/trip.mjs';
import { runTripWorkspace, tripWorkspaceView } from './core/tools/trip-workspace.mjs';
import { runTripExpense, tripExpenseSummary } from './core/tools/trip-expenses.mjs';
import { runTripOptions, tripResearchView } from './core/trips/options.mjs';
import { companionView, tripOfflinePack } from './core/trips/companion.mjs';
import { startTripChain, cancelTripChain } from './core/chains/trip.mjs';

/** Scope comes from authenticated stored records; client cannot nominate a foreign chat.
 * @param {Env} env @param {unknown} chat */
function allowedChat(env, chat) {
  return [env.TELEGRAM_OWNER_USER_ID, env.TELEGRAM_CHAT_ID]
    .filter(Boolean)
    .some((id) => String(id) === String(chat));
}
/** @param {Env} env @param {any} row */
function context(env, row) {
  const state = row.state_json ? JSON.parse(String(row.state_json)) : null;
  const target = state
    ? chainTarget(env, state)
    : {
        chatId: String(row.scope_key).split(':')[0],
        threadId: String(row.scope_key).split(':')[1] || null,
      };
  if (!allowedChat(env, target.chatId)) throw new Error('Ця поїздка недоступна.');
  return target;
}
/** @param {Env} env @param {string|null} selectedId @param {number} nowMs */
export async function readTravelWorkspace(env, selectedId = null, nowMs = Date.now()) {
  if (!env.DB) throw new Error('Сховище подорожей недоступне.');
  const [draftRows, tripRows] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM trip_briefs WHERE status IN ('draft','paused','started') ORDER BY updated_at DESC LIMIT 200",
    )
      .bind()
      .all(),
    env.DB.prepare(
      "SELECT t.*,c.state_json,c.status AS chain_status FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE c.kind='trip' ORDER BY t.date_from DESC LIMIT 200",
    )
      .bind()
      .all(),
  ]);
  const drafts = (draftRows.results ?? []).filter((row) =>
    allowedChat(env, String(row.scope_key).split(':')[0]),
  );
  const trips = (tripRows.results ?? []).filter((row) => {
    try {
      return allowedChat(env, chainTarget(env, JSON.parse(String(row.state_json))).chatId);
    } catch {
      return false;
    }
  });
  const summaries = [
    ...trips.map((row) => ({
      id: String(row.id),
      kind: 'trip',
      title: String(row.to_text),
      date_from: row.date_from,
      date_to: row.date_to,
      status: row.status,
    })),
    ...drafts
      .filter((row) => !trips.some((t) => JSON.parse(String(t.state_json)).brief_id === row.id))
      .map((row) => {
        const a = JSON.parse(String(row.answers_json));
        return {
          id: String(row.id),
          kind: 'draft',
          title: a.to ?? 'Нова поїздка',
          date_from: a.date_from ?? null,
          date_to: a.date_to ?? null,
          status: row.status,
        };
      }),
  ];
  const selected =
    selectedId ??
    summaries.find((s) => s.status === 'active')?.id ??
    summaries.find((s) => s.status === 'draft')?.id ??
    summaries[0]?.id;
  const draft = drafts.find((row) => row.id === selected),
    trip = trips.find((row) => row.id === selected);
  if (selectedId && !draft && !trip) throw new Error('Поїздку не знайдено. Онови список.');
  let current = null;
  if (draft) {
    const brief = await readTripBrief(env, context(env, draft), nowMs, String(draft.id));
    if (brief)
      current = {
        id: String(draft.id),
        kind: 'draft',
        ...brief,
        research: tripResearchView(brief.answers, nowMs),
      };
  }
  if (trip) {
    const state = JSON.parse(String(trip.state_json)),
      costs = JSON.parse(String(trip.cost_json ?? '{}'));
    const brief = state.brief_id
      ? await readTripBrief(env, context(env, trip), nowMs, state.brief_id)
      : null;
    current = {
      id: String(trip.id),
      kind: 'trip',
      status: trip.status,
      chain_status: trip.chain_status,
      brief_id: state.brief_id ?? null,
      answers: {
        ...normalizeTripAnswers(brief?.answers ?? state.preferences),
        to: trip.to_text,
        from_city: trip.from_city,
        date_from: trip.date_from,
        date_to: trip.date_to,
        mode: trip.mode,
        participants: state.participants,
        purpose: state.purpose,
      },
      workspace: tripWorkspaceView(costs),
      companion: companionView(state, costs.travel ?? {}, nowMs),
      ledger: tripExpenseSummary(trip.cost_json),
      research: brief ? tripResearchView(brief.answers, nowMs) : null,
    };
  }
  return {
    items: summaries,
    current,
    capabilities: { weather: Boolean(env.WEATHER_API_KEY && env.WEATHER_QUOTA) },
  };
}

/** @param {Request} request @param {Env} env */
export async function handleTrips(request, env) {
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const r = json(body, status);
    r.headers.set('cache-control', 'private, no-store');
    return r;
  };
  if (!['GET', 'POST'].includes(request.method))
    return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const parsed = request.method === 'POST' ? await readJsonBody(request) : null;
  if (parsed && !parsed.ok) return reply({ ok: false, error: parsed.error }, parsed.status);
  const body = parsed?.ok ? parsed.body : null;
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  let acknowledged = false,
    receipt = null;
  try {
    if (!env.DB) throw new Error('Сховище подорожей недоступне.');
    const nowMs = Date.now(),
      url = new URL(request.url);
    let selectedId = body?.id ?? url.searchParams.get('id');
    if (
      selectedId != null &&
      (typeof selectedId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(selectedId))
    )
      throw new Error('Обери поїздку зі списку.');
    if (
      body &&
      (typeof body.op !== 'string' ||
        (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data))) ||
        (body.revision != null && (!Number.isInteger(body.revision) || body.revision < 0)))
    )
      throw new Error('Перевір параметри зміни.');
    if (request.method === 'GET' && url.searchParams.get('format') === 'md') {
      const row = await env.DB.prepare(
        "SELECT t.*,c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.id=? AND c.kind='trip'",
      )
        .bind(selectedId)
        .first();
      if (!row) throw new Error('Збережений план не знайдено.');
      context(env, row);
      return new Response(
        tripOfflinePack(
          JSON.parse(String(row.state_json)),
          JSON.parse(String(row.cost_json ?? '{}')),
        ),
        {
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            'content-disposition': 'attachment; filename="travel-plan.md"',
            'cache-control': 'private, no-store',
          },
        },
      );
    }
    if (body) {
      if (JSON.stringify(body).length > 40_000) throw new Error('У запиті забагато даних.');
      const op = String(body.op),
        data = body.data ?? {};
      if (op === 'brief') {
        const row = selectedId
          ? await env.DB.prepare('SELECT * FROM trip_briefs WHERE id=?').bind(selectedId).first()
          : null;
        if (selectedId && !row) throw new Error('Чернетку не знайдено.');
        const ctx = row ? context(env, row) : assistantHomeTarget(env);
        if (!ctx) throw new Error('Особистий чат ще не налаштований.');
        const out = await runTripBrief(
          env,
          {
            ...(selectedId ? { draft_id: String(selectedId) } : { restart: true }),
            answers: data,
            expected_revision: body.revision,
            skip_field: body.skip_field,
          },
          nowMs,
          ctx,
        );
        receipt = out.result;
        selectedId = receipt.draft_id;
      } else if (op === 'select' || op === 'start' || op === 'research') {
        let row = await env.DB.prepare('SELECT * FROM trip_briefs WHERE id=?')
          .bind(selectedId)
          .first();
        if (!row && op !== 'start') {
          const trip = await env.DB.prepare(
            "SELECT t.*,c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.id=? AND c.kind='trip'",
          )
            .bind(selectedId)
            .first();
          if (trip) {
            context(env, trip);
            const state = JSON.parse(String(trip.state_json));
            if (state.brief_id)
              row = await env.DB.prepare('SELECT * FROM trip_briefs WHERE id=?')
                .bind(state.brief_id)
                .first();
          }
        }
        if (!row) throw new Error('Чернетку не знайдено.');
        const ctx = context(env, row),
          a = JSON.parse(String(row.answers_json));
        if (op === 'select')
          receipt = (
            await runTripOptions(
              env,
              {
                draft_id: String(row.id),
                op: 'select',
                option_id: data.option_id,
                expected_revision: body.revision,
              },
              nowMs,
              ctx,
            )
          ).result;
        if (op === 'start') {
          if (data.consent !== true) throw new Error('Обери, чи потрібен супровід.');
          const prior = await env.DB.prepare(
            "SELECT t.id,t.workflow_id FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.status='active' AND json_extract(c.state_json,'$.brief_id')=? AND CAST(json_extract(c.state_json,'$.chat_id') AS TEXT)=?",
          )
            .bind(row.id, String(ctx.chatId))
            .first();
          if (prior) {
            selectedId = prior.id;
            receipt = { trip_id: prior.id, already_started: true };
          } else {
            if (data.support_level != null) {
              if (!['reminders', 'companion'].includes(data.support_level))
                throw new Error('Обери режим супроводу.');
              await runTripBrief(
                env,
                {
                  draft_id: String(selectedId),
                  expected_revision: body.revision,
                  answers: { support_level: data.support_level },
                },
                nowMs,
                ctx,
              );
              a.support_level = data.support_level;
            }
            receipt = (
              await startTripChain(
                env,
                { ...normalizeTripAnswers(a), brief_id: selectedId },
                nowMs,
                ctx,
              )
            ).result;
            selectedId = receipt.trip_id;
          }
        }
        if (op === 'research') {
          const brief = await readTripBrief(env, ctx, nowMs, String(row.id));
          if (!brief?.ready_for_research)
            throw new Error('Спочатку додай місто, дати, транспорт і учасників.');
          const { startOrQueueThreadText } = await import('./core/prerouter.mjs');
          const prompt = `Підбери варіанти цієї поїздки. Прочитай trip.inspect з draft_id=${row.id}. Використай Дослідника з format=trip-options для житла, квитків, правил і місць; Планувальника для узгодження маршруту. Збережи перевірені пропозиції через trip.options op=save за точним basis брифу. Не запускай супровід, не бронюй і не змінюй відповіді власника. Після пошуку поверни наступне питання або кнопки вибору.`;
          const runId = await startOrQueueThreadText(
            env,
            {
              chatId: Number(ctx.chatId),
              threadId: ctx.threadId == null ? null : Number(ctx.threadId),
            },
            ctx.threadId == null ? 'dm' : String(ctx.threadId),
            prompt,
            'chat',
            nowMs,
            null,
            null,
            true,
          );
          receipt = {
            run_id: runId,
            queued: true,
            text: 'Пошук розпочато. Результат з’явиться тут і в особистому чаті.',
          };
        }
      } else {
        const row = await env.DB.prepare(
          "SELECT t.*,c.state_json FROM trips t JOIN chains c ON c.id=t.workflow_id WHERE t.id=? AND c.kind='trip'",
        )
          .bind(selectedId)
          .first();
        if (!row) throw new Error('Поїздку не знайдено.');
        const ctx = context(env, row);
        if (op === 'weather-consent') {
          if (typeof data.enabled !== 'boolean')
            throw new Error('Обери, чи передавати місто для прогнозу.');
          receipt = (
            await runTripWorkspace(
              env,
              {
                trip_id: selectedId,
                op: 'preferences',
                data: { weather_share_city: data.enabled },
                expected_revision: body.revision,
              },
              nowMs,
              { ...ctx, ownerWeatherConsent: true },
            )
          ).result;
        } else if (op === 'expense')
          receipt = (await runTripExpense(env, { ...data, trip_id: selectedId }, nowMs, ctx))
            .result;
        else if (op === 'reschedule') {
          receipt = (
            await startTripChain(
              env,
              { trip_id: selectedId, date_from: data.date_from, date_to: data.date_to },
              nowMs,
              ctx,
            )
          ).result;
          acknowledged = true;
        } else if (op === 'workspace')
          receipt = (
            await runTripWorkspace(
              env,
              {
                trip_id: selectedId,
                op: data.op,
                data: data.value,
                expected_revision: body.revision,
              },
              nowMs,
              ctx,
            )
          ).result;
        else if (op === 'cancel') receipt = await cancelTripChain(env, String(selectedId), nowMs);
        else throw new Error('Невідома дія для поїздки.');
      }
      acknowledged = true;
    }
    return reply({
      ok: true,
      acknowledged,
      receipt,
      ...(await readTravelWorkspace(env, selectedId, Date.now())),
    });
  } catch (error) {
    if (acknowledged)
      return reply({ ok: true, acknowledged: true, receipt, refreshRequired: true });
    const message = error instanceof Error ? error.message : '';
    const safe =
      !/SQLITE|D1_|syntax|no such|fetch failed|stack|привʼязк/iu.test(message) &&
      message.length < 260;
    return reply(
      {
        ok: false,
        error:
          safe && message
            ? message
            : 'Поїздки зараз недоступні. Збережені записи залишаються на місці.',
      },
      409,
    );
  }
}
