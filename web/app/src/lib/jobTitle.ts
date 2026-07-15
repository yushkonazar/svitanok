// Заголовок вакансії з фолбеком на «голе» посилання (роадмеп v3, E3/D5) —
// hostname (без www.) + шлях, коли title порожній. 1:1 з vanilla prettyJobTitle
// (index.html:2407-2416).

export function prettyJobTitle(url: string, title: string): string {
  if (title && title.trim()) return title;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname;
  } catch {
    return url;
  }
}
