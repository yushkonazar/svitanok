const number = (/** @type {number} */ value) =>
  new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(value);
const money = (/** @type {number} */ value) =>
  new Intl.NumberFormat('uk-UA', {
    style: 'currency',
    currency: 'UAH',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value / 100);
const n = (/** @type {any} */ metric) => metric?.numericN ?? metric?.n ?? 0;
const plural = (/** @type {number} */ count, /** @type {string[]} */ forms) =>
  forms[
    count % 100 >= 11 && count % 100 <= 14
      ? 2
      : count % 10 === 1
        ? 0
        : count % 10 >= 2 && count % 10 <= 4
          ? 1
          : 2
  ];
const FACTORS = /** @type {Record<string,string>} */ ({
  sleep: 'недостатній або неякісний сон',
  no_breaks: 'довгу роботу без перерв',
  physical_load: 'фізичне навантаження',
  stress: 'напруження й переживання',
  many_tasks: 'забагато справ одночасно',
  unclear: 'неясний наступний крок',
  distraction: 'відволікання',
  immobility: 'тривалу нерухомість',
  health: 'нездужання або дискомфорт',
  missed_food: 'пропущену їжу',
  no_food_time: 'нестачу часу на їжу',
});
const weekNames = /** @type {Record<string,string>} */ ({
  sleep: 'Сон',
  mood: 'Настрій',
  energy: 'Енергія',
  plans: 'Справи',
});
/** @param {import('../checkin/state-week.mjs').WeekHighlight[]} highlights */
function interpretStateWeek(highlights) {
  const [lead, ...rest] = highlights;
  if (!lead) return null;
  const primary = lead.context[0];
  const secondary = lead.context.find((item) => item.kind !== primary?.kind);
  const context = [primary, secondary].filter((item) => item != null);
  const support = primary?.dates.length ? primary.dates : lead.dates;
  const date = new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return {
    section: {
      kind: 'personal',
      title: lead.title,
      paragraphs: [
        lead.text,
        ...context.map(
          (item) => `${item.kind === 'reported' ? 'За твоїми відповідями. ' : ''}${item.text}`,
        ),
        ...rest.slice(0, 2 - context.length).map((item) => `${weekNames[item.key]} · ${item.text}`),
      ],
      evidence: support.length
        ? [
            {
              label: primary ? 'Дні з цим контекстом' : 'Дні з відповідями',
              value: support.map((key) => date.format(new Date(`${key}T12:00:00Z`))).join(', '),
            },
          ]
        : [],
    },
    idea: primary?.idea,
  };
}

/** Explanations from bounded evidence. Same-day pairs and explicit reasons are
 * separate evidence; neither is presented as proven causality.
 * @param {any} details @param {any} [decision] */
export function interpretWeeklyReport(details, decision) {
  /** @type {{kind:string,title:string,paragraphs:string[],evidence:{label:string,value:string}[]}[]} */ const sections =
    [];
  /** @type {string[]} */ const suggestions = [];
  const periods = details?.personalPeriods,
    current = periods?.current,
    previous = periods?.previousWeeks?.[0];
  const energy = current?.patterns?.energy,
    recovery = current?.patterns?.recovery;
  const metrics = current?.observationsV3;
  const state = current?.weekHighlights?.length ? interpretStateWeek(current.weekHighlights) : null;
  if (state) {
    sections.push(state.section);
    if (state.idea) suggestions.push(state.idea);
  } else if (current) {
    let title = '',
      paragraphs = [],
      evidence = [];
    if (energy?.pairs >= 3) {
      const delta = energy.eveningAverage - energy.morningAverage;
      if (energy.lowerDays / energy.pairs >= 0.6 && delta <= -0.5) {
        title = 'До вечора запас сил зменшується';
        paragraphs.push(
          `У ${energy.lowerDays} із ${energy.pairs} днів із ранковим і вечірнім записами енергія до вечора спадала. Це повторюваний ритм цього тижня, який варто врахувати в розподілі справ.`,
        );
      } else if (energy.higherDays / energy.pairs >= 0.6 && delta >= 0.5) {
        title = 'Увечері сил частіше стає більше';
        paragraphs.push(
          `У ${energy.higherDays} із ${energy.pairs} днів із двома записами вечірня енергія була вищою. Схоже, цього тижня тобі було легше включатися в другій половині дня.`,
        );
      } else {
        title =
          energy.sameDays / energy.pairs >= 0.6
            ? 'Запас сил переважно зберігається протягом дня'
            : 'Енергія змінюється без одного сталого сценарію';
        paragraphs.push(
          `Порівняння ранку й вечора тих самих ${energy.pairs} днів не показує виразного односпрямованого спаду. Окремі важкі дні варто розглядати разом із твоїми поясненнями.`,
        );
      }
      evidence.push(
        { label: 'Ранок', value: `${number(energy.morningAverage)} / 5` },
        { label: 'Вечір', value: `${number(energy.eveningAverage)} / 5` },
        {
          label: 'Зіставлено',
          value: `${energy.pairs} ${plural(energy.pairs, ['день', 'дні', 'днів'])}`,
        },
      );
    } else if (energy?.lowDays >= 3) {
      title = 'Нестача сил повторювалася';
      paragraphs.push(
        `Щонайменше в ${energy.lowDays} днях ти відзначав низьку енергію. Пар ранкових і вечірніх відповідей поки недостатньо, щоб описати її зміну впродовж дня.`,
      );
    }
    const factors = Object.entries(energy?.factors?.counts ?? {})
      .filter(([code, count]) => FACTORS[code] && Number(count) >= 2)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (factors.length && energy.factors.answeredDays >= 2) {
      const [code, count] = /** @type {[string,unknown]} */ (factors[0]);
      title ||= 'Твої відповіді підказують, що забирає сили';
      paragraphs.push(
        `Із нестачею сил ти пов’язував ${FACTORS[code]} — у ${count} із ${energy.factors.answeredDays} днів, коли пояснював цей стан. Це твоє спостереження про можливий чинник, яке можна перевірити невеликою зміною ритму.`,
      );
      suggestions.push(
        code === 'no_breaks' || code === 'physical_load'
          ? 'Спробуй заздалегідь залишати коротку перерву між тривалими справами й перевірити, як після неї змінюється вечірня енергія.'
          : code === 'sleep'
            ? 'Зверни увагу на відзначені тобою перешкоди сну й обери одну, яку реально зменшити наступного тижня.'
            : code === 'many_tasks' || code === 'unclear' || code === 'distraction'
              ? 'Обери одну важливу справу з чітким першим кроком і залиш для неї час, коли за твоїми записами більше сил.'
              : 'Обери один повторюваний чинник низької енергії та спробуй невелику зміну, результат якої відзначиш у чек-іні.',
      );
    } else if (title && energy?.lowerDays / energy.pairs >= 0.6) {
      paragraphs.push(
        'Пояснень до низької енергії поки замало, щоб пов’язати спад із конкретною причиною. Можна перевірити, чи допомагає коротка пауза до звичного вечірнього спаду.',
      );
    }
    if (recovery?.days >= 3 && recovery.limitedDays / recovery.days >= 0.6) {
      title ||= 'Звичний відпочинок не завжди повертає сили';
      paragraphs.push(
        `У ${recovery.limitedDays} із ${recovery.days} вечірніх відповідей відновлення мало допомагало. Сам факт відпочинку ще не означає, що обраний спосіб повертає сили; варто звернути увагу на те, що ти називав дієвим.`,
      );
    }
    const sleep = metrics?.['morning.sleepMinutesV3'],
      priorSleep = previous?.observationsV3?.['morning.sleepMinutesV3'];
    if (n(sleep) >= 3 && n(priorSleep) >= 3 && Math.abs(sleep.average - priorSleep.average) >= 30) {
      title ||= sleep.average > priorSleep.average ? 'Сну стало більше' : 'Сну стало менше';
      paragraphs.push(
        `Порівняно з попереднім тижнем середня тривалість сну ${sleep.average > priorSleep.average ? 'зросла' : 'скоротилася'} приблизно на ${number(Math.abs(sleep.average - priorSleep.average))} хвилин. Це зміна за тією самою анкетою, а не пояснення всіх коливань енергії.`,
      );
      evidence.push({ label: 'Сон', value: `${number(sleep.average / 60)} год` });
    }
    if (!paragraphs.length) {
      const morning = metrics?.['morning.energy'],
        before = previous?.observationsV3?.['morning.energy'];
      if (n(morning) >= 3 && n(before) >= 3) {
        const delta = morning.average - before.average;
        title =
          Math.abs(delta) < 0.4
            ? 'Ранковий стан близький до попереднього тижня'
            : delta > 0
              ? 'Ранок починається з більшим запасом сил'
              : 'Зранку запас сил став нижчим';
        paragraphs.push(
          `Ранкова енергія ${delta > 0 ? 'зросла' : delta < 0 ? 'знизилася' : 'залишилася на рівні'} з ${number(before.average)} до ${number(morning.average)} за п’ятибальною шкалою. Для пояснення причин потрібні збережені уточнення; самі середні їх не визначають.`,
        );
        evidence.push({
          label: 'Відповідей',
          value: `${n(morning)} цього тижня · ${n(before)} раніше`,
        });
      } else {
        title = current.patterns
          ? 'Для особистих закономірностей потрібні зіставні записи'
          : 'У цьому огляді збережено лише загальні показники';
        paragraphs.push(
          current.patterns
            ? 'Наявні відповіді описують окремі моменти тижня. Їх поки недостатньо для впевненого порівняння ритму чи пояснення причин змін.'
            : 'Збереженої деталізації цього огляду недостатньо для зіставлення ранку й вечора та пояснення причин змін. Це обмеження старого звіту; нові огляди зберігатимуть і явні пояснення з чек-інів.',
        );
      }
    }
    sections.push({
      kind: 'personal',
      title,
      paragraphs: paragraphs.slice(0, 3),
      evidence: evidence.slice(0, 4),
    });
  }
  const plan = details?.plan;
  if (typeof plan?.summary?.distinctResults === 'number') {
    const summary = plan.summary,
      total = summary.distinctResults,
      completed = summary.completedDistinctResults ?? 0,
      late = summary.lifecycle?.['completed-late'] ?? 0;
    const title = !total
      ? 'Тиждень без прийнятих справ у Плані'
      : late > 0
        ? 'Результат є, але строки потребують уваги'
        : completed >= total
          ? 'Заплановані результати доведено до завершення'
          : completed > 0
            ? 'Є завершені справи й незакриті кроки'
            : 'Прийняті справи поки не дали завершеного результату';
    const paragraphs = [
      !total
        ? 'У збереженому Плані немає прийнятих результатів цього тижня. Це не означає, що ти нічого не робив: огляд не прирівнює відсутність запису до відсутності діяльності.'
        : `Завершено ${completed} із ${total} самостійних результатів. ${late > 0 ? `Після строку виконано ${late} ${plural(late, ['обіцянку', 'обіцянки', 'обіцянок'])}: фактичний поступ збережений, навіть якщо умови XP вже не виконано.` : completed < total ? 'Для наступного тижня важливо розрізнити справді потрібне продовження й справи, які втратили актуальність.' : 'Варто зберегти посильний обсяг плану й подивитися, які умови допомогли завершувати справи.'}`,
    ];
    if (plan.complete === false)
      paragraphs.push(
        'Підсумок Плану неповний; остаточний висновок про виконання всього тижня робити зарано.',
      );
    if (late > 0)
      suggestions.push(
        'Переглянь повторювані запізнення в Плані: перед новою обіцянкою уточни обсяг або час, залишаючи реальний запас.',
      );
    sections.push({
      kind: 'plan',
      title,
      paragraphs,
      evidence: [{ label: 'Результати', value: `${completed} / ${total}` }],
    });
  }
  const finance = details?.finance;
  if (typeof finance?.summary?.expenseMinor === 'number') {
    const amount = finance.summary.expenseMinor,
      comparison = finance.comparison;
    const baseline = comparison?.complete
      ? comparison.averageExpenseMinor
      : comparison?.previousWeek?.complete
        ? comparison.previousWeek.expenseMinor
        : null;
    const baseLabel = comparison?.complete
      ? 'середнього чотирьох попередніх тижнів'
      : 'попереднього тижня';
    const delta =
      typeof baseline === 'number' && baseline > 0 ? ((amount - baseline) / baseline) * 100 : null;
    const title =
      delta == null
        ? 'Видно структуру витрат, але бракує бази порівняння'
        : Math.abs(delta) < 5
          ? 'Витрати залишилися близькими до звичного рівня'
          : delta > 0
            ? 'Цього тижня витрачено більше'
            : 'Цього тижня витрачено менше';
    const paragraphs = [
      delta == null
        ? `За тиждень обліковано ${money(amount)} витрат. Надійного попереднього періоду поки немає, тому саму суму не можна назвати зростанням чи економією.`
        : `Обліковані витрати — ${money(amount)}, ${Math.abs(delta) < 0.05 ? 'майже на рівні' : `на ${number(Math.abs(delta))}% ${delta > 0 ? 'вище' : 'нижче'}`} ${baseLabel}.`,
    ];
    const top = finance.categoryBreakdown?.top?.[0];
    if (top?.category && top.amountMinor > 0 && amount > 0)
      paragraphs.push(
        `Найбільша частка припала на «${String(top.category).slice(0, 80)}» — ${number((top.amountMinor / amount) * 100)}% витрат. Саме тут перегляд окремих операцій найкраще пояснить, із чого склався цей тиждень.`,
      );
    const changes = comparison?.previousWeek?.complete
      ? (comparison.previousWeek.categoryChanges ?? [])
      : [];
    const driver = [...changes]
      .filter((/** @type {any} */ row) => Number.isFinite(row.changeMinor) && row.changeMinor !== 0)
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          Math.abs(b.changeMinor) - Math.abs(a.changeMinor),
      )[0];
    if (driver)
      paragraphs.push(
        `Проти попереднього тижня найбільше змінилася категорія «${String(driver.category).slice(0, 80)}»: ${driver.changeMinor > 0 ? 'більше' : 'менше'} на ${money(Math.abs(driver.changeMinor))}. Це конкретний внесок у зміну, який варто відрізнити від разових оплат.`,
      );
    if (finance.review?.outflows?.pendingExpenseMinor > 0)
      paragraphs.push(
        'Частина включених операцій ще очікує підтвердження банком; підсумок може змінитися після уточнення.',
      );
    if (delta != null && delta >= 10 && top?.category)
      suggestions.push(
        `Переглянь операції категорії «${String(top.category).slice(0, 60)}»: відокрем разові оплати від витрат, які повторяться наступного тижня.`,
      );
    sections.push({
      kind: 'finance',
      title,
      paragraphs: paragraphs.slice(0, 4),
      evidence: [
        { label: 'Витрати', value: money(amount) },
        ...(typeof baseline === 'number'
          ? [
              {
                label: comparison?.complete ? 'База 4 тижнів' : 'Попередній тиждень',
                value: money(baseline),
              },
            ]
          : []),
      ],
    });
  }
  // Optional long-form model explanations share the frozen evidence snapshot.
  // A model cannot create a section for a domain absent from that snapshot.
  for (const section of sections) {
    const authored = decision?.sections?.find(
      (/** @type {any} */ item) => item.kind === section.kind,
    );
    if (authored) {
      section.title = authored.title;
      section.paragraphs = authored.paragraphs;
    }
  }
  const actions = [...new Set([...(decision?.actions ?? []), ...suggestions])]
    .filter((value) => typeof value === 'string' && value.trim())
    .slice(0, 2);
  return { sections, actions };
}
