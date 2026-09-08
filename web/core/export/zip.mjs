// Мінімальний ZIP-письменник для Workers (етап 7 PR-4, S-0-6).
//
// ⚠️ ЧОМУ САМЕ ЧЕРЕЗ CompressionStream('gzip'). ZIP вимагає CRC-32 кожного
// запису, а рахувати його циклом у JS - найдорожча операція всього експорту:
// на Workers Free бюджет 10 мс CPU на виклик (межа, названа на етапі 6), і
// пара мегабайтів у JS-циклі його зʼїдає. Але gzip-потік уже НЕСЕ той самий
// CRC-32 у своєму трейлері й уже стискає нативно. Тож ми беремо в нього і
// стиснуті байти (метод 8 - deflate), і CRC, і довжину оригіналу, знявши
// gzip-обгортку: 18 байтів заголовка з хвостом замість мегабайтного циклу.
//
// Формат - класичний ZIP (не ZIP64): по одному локальному заголовку на файл,
// центральний каталог і EOCD у кінці. Стелі ZIP64 (4 ГБ, 65 535 файлів) для
// експорту особистої бази недосяжні; вихід за них - явна помилка, не тихий
// зіпсований архів.

/** @typedef {{ name: string, bytes: Uint8Array }} ZipInput */

/** Стеля, за якою починається ZIP64 - далі формат ламається мовчки. */
const MAX_SIZE = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/**
 * Зняти gzip-обгортку: віддає сирий deflate, CRC-32 і довжину оригіналу.
 * Заголовок розбирається за прапорцями (а не «завжди 10 байтів»): реалізації
 * можуть додати імʼя файла чи коментар, і тоді фіксоване число зіпсувало б
 * кожен архів.
 * @param {Uint8Array} gz
 * @returns {{ deflate: Uint8Array, crc: number, size: number }}
 */
export function unwrapGzip(gz) {
  if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08) {
    throw new Error('zip: несподіваний gzip-заголовок');
  }
  const flg = /** @type {number} */ (gz[3]);
  let at = 10;
  if (flg & 0x04) {
    // FEXTRA: два байти довжини, далі дані.
    const xlen = (gz[at] ?? 0) | ((gz[at + 1] ?? 0) << 8);
    at += 2 + xlen;
  }
  if (flg & 0x08) while (gz[at++] !== 0); // FNAME
  if (flg & 0x10) while (gz[at++] !== 0); // FCOMMENT
  if (flg & 0x02) at += 2; // FHCRC
  const view = new DataView(gz.buffer, gz.byteOffset, gz.byteLength);
  const crc = view.getUint32(gz.length - 8, true);
  const size = view.getUint32(gz.length - 4, true);
  return { deflate: gz.subarray(at, gz.length - 8), crc, size };
}

/** Стиснути байти нативним gzip. @param {Uint8Array} bytes */
async function gzipBytes(bytes) {
  const stream = new Response(bytes).body?.pipeThrough(new CompressionStream('gzip'));
  if (!stream) throw new Error('zip: CompressionStream недоступний');
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Зібрати ZIP із переліку файлів.
 * @param {ZipInput[]} files
 * @param {{ dateMs?: number }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function buildZip(files, opts = {}) {
  if (files.length > MAX_ENTRIES) throw new Error(`zip: понад ${MAX_ENTRIES} файлів`);
  const { time, date } = dosDateTime(opts.dateMs ?? Date.now());
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {{ name: Uint8Array, crc: number, csize: number, usize: number, offset: number }[]} */
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const { deflate, crc, size } = unwrapGzip(await gzipBytes(file.bytes));
    if (size !== file.bytes.length) throw new Error(`zip: розмір ${file.name} не збігся`);
    if (deflate.length > MAX_SIZE || size > MAX_SIZE) throw new Error(`zip: ${file.name} > 4 ГБ`);
    const header = new Uint8Array(30 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true); // PK\x03\x04
    hv.setUint16(4, 20, true); // версія
    hv.setUint16(6, 0x0800, true); // прапорець «імена в UTF-8»
    hv.setUint16(8, 8, true); // метод: deflate
    hv.setUint16(10, time, true);
    hv.setUint16(12, date, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, deflate.length, true);
    hv.setUint32(22, size, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true); // extra
    header.set(name, 30);
    chunks.push(header, deflate);
    central.push({ name, crc, csize: deflate.length, usize: size, offset });
    offset += header.length + deflate.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const rec = new Uint8Array(46 + e.name.length);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x02014b50, true); // PK\x01\x02
    rv.setUint16(4, 20, true); // ким створено
    rv.setUint16(6, 20, true); // яка версія потрібна
    rv.setUint16(8, 0x0800, true);
    rv.setUint16(10, 8, true);
    rv.setUint16(12, time, true);
    rv.setUint16(14, date, true);
    rv.setUint32(16, e.crc, true);
    rv.setUint32(20, e.csize, true);
    rv.setUint32(24, e.usize, true);
    rv.setUint16(28, e.name.length, true);
    // Зміщення локального заголовка - саме за ним архіватор знаходить файл;
    // без нього архів «порожній» усюди, крім послідовного читання.
    rv.setUint32(42, e.offset, true);
    rec.set(e.name, 46);
    chunks.push(rec);
    offset += rec.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // PK\x05\x06
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, offset - cdStart, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** MS-DOS час/дата (ZIP не знає інших). @param {number} ms */
function dosDateTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
