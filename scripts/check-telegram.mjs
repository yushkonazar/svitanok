#!/usr/bin/env node
// Telegram-діагностика (§6, §19.3): валідність токена (getMe), пошук chat_id
// (getUpdates), тест доставки (sendMessage). Без залежностей; токен у виводі
// маскований. Рятує від класу «бот мовчить, бо chat_id не той / не натиснув Start».

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Мінімальний dependency-free .env-лоадер (process.env має пріоритет, як у CI). */
function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

loadEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

const mask = (t) =>
  !t ? '(відсутній)' : t.length <= 8 ? '***' : `${t.slice(0, 4)}…${t.slice(-4)}`;

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log(`Токен: ${mask(token)}`);
  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN відсутній. Додай у .env або GitHub Secrets.');
    process.exit(1);
  }

  // 1) getMe — валідність токена
  const me = await api('getMe');
  if (!me.json.ok) {
    console.error(`❌ getMe: HTTP ${me.status} ${JSON.stringify(me.json)} — токен невалідний?`);
    process.exit(1);
  }
  console.log(`✅ getMe: @${me.json.result.username} (id ${me.json.result.id})`);

  // 2) getUpdates — показати chat_id тих, хто писав боту
  const upd = await api('getUpdates');
  const chats = new Map();
  for (const u of upd.json.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat;
    if (chat) chats.set(chat.id, chat);
  }
  if (chats.size === 0) {
    console.log(
      'ℹ️  getUpdates порожній. Напиши боту /start і запусти знову, щоб побачити chat_id.',
    );
  } else {
    console.log('Знайдені chat_id (хто писав боту):');
    for (const c of chats.values()) {
      const who = c.title || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.type;
      console.log(`  • ${c.id}  (${c.type}${who ? `, ${who}` : ''})`);
    }
  }

  // 3) sendMessage — тест доставки на TELEGRAM_CHAT_ID
  if (!chatId) {
    console.log('ℹ️  TELEGRAM_CHAT_ID не заданий — пропускаю тест відправки. Візьми id вище.');
    return;
  }
  const sent = await api('sendMessage', {
    chat_id: chatId,
    text: '✅ Svitanok: тест доставки. Бачиш це — chat_id правильний.',
  });
  if (sent.json.ok) {
    console.log(`✅ sendMessage у ${chatId}: доставлено.`);
  } else {
    console.error(`❌ sendMessage у ${chatId}: HTTP ${sent.status} ${JSON.stringify(sent.json)}`);
    console.error(
      '   400 = невірний chat_id / не починав чат; 403 = заблокував / не натиснув Start.',
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌ Несподівана помилка:', e.message);
  process.exit(1);
});
