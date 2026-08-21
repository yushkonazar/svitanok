import { useState } from 'react';
import { useLevers } from '../../api/hooks.ts';
import { haptic } from '../../telegram.ts';
import { SectionHead, Hint, Note } from '../ui/primitives.tsx';
import { pluralUk } from '../../lib/plural.ts';
import type { LeverRow, LeverFeature } from '../../api/schema.ts';

// G · Важелі — єдине місце на екрані, що каже «що на що тягне», а не «скільки».
//
// ⚠️ ЧОМУ ЦЕЙ БЛОК НЕБЕЗПЕЧНІШИЙ ЗА РЕШТУ. Усе інше на екрані показує те, що
// сталося: скільки спав, скільки подав. Тут же — твердження про ЗВʼЯЗОК, а таке
// твердження вміє звучати переконливо, будучи вигадкою. Наївний перебір пар на
// тижневих рядах дає 33 хибні «відкриття» зі 156 навіть із поправкою: тижні
// автокорельовані, і p рахується так, ніби вони незалежні. Тому рядок сюди
// доходить, лише переживши ДВІ різні поправки (перші різниці й ефективний N) —
// деталі в web/levers-core.mjs і .workspace/StatsRevision/.
//
// ⚠️ ЗНАМЕННИК — ЧАСТИНА БЛОКУ, не підпис. Два рядки без «перевірено 21» — це
// «ось істина». Два рядки з ним — «ось двоє, що вижили з двадцяти одного».
// Прибрати його означає збрехати формою, лишивши числа правильними.
//
// ⚠️ ЗГОРНУТИЙ І В ХВОСТІ. Гейт — 26 тижнів даних; до нього блок каже лише
// «потрібно ще N». Тримати таке щодня перед очима означає платити увагою за
// повідомлення, яке не змінюється місяцями. Розгортання ж робить окреме
// читання KV — те саме рішення, що в «Історії».

/**
 * '2026-08-17' або ISO-мить -> '17.08'. Рік не потрібен: блок про останній рік.
 *
 * ⚠️ ДВА РІЗНІ ВХОДИ, і плутати їх не можна. `weekOf`/`lastWeek` — це вже
 * КИЇВСЬКІ дати рядком, тож ріжемо їх посимвольно, без Date: будь-який розбір
 * дав би зсув у часовому поясі там, де його немає.
 *
 * `computedAt` — мить UTC, і саме тут була помилка: читання через getUTCDate
 * показувало добу НАЗАД. Крон спрацьовує на першому тіку київського тижня,
 * тобто в понеділок о 00:05 Київ = 21:05 UTC НЕДІЛІ — отже «17.08» ставало
 * «16.08», причому не зрідка, а ЗАВЖДИ, і суперечило `weekOf` у тому ж payload.
 *
 * Форматуємо явно в Europe/Kyiv, а не локаллю пристрою: увесь застосунок
 * рахує київські доби на сервері, і дата на екрані не має залежати від того,
 * де зараз телефон. Той самий мотив, що в `kyivMinutes` (lib/weather.ts).
 */
const KYIV_DM = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
});

function shortDate(value: string | null): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(8, 10)}.${value.slice(5, 7)}`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : KYIV_DM.format(d);
}

const weeksWord = (n: number) => pluralUk(n, ['тиждень', 'тижні', 'тижнів']);

/**
 * Пояснення до КОЖНОЇ причини виключення ряду.
 *
 * ⚠️ Перша версія друкувала одну зашиту фразу «забракло розкиду між тижнями»
 * на всі випадки — і для «мало тижнів» це просто неправда, а саме ця причина
 * буде в майже всіх рядів до гейта, тобто в стані, який видно місяцями. Ядро
 * рахує причину, API її везе, тести пінять — і виходило, що останній крок її
 * викидав.
 */
const SKIPPED_TEXT: Record<string, string> = {
  'мало тижнів': 'для них ще замало тижнів; зʼявляться, коли назбирається історія.',
  'майже стале значення':
    'у них майже всі тижні однакові. Ряд без розкиду не покаже звʼязку ні за якого обсягу даних.',
  'одне значення в більшості тижнів':
    'одне значення займає більш ніж половину тижнів. Такий ряд не покаже звʼязку ні за якого ' +
    'обсягу даних — це не про кількість, а про форму.',
};

/** Згрупувати виключені ряди за причиною, щоб не повторювати пояснення. */
function groupSkipped(
  skipped: { key: string; reason: string }[],
  features: Record<string, LeverFeature>,
): { reason: string; labels: string[] }[] {
  const byReason = new Map<string, string[]>();
  for (const s of skipped) {
    const labels = byReason.get(s.reason) ?? [];
    labels.push(features[s.key]?.label ?? s.key);
    byReason.set(s.reason, labels);
  }
  return [...byReason].map(([reason, labels]) => ({ reason, labels }));
}

/** Один рядок-важіль. */
function LeverCard({ row, features }: { row: LeverRow; features: Record<string, LeverFeature> }) {
  const from = features[row.from];
  const to = features[row.to];
  if (!from || !to) return null;

  const when = row.lag === 1 ? 'наступного тижня' : 'того ж тижня';
  const up = row.rho > 0;
  const e = row.effect;

  return (
    <div className="rounded-2xl border border-glassb bg-glass p-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-tx1">
        <span className="font-semibold">
          {from.emoji} {from.label}
        </span>
        <span className="text-tx3">→</span>
        <span className="font-semibold">
          {to.emoji} {to.label}
        </span>
      </div>

      <div className="mt-1 text-[11.5px] leading-[1.5] text-tx2">
        {/* ⚠️ Формулювання навмисно НЕ каузальне: «у тижнях, де було — там
            було», а не «підвищує». Метод міряє звʼязок у часі, а не причину, і
            підміна дієслова тут була б найдешевшим способом збрехати, не
            змінивши жодного числа.
            Фрази беруться ГОТОВИМИ з реєстру ознак: шаблон із прикметником
            давав «оцінка дня більше» й «коли роадмеп вищий». */}
        у тижнях, де було {from.more}, — {when} {up ? to.more : to.less}
      </div>

      {e && (
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-[15px] font-medium text-tx1">
            {e.high} <span className="text-[11px] text-tx3">проти</span> {e.low}
          </span>
          {to.unit && <span className="text-[10.5px] text-tx3">{to.unit}</span>}
        </div>
      )}

      <div className="mt-1.5 font-mono text-[9.5px] tracking-[0.06em] text-tx3">
        ВИТРИМУЄ ОБИДВІ ПОПРАВКИ · ρ={row.rho.toFixed(2)} · p=
        {row.p < 0.001 ? '<0.001' : row.p.toFixed(3)} · {row.n} {weeksWord(row.n)}
      </div>
    </div>
  );
}

export function LeversBlock() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useLevers(open);

  const payload = data?.levers ?? null;
  const features = data?.features ?? {};
  // Гейт приходить ІЗ СЕРВЕРА разом із даними — жодного літерала тут: інакше
  // зміна GATE_WEEKS лишила б на екрані застаріле число.
  const gate = data?.gate ?? 0;
  const useful = data?.useful ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Важелі</SectionHead>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1.5 self-start rounded-full border border-glassb bg-glass px-3 py-1.5 text-[11px] font-semibold text-tx2"
      >
        <span>{open ? '− Згорнути' : '+ Що на що тягне'}</span>
      </button>

      {open && isLoading && <div className="text-[11px] text-tx3">Завантажую…</div>}

      {open && isError && (
        <div className="text-[11px] leading-[1.5] text-tx3">
          Не вдалося прочитати важелі. Це окреме сховище — решта статистики від цього не залежить.
        </div>
      )}

      {open && !isLoading && !isError && (
        <div className="flex flex-col gap-3.5">
          {/* ⚠️ ТРИ РІЗНІ ПОРОЖНІ СТАНИ, і жоден не можна замінити іншим.
              «Ще не рахувалось» ≠ «даних замало» ≠ «перевірили й нічого не
              витримало». Останній — єдиний, що є твердженням про дані; перші
              два кажуть, що твердження ще немає. */}
          {!payload && (
            <Note>
              Розрахунку ще не було: він робиться раз на тиждень, у ніч на понеділок. Перші звʼязки
              зʼявляться після найближчого перерахунку.
            </Note>
          )}

          {payload && !payload.ready && (
            <Note>
              Даних поки замало. Придатних {weeksWord(payload.weeks)}: {payload.weeks} — потрібно{' '}
              {gate}, тобто ще {payload.weeksNeeded}. Тиждень вважається придатним, коли чек-ін
              заповнено щонайменше три доби: тижневе середнє з однієї-двох діб каже більше про те,
              які доби випадково заповнились, ніж про сам тиждень.
              {useful > gate && (
                <>
                  {' '}
                  Перші звʼязки зʼявляться близько {gate}-го тижня, але помітним блок стає ближче до{' '}
                  {useful}-го: доти видно лише найсильніші.
                </>
              )}
            </Note>
          )}

          {payload?.ready && payload.rows.length === 0 && (
            <Note>
              Перевірено {payload.tested}{' '}
              {pluralUk(payload.tested, ['звʼязок', 'звʼязки', 'звʼязків'])} — жоден не витримав
              поправки. Це повноцінна відповідь, а не порожнеча: кожен зі знайдених міг трапитись
              випадково, і показати його означало б видати збіг за закономірність.
            </Note>
          )}

          {payload?.ready &&
            payload.rows.map((r) => (
              <LeverCard key={`${r.from}-${r.to}-${r.lag}`} row={r} features={features} />
            ))}

          {payload?.ready && payload.rows.length > 0 && (
            <div className="text-[11px] leading-[1.5] text-tx3">
              Перевірено {payload.tested}{' '}
              {pluralUk(payload.tested, ['звʼязок', 'звʼязки', 'звʼязків'])}, показано{' '}
              {payload.shown}. Решта не витримала поправки — тобто могла трапитись випадково.
            </div>
          )}

          {payload && payload.skipped.length > 0 && (
            <div className="text-[10.5px] leading-[1.5] text-tx3">
              {/* Заголовок ОДИН, далі рядок на кожну причину: два абзаци поспіль,
                  що починаються з «Не перевірялись:», читаються як помилка
                  верстки, а не як перелік. */}
              Не перевірялись:
              {groupSkipped(payload.skipped, features).map((g) => (
                <div key={g.reason} className="mt-0.5">
                  {g.labels.join(', ')} — {SKIPPED_TEXT[g.reason] ?? g.reason}
                </div>
              ))}
            </div>
          )}

          {payload && (
            /* ⚠️ Єдине, що відрізняє свіжий результат від «крон упав три тижні
               тому, а рядки ті самі». Без цього рядка збій деградував би
               мовчки: старий результат виглядає точно так само, як новий. */
            <div className="font-mono text-[9px] tracking-[0.06em] text-tx3">
              РАХУВАЛОСЬ {shortDate(payload.computedAt)} · ВІКНО ДО {shortDate(payload.lastWeek)}
            </div>
          )}

          <Hint>
            Кожен рядок — звʼязок між двома тижневими рядами: що було одного тижня і що сталося того
            ж або наступного. Рядок доходить сюди, лише переживши дві різні поправки на те, що тижні
            не незалежні один від одного — без них такий перебір дає десятки впевнених вигадок, і що
            більше даних, то більше. «11.4 проти 5.6» читається так: у тижнях, де перший показник
            був вищий за свою медіану, другий у середньому дорівнював 11.4, а в решті — 5.6. Це
            звʼязок у часі, не причина: блок не знає, що на що впливає, лише що з чим ходить разом.
          </Hint>
        </div>
      )}
    </div>
  );
}
