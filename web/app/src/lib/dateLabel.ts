// Компактна дата (дизайн v2): «ЧТ · 16 ЛИП» — формат 1:1 з макетом.
// ВАЖЛИВО: показуємо дату БРИФІНГУ (generatedAt), а не годинник пристрою —
// інакше вчорашній брифінг (крон не спрацював) виглядав би сьогоднішнім.

const WD = ['НД', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
const MN = ['СІЧ', 'ЛЮТ', 'БЕР', 'КВІ', 'ТРА', 'ЧЕР', 'ЛИП', 'СЕР', 'ВЕР', 'ЖОВ', 'ЛИС', 'ГРУ'];

export function dateLabel(d: Date = new Date()): string {
  return `${WD[d.getDay()]} · ${d.getDate()} ${MN[d.getMonth()]}`;
}

/** ISO-рядок брифінгу → «ЧТ · 16 ЛИП»; null, якщо порожній/битий. */
export function dateLabelFromIso(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateLabel(d);
}

/** ISO-рядок брифінгу → «16.07» (підпис курсу); null, якщо порожній/битий. */
export function shortDateFromIso(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}
