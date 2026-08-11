// ЄДИНЕ ДЖЕРЕЛО ЛОГІКИ guard (§2, §19.1). Чистий ESM, нуль залежностей —
// щоб виконуватись і в оркестраторі (через core/guard.ts), і в CI на «голому»
// node (через scripts/guard.mjs) без npm ci. Жодного дублювання порівняння в bash.

/**
 * Рішення «слати чи ні» за вікном + ідемпотентністю.
 * Вікно: [sendHour, sendHour + sendWindowHours) — верхня межа НЕВКЛЮЧНА.
 * Нижня межа ловить спізнення cron; верхня не дає спізнілій джобі надіслати
 * «ранковий» брифінг опівночі.
 *
 * @param {object} p
 * @param {number} p.sendHour          - початок вікна, київська година 0–23
 * @param {number} p.sendWindowHours   - ширина вікна в годинах
 * @param {number} p.kyivHour          - поточна київська година 0–23
 * @param {string} p.todayKey          - "YYYY-MM-DD" київський
 * @param {string|null} p.lastSentDate - "YYYY-MM-DD" останньої відправки або null
 * @param {boolean} [p.forceWindow]    - обійти ЛИШЕ годинне вікно, ідемпотентність лишити
 * @param {boolean} [p.forceSend]      - обійти і вікно, і ідемпотентність (людина-налагоджувач)
 * @param {boolean} [p.force]          - легасі-синонім forceSend (старі виклики)
 * @returns {{ send: boolean, reason: string }}
 */
export function decideSend(p) {
  const {
    sendHour,
    sendWindowHours,
    kyivHour,
    todayKey,
    lastSentDate,
    forceWindow = false,
    forceSend = false,
    force = false,
  } = p;
  const fullBypass = forceSend || force;

  /* ⚠️ Два РІЗНІ «форси» (B2/F2). Доти був один, і ручний /brief обходив
     ідемпотентність — а повторний прогін того самого дня перебирає ВЖЕ
     показані новини й вакансії (shownNews/shownJobs), тож віддає майже
     порожній брифінг і публікує його поверх ранкового: у KV `latest` І в
     історії `briefing:<дата>`. Дашборд назавжди лишався без новин за той день,
     а inline-кнопки ранкового повідомлення починали вказувати в інший масив.
     Тепер «хочу зараз, поза вікном» і «перезапиши сьогоднішній» — це різні
     наміри й різні прапорці. */
  if (fullBypass) {
    return { send: true, reason: 'force-send: обхід вікна та ідемпотентності' };
  }

  // Ідемпотентність: сьогодні вже слали (ловить другу джобу того ж дня / гонку dispatch).
  // Її НЕ обходить forceWindow — саме вона захищає опублікований брифінг.
  if (lastSentDate === todayKey) {
    return { send: false, reason: `idempotent: вже надіслано сьогодні (${todayKey})` };
  }

  if (forceWindow) {
    return { send: true, reason: 'force-window: ручний запуск поза вікном (ідемпотентність діє)' };
  }

  const lower = sendHour;
  const upper = sendHour + sendWindowHours;

  if (kyivHour < lower) {
    return { send: false, reason: `before window: kyivHour ${kyivHour} < ${lower}` };
  }
  if (kyivHour >= upper) {
    return { send: false, reason: `after window: kyivHour ${kyivHour} >= ${upper}` };
  }

  return { send: true, reason: `in window [${lower}, ${upper}) at kyivHour ${kyivHour}` };
}
