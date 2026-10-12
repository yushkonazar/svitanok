// Read Nuxt/devalue's literal serialization, never eval/Function or execute source JS.
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
/** @param {string} source @param {Record<string,any>} [bindings] */
function literals(source, bindings = {}) {
  let at = 0,
    tokens = 0;
  const identifierToken = /[A-Za-z_$][\w$]*/y,
    numberToken = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/iy;
  const whitespace = () => {
    while (/\s/.test(source[at] ?? '') && at < source.length) at++;
  };
  /** @param {string} expected */
  const take = (expected) => {
    whitespace();
    if (!source.startsWith(expected, at)) throw new Error('non-literal-data');
    at += expected.length;
  };
  const identifier = () => {
    whitespace();
    identifierToken.lastIndex = at;
    const match = identifierToken.exec(source);
    if (!match) throw new Error('non-literal-identifier');
    at += match[0].length;
    return match[0];
  };
  /** @param {number} [depth] @returns {any} */
  function value(depth = 0) {
    whitespace();
    if (depth > 80 || ++tokens > 150000) throw new Error('literal-limit');
    if (source[at] === '"') {
      const start = at++;
      while (at < source.length) {
        const char = source[at++];
        if (char === '\\') {
          at++;
          continue;
        }
        if (char === '"') return JSON.parse(source.slice(start, at));
      }
      throw new Error('literal-string');
    }
    if (source[at] === '{') {
      at++;
      const result = Object.create(null);
      whitespace();
      while (source[at] !== '}') {
        const key = source[at] === '"' ? value(depth + 1) : identifier();
        if (UNSAFE_KEYS.has(key)) throw new Error('literal-unsafe-key');
        take(':');
        result[key] = value(depth + 1);
        whitespace();
        if (source[at] !== ',') break;
        at++;
      }
      take('}');
      return result;
    }
    if (source[at] === '[') {
      at++;
      const result = [];
      whitespace();
      while (source[at] !== ']') {
        result.push(value(depth + 1));
        whitespace();
        if (source[at] !== ',') break;
        at++;
      }
      take(']');
      return result;
    }
    numberToken.lastIndex = at;
    const number = numberToken.exec(source);
    if (number) {
      at += number[0].length;
      const n = Number(number[0]);
      if (!Number.isFinite(n)) throw new Error('literal-number');
      return n;
    }
    const key = identifier();
    if (key === 'true') return true;
    if (key === 'false') return false;
    if (key === 'null' || key === 'undefined') return null;
    if (key === 'void') {
      take('0');
      return null;
    }
    if (!Object.hasOwn(bindings, key)) throw new Error('unknown-literal-binding');
    return bindings[key];
  }
  return { value, take, identifier, whitespace, position: () => at, source };
}
/** @param {string} source @param {number} start */
function closingBrace(source, start) {
  let level = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === '{') level++;
    if (c === '}' && --level === 0) return i;
  }
  throw new Error('unclosed-literal-body');
}
/** @param {string} html @returns {any|null} */
export function parseNuxtData(html) {
  if (html.length > 2_000_000) return null;
  try {
    const header = /window\.__NUXT__=\(function\(([^)]*)\)\{/.exec(html);
    if (!header) return null;
    const params = header[1]?.split(',') ?? [],
      start = header.index + header[0].length,
      end = closingBrace(html, start - 1);
    const tail = html.slice(end + 1),
      invocation = /^\)?\(/.exec(tail);
    if (!invocation) return null;
    const argsReader = literals(tail.slice(invocation[0].length));
    /** @type {any[]} */ const args = [];
    while (true) {
      argsReader.whitespace();
      if (argsReader.source[argsReader.position()] === ')') break;
      args.push(argsReader.value());
      argsReader.whitespace();
      if (argsReader.source[argsReader.position()] !== ',') break;
      argsReader.take(',');
    }
    if (args.length !== params.length) return null;
    const bindings = Object.create(null);
    params.forEach((key, i) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) throw new Error('invalid-binding');
      bindings[key] = args[i];
    });
    const body = html.slice(start, end),
      reader = literals(body, bindings);
    while (reader.position() < body.length) {
      reader.whitespace();
      if (body.startsWith('return', reader.position())) {
        reader.take('return');
        const result = reader.value();
        reader.whitespace();
        if (body[reader.position()] === ';') {
          reader.take(';');
          reader.whitespace();
        }
        if (reader.position() !== body.length) throw new Error('non-literal-return');
        return result;
      }
      const name = reader.identifier();
      if (!Object.hasOwn(bindings, name)) throw new Error('assignment-binding');
      reader.take('.');
      const key = reader.identifier();
      if (UNSAFE_KEYS.has(key)) throw new Error('assignment-key');
      reader.take('=');
      const next = reader.value();
      reader.take(';');
      const object = bindings[name];
      if (!object || typeof object !== 'object') throw new Error('assignment-target');
      object[key] = next;
    }
  } catch {
    /* Unknown serialization is unavailable, not executable JavaScript. */
  }
  return null;
}
