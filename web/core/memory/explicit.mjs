import { personalValueAllowed } from './safety.mjs';
import { readMemoryPreferences } from './preferences.mjs';
/** Deterministic first-party subset. Anything ambiguous follows normal policy.
 * @param {unknown} input */
export async function extractExplicitFact(input) {
  if (typeof input !== 'string') return null;
  const statement = input
    .normalize('NFC')
    .trim()
    .replace(/^(?:запам[’'ʼ]?ятай|запам[’'ʼ]?ятати)\s*:\s*/iu, '')
    .replace(/\.$/u, '')
    .trim();
  if (
    !statement ||
    statement.length > 350 ||
    /[\n\r"«»“”„`<>;?!]|https?:\/\//iu.test(statement) ||
    !personalValueAllowed(statement)
  )
    return null;
  if (
    /(?:^|\s)(?:якби|можливо|мабуть|наприклад|припустимо|цитата|жарт|сьогодні|завтра|тимчасово|зараз|поки|іноді|але|однак|проте|якщо|коли|він|вона|сказав|сказала)(?=\s|[:,.]|$)/iu.test(
      statement,
    )
  )
    return null;
  const style = /^(?:надалі\s+)?відповідай\s+(коротко|детально|стисло|українською)$/iu.exec(
    statement,
  );
  if (style)
    return {
      category: 'style',
      kind: 'profile',
      key: String(style[1]).toLowerCase() === 'українською' ? 'reply_language' : 'reply_style',
      value: String(style[1]).toLowerCase(),
      label: 'Стиль відповідей',
      statement,
    };
  const time =
    /^(?:я\s+)?зазвичай\s+(прокидаюсь|прокидаюся|встаю|лягаю\s+спати|обідаю)\s+о\s+(\d{1,2}):([0-5]\d)$/iu.exec(
      statement,
    );
  if (time && Number(time[2]) < 24) {
    const verb = String(time[1]).toLowerCase();
    const key = verb === 'обідаю' ? 'lunch_at' : verb.startsWith('лягаю') ? 'day_end' : 'day_start';
    return {
      category: 'schedule',
      kind: 'habit',
      key,
      value: `${String(time[2]).padStart(2, '0')}:${time[3]}`,
      label:
        key === 'day_start' ? 'Початок дня' : key === 'day_end' ? 'Завершення дня' : 'Час обіду',
      statement,
    };
  }
  const preference = /^(?:(?:я\s+)?(не\s+)?люблю|мені\s+(не\s+)?подобається)\s+(.+)$/iu.exec(
    statement,
  );
  if (!preference) return null;
  const subject = String(preference[3] ?? '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('uk-UA');
  if (
    !subject ||
    subject.length > 180 ||
    /[.!:]|\d{6}/u.test(subject) ||
    /(?:^|\s)(?:не|люблю|подобається|кажу|кажуть|хочу|радить|напиши|збережи|запиши)(?=\s|$)/iu.test(
      subject,
    )
  )
    return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return {
    category: 'preferences',
    kind: 'profile',
    key: `preference.${hash}`,
    value: { preference: subject, stance: preference[1] || preference[2] ? 'dislike' : 'like' },
    label: 'Вподобання',
    statement,
  };
}
/** Proof comes only from the trusted prerouter, never tool arguments.
 * @param {Env} env @param {Record<string, any>|undefined} evidence
 * @param {Record<string, any>} payload @param {number} [nowMs] */
export async function explicitOwnerConsent(env, evidence, payload, nowMs = Date.now()) {
  if (
    !evidence ||
    evidence.ownerComposed !== true ||
    !['text', 'confirmed_voice'].includes(evidence.origin) ||
    String(evidence.ownerId) !== String(env.TELEGRAM_OWNER_USER_ID ?? '') ||
    !env.TELEGRAM_OWNER_USER_ID ||
    !Number.isSafeInteger(evidence.messageId) ||
    evidence.messageId <= 0
  )
    return null;
  const fact = await extractExplicitFact(evidence.text);
  if (
    !fact ||
    fact.kind !== payload.kind ||
    fact.key !== payload.key ||
    JSON.stringify(fact.value) !== JSON.stringify(payload.value)
  )
    return null;
  const consent = await readMemoryPreferences(env, nowMs);
  if (
    consent.preferences.mode !== 'explicit' ||
    !consent.preferences.categories.includes(fact.category)
  )
    return null;
  return { ...fact, consentToken: consent.token };
}
