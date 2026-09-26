import { describe, expect, it } from 'vitest';
import { PROFILES } from '../brain/src/profiles.js';
import { routeChatTools } from '../brain/src/tool-routing.js';

describe('interactive tool routing', () => {
  const all = PROFILES.chat.toolNames;

  it('does not send a tool catalogue for a greeting', () => {
    expect(routeChatTools('Привіт!', all)).toEqual([]);
  });

  it('limits a calendar request to the calendar and plan surface', () => {
    const tools = routeChatTools('Що в мене в календарі завтра?', all);
    expect(tools).toContain('calendar_read');
    expect(tools).toContain('plan_draft');
    expect(tools).not.toContain('mail_read');
    expect(tools.length).toBeLessThan(all.length);
  });

  it('keeps the mail secretary available for a mail draft without exposing the full catalogue', () => {
    const tools = routeChatTools('Переглянь листи та склади чернетку відповіді', all);
    expect(tools).toEqual(expect.arrayContaining(['mail_search', 'mail_read', 'delegate']));
    expect(tools).not.toContain('calendar_read');
    expect(tools.length).toBeLessThan(all.length);
  });

  it('keeps owner style samples and the reviewed style-collection proposal available for writing', () => {
    const write = routeChatTools('Напиши пост моїм голосом', all);
    expect(write).toEqual(expect.arrayContaining(['style_samples', 'delegate']));
    expect(write).not.toContain('calendar_read');

    const collect = routeChatTools('Збери мій стиль', all);
    expect(collect).toEqual(expect.arrayContaining(['style_samples', 'proposals_create']));
    expect(collect).not.toContain('calendar_read');
  });

  it('keeps the tool surface complete for documented assistant scenarios', () => {
    expect(routeChatTools('Склади план на день', all)).toEqual(
      expect.arrayContaining(['plan_intent', 'plan_review']),
    );
    expect(routeChatTools('Увімкни план дня лише пн-пт', all)).toEqual(
      expect.arrayContaining(['facts_get', 'facts_set']),
    );
    expect(routeChatTools('Куди пішли гроші за місяць?', all)).toEqual(
      expect.arrayContaining(['finance_query', 'delegate']),
    );
    expect(routeChatTools('Постав задачу купити молоко', all)).toContain('proposals_create');
    expect(routeChatTools('Нотатка: підготувати презентацію', all)).toContain('proposals_create');
    expect(routeChatTools('Намалюй світанок над Києвом', all)).toContain('proposals_create');
    expect(routeChatTools('Що в моєму CV про Cloudflare?', all)).toContain('knowledge_search');
    expect(routeChatTools('Покажи базу знань', all)).toEqual(
      expect.arrayContaining(['knowledge_list', 'knowledge_revoke', 'knowledge_delete']),
    );
  });

  it('keeps a deliberate multi-domain request complete rather than silently omitting tools', () => {
    expect(routeChatTools('Перевір пошту, а потім додай зустріч у календар', all)).toEqual(all);
  });

  it('never grants a name outside of the reviewed profile allowlist', () => {
    const limited = ['calendar_read', 'memory_search'];
    const tools = routeChatTools('Знайди файл на Google Drive', limited);
    expect(tools.every((tool) => limited.includes(tool))).toBe(true);
  });
});
