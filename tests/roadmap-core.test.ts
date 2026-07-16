import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as roadmap from '../web/roadmap-core.mjs';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import { ROADMAP_TOPICS } from '../web/roadmap-data.mjs';
const {
  ROADMAP_CB_PREFIX,
  progressKey,
  findTopic,
  findSubtopic,
  buildRootCallbackData,
  buildTopicCallbackData,
  buildToggleCallbackData,
  parseRoadmapCallbackData,
  toggleProgress,
  topicProgress,
  totalProgress,
  findNextIncomplete,
  formatRootMessage,
  formatTopicMessage,
  buildRootKeyboard,
  buildTopicKeyboard,
  topicMaterials,
} = roadmap;

describe('roadmap-data — вміст', () => {
  it('жоден id (тем чи підпунктів) не містить ":" (парситься з callback_data) чи "." (progressKey)', () => {
    for (const topic of ROADMAP_TOPICS) {
      expect(topic.id).not.toContain(':');
      expect(topic.id).not.toContain('.');
      for (const sub of topic.subtopics) {
        expect(sub.id).not.toContain(':');
        expect(sub.id).not.toContain('.');
      }
    }
  });

  it('усі topicId.subtopicId (progressKey) унікальні — жодних колізій прогресу', () => {
    const keys = new Set();
    for (const topic of ROADMAP_TOPICS) {
      for (const sub of topic.subtopics) {
        const key = `${topic.id}.${sub.id}`;
        expect(keys.has(key)).toBe(false);
        keys.add(key);
      }
    }
  });

  it('щонайменше кілька тем із підпунктами (не порожньо)', () => {
    expect(ROADMAP_TOPICS.length).toBeGreaterThan(0);
    for (const topic of ROADMAP_TOPICS) {
      expect(topic.subtopics.length).toBeGreaterThan(0);
    }
  });
});

describe('findTopic / findSubtopic', () => {
  it('відомий topicId -> обʼєкт, невідомий -> null', () => {
    const first = ROADMAP_TOPICS[0];
    expect(findTopic(first.id)).toBe(first);
    expect(findTopic('немає-такого')).toBeNull();
  });

  it('відомий subtopicId у темі -> обʼєкт, невідомий -> null', () => {
    const first = ROADMAP_TOPICS[0];
    const sub = first.subtopics[0];
    expect(findSubtopic(first, sub.id)).toBe(sub);
    expect(findSubtopic(first, 'немає-такого')).toBeNull();
  });

  it('тема null -> null (без винятку)', () => {
    expect(findSubtopic(null, 'будь-що')).toBeNull();
  });
});

describe('callback_data кодек (rd:)', () => {
  it('root round-trip', () => {
    expect(parseRoadmapCallbackData(buildRootCallbackData())).toEqual({ kind: 'root' });
  });

  it('topic round-trip', () => {
    expect(parseRoadmapCallbackData(buildTopicCallbackData('frontend'))).toEqual({
      kind: 'topic',
      topicId: 'frontend',
    });
  });

  it('toggle round-trip', () => {
    expect(parseRoadmapCallbackData(buildToggleCallbackData('frontend', 'html-semantics'))).toEqual(
      {
        kind: 'toggle',
        topicId: 'frontend',
        subtopicId: 'html-semantics',
      },
    );
  });

  it('малформат/чужий префікс/відсутні частини -> null', () => {
    expect(parseRoadmapCallbackData('pd:a:id')).toBeNull();
    expect(parseRoadmapCallbackData(`${ROADMAP_CB_PREFIX}t:`)).toBeNull();
    expect(parseRoadmapCallbackData(`${ROADMAP_CB_PREFIX}s:frontend:`)).toBeNull();
    expect(parseRoadmapCallbackData(`${ROADMAP_CB_PREFIX}x`)).toBeNull();
    expect(parseRoadmapCallbackData(null)).toBeNull();
    // Порожній rest і відсутній сегмент ':topicId' цілком (не лише порожній) —
    // resolveRoadmapCallback довіряє формі виводу без додаткової валідації.
    expect(parseRoadmapCallbackData(ROADMAP_CB_PREFIX)).toBeNull();
    expect(parseRoadmapCallbackData(`${ROADMAP_CB_PREFIX}t`)).toBeNull();
  });

  it('build дотримує 64-байтовий ліміт (кирилиця=2 байти)', () => {
    expect(buildTopicCallbackData('frontend')).toBe('rd:t:frontend');
    expect(buildTopicCallbackData('я'.repeat(40))).toBeNull();
    expect(buildToggleCallbackData('я'.repeat(20), 'я'.repeat(20))).toBeNull();
  });
});

describe('toggleProgress — справжній туди-сюди', () => {
  it('додає якщо нема, прибирає якщо є', () => {
    const t1 = toggleProgress({}, 'frontend', 'html-semantics', '2026-07-11T00:00:00.000Z');
    expect(t1).toEqual({ 'frontend.html-semantics': '2026-07-11T00:00:00.000Z' });
    const t2 = toggleProgress(t1, 'frontend', 'html-semantics', '2026-07-12T00:00:00.000Z');
    expect(t2).toEqual({});
  });

  it('не мутує вхідний обʼєкт', () => {
    const orig = {};
    toggleProgress(orig, 'frontend', 'html-semantics', '2026-07-11T00:00:00.000Z');
    expect(orig).toEqual({});
  });
});

describe('topicProgress / totalProgress', () => {
  it('рахунок збігається з реальною формою ROADMAP_TOPICS', () => {
    const { done, total } = totalProgress({});
    expect(done).toBe(0);
    const expectedTotal = ROADMAP_TOPICS.reduce(
      (sum: number, t: { subtopics: unknown[] }) => sum + t.subtopics.length,
      0,
    );
    expect(total).toBe(expectedTotal);
  });

  it('topicProgress рахує лише свою тему', () => {
    const first = ROADMAP_TOPICS[0];
    const key = progressKey(first.id, first.subtopics[0].id);
    const { done, total } = topicProgress({ [key]: '2026-07-11T00:00:00.000Z' }, first);
    expect(done).toBe(1);
    expect(total).toBe(first.subtopics.length);
  });
});

describe('findNextIncomplete', () => {
  it('перший підпункт першої теми, коли все порожньо', () => {
    const first = ROADMAP_TOPICS[0];
    expect(findNextIncomplete({})).toEqual({
      topicId: first.id,
      subtopicId: first.subtopics[0].id,
    });
  });

  it('усе зроблено -> null', () => {
    const progress: Record<string, string> = {};
    for (const topic of ROADMAP_TOPICS) {
      for (const sub of topic.subtopics) {
        progress[progressKey(topic.id, sub.id)] = '2026-07-11T00:00:00.000Z';
      }
    }
    expect(findNextIncomplete(progress)).toBeNull();
  });
});

describe('formatRootMessage / formatTopicMessage — HTML-escape регресія', () => {
  it('formatTopicMessage екранує назву теми', () => {
    const evil = {
      id: 'x',
      title: '<script>alert(1)</script>',
      subtopics: [{ id: 'a', title: 'A' }],
    };
    const msg = formatTopicMessage(evil, {});
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
  });

  it('formatRootMessage містить рахунок і заголовок', () => {
    const msg = formatRootMessage({});
    expect(msg).toContain('0/');
    expect(msg).toContain('IT-роадмеп');
  });

  it('formatRootMessage/formatTopicMessage містять прогрес-бар (Фаза B4)', () => {
    const evil = {
      id: 'x',
      title: 'X',
      subtopics: [{ id: 'a', title: 'A' }],
    };
    // порожній прогрес, total>0 -> бар усіх ░ у <code>[..]</code> присутній
    expect(formatRootMessage({})).toMatch(/<code>\[[█░]{10}\]<\/code> 0\//);
    expect(formatTopicMessage(evil, {})).toMatch(/<code>\[[█░]{10}\]<\/code> 0\/1/);
  });
});

describe('buildRootKeyboard / buildTopicKeyboard', () => {
  it('root: рядок на тему з правильним callback_data + «Наступний»', () => {
    const kb = buildRootKeyboard({});
    expect(kb.inline_keyboard).toHaveLength(ROADMAP_TOPICS.length + 1); // + «Наступний»
    expect(kb.inline_keyboard[0][0].callback_data).toBe(
      buildTopicCallbackData(ROADMAP_TOPICS[0].id),
    );
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow[0].text).toBe('▶️ Наступний');
  });

  it('усе зроблено -> без рядка «Наступний»', () => {
    const progress: Record<string, string> = {};
    for (const topic of ROADMAP_TOPICS) {
      for (const sub of topic.subtopics) {
        progress[progressKey(topic.id, sub.id)] = '2026-07-11T00:00:00.000Z';
      }
    }
    const kb = buildRootKeyboard(progress);
    expect(kb.inline_keyboard).toHaveLength(ROADMAP_TOPICS.length);
  });

  it('topic: рядок на підпункт + «Назад» останнім', () => {
    const first = ROADMAP_TOPICS[0];
    const kb = buildTopicKeyboard(first, {});
    // підпункти + матеріали (F5) + «Назад»
    expect(kb.inline_keyboard).toHaveLength(first.subtopics.length + first.materials.length + 1);
    expect(kb.inline_keyboard[0][0].text).toContain('▫️');
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow[0]).toEqual({ text: '⬅️ Назад', callback_data: buildRootCallbackData() });
  });

  it('позначений підпункт -> ✅ замість ▫️', () => {
    const first = ROADMAP_TOPICS[0];
    const key = progressKey(first.id, first.subtopics[0].id);
    const kb = buildTopicKeyboard(first, { [key]: '2026-07-11T00:00:00.000Z' });
    expect(kb.inline_keyboard[0][0].text).toContain('✅');
  });
});

describe('roadmap — матеріали тем (F5)', () => {
  it('кожна тема має курований матеріал', () => {
    for (const t of ROADMAP_TOPICS) {
      expect(topicMaterials(t).length, `тема ${t.id}`).toBeGreaterThan(0);
    }
  });

  it('усі посилання — https і з назвою', () => {
    for (const t of ROADMAP_TOPICS) {
      for (const m of t.materials) {
        expect(m.url, `${t.id}: ${m.title}`).toMatch(/^https:\/\//);
        expect(m.title.trim().length, `${t.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('матеріали стають URL-кнопками в клавіатурі теми', () => {
    const topic = ROADMAP_TOPICS[0];
    const rows = buildTopicKeyboard(topic, {}).inline_keyboard;
    const urlBtns = rows.flat().filter((b: Record<string, unknown>) => 'url' in b);
    expect(urlBtns).toHaveLength(topic.materials.length);
    expect(urlBtns[0].text).toContain(topic.materials[0].title);
    expect(urlBtns[0].url).toBe(topic.materials[0].url);
    // «Назад» лишається ОСТАННІМ рядком — матеріали не мають його відсунути.
    expect(rows.at(-1)[0].callback_data).toBe('rd:r');
  });

  it('битий матеріал відкидається, а не валить sendMessage', () => {
    // Telegram відхиляє ВСЕ повідомлення, якщо url-кнопка невалідна, тож
    // фільтр тут боронить не косметику, а доставку.
    const bad = {
      id: 'x',
      title: 'X',
      subtopics: [],
      materials: [
        { title: 'ok', url: 'https://example.com/' },
        { title: 'js-схема', url: 'javascript:alert(1)' },
        { title: 'без протоколу', url: 'example.com' },
        { title: 'http', url: 'http://example.com/' },
        { title: 'без url' },
        null,
      ],
    };
    expect(topicMaterials(bad).map((m: { title: string }) => m.title)).toEqual(['ok']);
  });

  it('тема без materials не ламає клавіатуру', () => {
    const t = { id: 'x', title: 'X', subtopics: [{ id: 's', title: 'S' }] };
    const rows = buildTopicKeyboard(t, {}).inline_keyboard;
    expect(rows.flat().some((b: Record<string, unknown>) => 'url' in b)).toBe(false);
    expect(rows.at(-1)[0].callback_data).toBe('rd:r');
  });
});
