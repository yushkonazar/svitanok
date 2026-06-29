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
 * @param {boolean} [p.force]          - workflow_dispatch: обійти вікно+ідемпотентність (§19.2)
 * @returns {{ send: boolean, reason: string }}
 */
export function decideSend(p) {
  const { sendHour, sendWindowHours, kyivHour, todayKey, lastSentDate, force = false } = p;

  // Ручний запуск завжди форсує (§19.2): натиснув кнопку — хочеш зараз.
  if (force) {
    return { send: true, reason: 'force: ручний запуск обходить вікно та ідемпотентність' };
  }

  // Ідемпотентність: сьогодні вже слали (ловить другу джобу того ж дня / гонку dispatch).
  if (lastSentDate === todayKey) {
    return { send: false, reason: `idempotent: вже надіслано сьогодні (${todayKey})` };
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
