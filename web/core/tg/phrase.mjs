// Людською, не kind-ом (релізний блок PR-2, скарги 4/9/13 прогону 08.09).
//
// ЩО ТУТ: словник дій «kind → як це називається людською» + єдиний словник
// емодзі по темах. Технічна назва дії лишається там, де вона й потрібна - у
// логах, у телеметрії й у дайджесті рішень ДЛЯ МОДЕЛІ (describeProposal);
// власник її не бачить.
//
// ЧОМУ ОКРЕМИЙ МОДУЛЬ, А НЕ РЯДКИ НА МІСЦІ. Одна й та сама дія називається у
// трьох місцях: у пропозиції («Експортувати колекцію?»), у результаті
// («Експортував колекцію»), у переліку скасованого. Розкидані рядки
// розходяться - і власник бачить три різні назви однієї дії.

/** Одне емодзі на тему, завжди те саме (B1 релізного плану). */
export const DOMAIN_ICON = {
  calendar: '🗓',
  reminder: '⏰',
  idea: '💡',
  money: '💸',
  document: '📄',
  collection: '🗂',
  mail: '✉️',
  place: '📍',
  video: '🎬',
  image: '🖼',
  secrets: '🔑',
  plan: '🧭',
  warn: '⚠️',
  done: '✅',
  undo: '↩',
  memory: '🧠',
  task: '📋',
  person: '👤',
  wish: '🎁',
  settings: '⚙️',
  archive: '📦',
  chain: '🔗',
};

/**
 * kind дії → як її назвати власнику. `done` - доконаний вигляд для результату,
 * `ask` - інфінітив для пропозиції («Експортувати колекцію «X»?»).
 * @type {Record<string, { icon: string, done: string, ask: string }>}
 */
export const ACTION_PHRASE = {
  'facts.set': { icon: DOMAIN_ICON.memory, done: 'Запамʼятав', ask: 'Запамʼятати' },
  'facts.delete': { icon: DOMAIN_ICON.memory, done: 'Видалив факт', ask: 'Видалити факт' },
  record: { icon: DOMAIN_ICON.collection, done: 'Записав', ask: 'Записати' },
  'reminders.create': { icon: DOMAIN_ICON.reminder, done: 'Нагадаю', ask: 'Нагадати' },
  'reminders.update': {
    icon: DOMAIN_ICON.reminder,
    done: 'Переніс нагадування',
    ask: 'Перенести нагадування',
  },
  'reminders.cancel': {
    icon: DOMAIN_ICON.reminder,
    done: 'Скасував нагадування',
    ask: 'Скасувати нагадування',
  },
  'ideas.create': { icon: DOMAIN_ICON.idea, done: 'Записав ідею', ask: 'Записати ідею' },
  'ideas.update': { icon: DOMAIN_ICON.idea, done: 'Оновив ідею', ask: 'Оновити ідею' },
  'ideas.analyze': { icon: DOMAIN_ICON.idea, done: 'Аналізую ідею', ask: 'Проаналізувати ідею' },
  'ideas.delete': { icon: DOMAIN_ICON.idea, done: 'Видалив ідею', ask: 'Видалити ідею' },
  'wishes.create': { icon: DOMAIN_ICON.wish, done: 'Додав до бажань', ask: 'Додати до бажань' },
  'wishes.update': { icon: DOMAIN_ICON.wish, done: 'Оновив бажання', ask: 'Оновити бажання' },
  'wishes.import': {
    icon: DOMAIN_ICON.wish,
    done: 'Імпортував бажання',
    ask: 'Імпортувати бажання',
  },
  'wishes.delete': { icon: DOMAIN_ICON.wish, done: 'Видалив бажання', ask: 'Видалити бажання' },
  'collections.create': {
    icon: DOMAIN_ICON.collection,
    done: 'Створив колекцію',
    ask: 'Створити колекцію',
  },
  'collections.update': {
    icon: DOMAIN_ICON.collection,
    done: 'Оновив колекцію',
    ask: 'Оновити колекцію',
  },
  'records.create': { icon: DOMAIN_ICON.collection, done: 'Додав запис', ask: 'Додати запис' },
  'records.update': { icon: DOMAIN_ICON.collection, done: 'Оновив запис', ask: 'Оновити запис' },
  'records.delete': { icon: DOMAIN_ICON.collection, done: 'Видалив запис', ask: 'Видалити запис' },
  'collection.export': {
    icon: DOMAIN_ICON.collection,
    done: 'Експортував колекцію',
    ask: 'Експортувати колекцію',
  },
  'chain.start': { icon: DOMAIN_ICON.chain, done: 'Веду', ask: 'Взятися за' },
  'chain.cancel': { icon: DOMAIN_ICON.chain, done: 'Зупинив', ask: 'Зупинити' },
  'finance.rule': {
    icon: DOMAIN_ICON.money,
    done: 'Запамʼятав правило',
    ask: 'Запамʼятати правило',
  },
  'subscriptions.update': {
    icon: DOMAIN_ICON.money,
    done: 'Оновив підписку',
    ask: 'Оновити підписку',
  },
  'plan.intent': {
    icon: DOMAIN_ICON.plan,
    done: 'Записав намір на день',
    ask: 'Записати намір на день',
  },
  'plan.draft': { icon: DOMAIN_ICON.plan, done: 'Склав чернетку дня', ask: 'Скласти чернетку дня' },
  'plan.accept': { icon: DOMAIN_ICON.plan, done: 'Прийняв план дня', ask: 'Прийняти план дня' },
  'plan.update': { icon: DOMAIN_ICON.plan, done: 'Оновив план дня', ask: 'Оновити план дня' },
  'plan.review': {
    icon: DOMAIN_ICON.plan,
    done: 'Підбив підсумок дня',
    ask: 'Підбити підсумок дня',
  },
  'calendar.event': { icon: DOMAIN_ICON.calendar, done: 'Створив подію', ask: 'Створити подію' },
  'calendar.update': { icon: DOMAIN_ICON.calendar, done: 'Переніс подію', ask: 'Перенести подію' },
  'calendar.delete': { icon: DOMAIN_ICON.calendar, done: 'Видалив подію', ask: 'Видалити подію' },
  invite: { icon: DOMAIN_ICON.calendar, done: 'Надіслав запрошення', ask: 'Надіслати запрошення' },
  'drive.write': { icon: DOMAIN_ICON.document, done: 'Зберіг нотатку', ask: 'Зберегти нотатку' },
  'tasks.create': { icon: DOMAIN_ICON.task, done: 'Поставив задачу', ask: 'Поставити задачу' },
  settings: {
    icon: DOMAIN_ICON.settings,
    done: 'Змінив налаштування',
    ask: 'Змінити налаштування',
  },
  contact: { icon: DOMAIN_ICON.person, done: 'Додав контакт', ask: 'Додати контакт' },
  'gemini.image': { icon: DOMAIN_ICON.image, done: 'Намалював', ask: 'Намалювати' },
  'gemini.video': { icon: DOMAIN_ICON.video, done: 'Зняв відео', ask: 'Зняти відео' },
  'style.collect': { icon: '✍️', done: 'Зібрав твої тексти', ask: 'Зібрати твої тексти' },
  'knowledge.import': {
    icon: '📄',
    done: 'Додав документ до бази знань',
    ask: 'Додати документ до бази знань',
  },
  'knowledge.revoke': { icon: '📄', done: 'Відкликав документ', ask: 'Відкликати документ' },
  'knowledge.delete': { icon: '🧹', done: 'Видалив документ', ask: 'Видалити документ' },
  forget: { icon: '🧹', done: 'Стер', ask: 'Стерти' },
  'data.export': {
    icon: DOMAIN_ICON.archive,
    done: 'Зібрав архів даних',
    ask: 'Зібрати архів даних',
  },
};

/**
 * Назва дії людською + впізнаваний ключ у лапках.
 * @param {string} kind
 * @param {string} label уже очищена назва (див. describeProposal)
 * @param {'done' | 'ask'} mode
 * @returns {string} «Експортував колекцію «Сервіси»» або, для невідомого
 *   kind, сам kind - мовчазна заглушка гірша за видиму технічну назву
 */
export function actionPhrase(kind, label, mode = 'done') {
  const phrase = ACTION_PHRASE[kind];
  const head = phrase ? phrase[mode] : kind;
  return label ? `${head} «${label}»` : head;
}

/** Емодзі теми для дії; невідомий kind - без емодзі (не вигадуємо).
 *  @param {string} kind */
export function actionIcon(kind) {
  return ACTION_PHRASE[kind]?.icon ?? '';
}

/**
 * Число + форма слова (одна / дві / пʼять). Живе тут, поруч зі словником:
 * форма слова - це та сама розмова з власником, що й назва дії.
 * @param {number} n @param {string} one @param {string} few @param {string} many
 */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
