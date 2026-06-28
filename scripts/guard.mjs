#!/usr/bin/env node
// CI-гейт guard (§2, §19.1): запускається РАНО на системному node runner-а
// (без npm ci), читає config.yml + state.json, друкує рішення й пише його в
// $GITHUB_OUTPUT. Логіку порівняння бере з guard-core.mjs (єдине джерело).
// Значення sendHour/sendWindowHours читає з config.yml (єдине джерело значень)
// мінімальним парсером двох числових ключів — щоб не тягнути js-yaml на голий node.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideSend } from '../src/core/guard-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Прочитати два числові top-level ключі з config.yml без YAML-залежності. */
function readConfigNumbers(path) {
  const text = readFileSync(path, 'utf8');
  const num = (key) => {
    const m = text.match(new RegExp(`^${key}\\s*:\\s*(\\d+)`, 'm'));
    if (!m) throw new Error(`config.yml: не знайдено числовий ключ "${key}"`);
    return parseInt(m[1], 10);
  };
  return { sendHour: num('sendHour'), sendWindowHours: num('sendWindowHours') };
}

/** Київські todayKey + година через Intl (без залежностей, з урахуванням DST). */
function kyivParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const kyivHour = parseInt(parts.hour, 10) % 24; // "24" опівночі в деяких ICU -> 0
  return { todayKey: `${parts.year}-${parts.month}-${parts.day}`, kyivHour };
}

/** lastSentDate зі state.json; биття -> null (можливий дубль прийнятний, §8). */
function readLastSentDate(path) {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return typeof state.lastSentDate === 'string' ? state.lastSentDate : null;
  } catch {
    return null;
  }
}

const force = process.argv.includes('--force');
const { sendHour, sendWindowHours } = readConfigNumbers(join(ROOT, 'config.yml'));
const { todayKey, kyivHour } = kyivParts();
const lastSentDate = readLastSentDate(join(ROOT, 'state.json'));

const { send, reason } = decideSend({
  sendHour,
  sendWindowHours,
  kyivHour,
  todayKey,
  lastSentDate,
  force,
});

console.log(
  `[guard] send=${send} :: ${reason} ` +
    `(kyivHour=${kyivHour}, today=${todayKey}, lastSent=${lastSentDate ?? 'none'}, force=${force})`,
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `send=${send}\n`);
}

// exit 0 завжди: рішення передається через output; skip — не помилка джоби.
process.exit(0);
