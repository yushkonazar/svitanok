// Джерело новини за хостом url (редизайн новин) — не нове поле бекенда, а
// клієнтська деривація, той самий ідіом, що вже є для вакансій: hostOf(url)
// у jobTitle.ts. Власник свідомо обирає конкретні видання (BBC/Guardian/ТСН/
// dotesports/HLTV), тож короткий куратований лейбл читається краще за сирий
// хостнейм — але для розмаїття джерел NewsData (де хост непередбачуваний)
// підчищений хостнейм лишається чесним фолбеком.

const LABELS: [RegExp, string][] = [
  [/bbci\.co\.uk$/i, 'BBC'],
  [/theguardian\.com$/i, 'Guardian'],
  [/tsn\.ua$/i, 'ТСН'],
  [/itc\.ua$/i, 'ITC.ua'],
  [/dotesports\.com$/i, 'Dot Esports'],
  [/hltv\.org$/i, 'HLTV'],
  [/(hnrss\.org|news\.ycombinator\.com)$/i, 'Hacker News'],
];

/** Джерело для тегу під заголовком — куратований лейбл або підчищений хостнейм. */
export function newsSource(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    for (const [re, label] of LABELS) if (re.test(host)) return label;
    return host;
  } catch {
    return '';
  }
}

/** "owner/repo" з github release URL — для реліз-тайлів (замість джерела-видання). */
export function releaseRepo(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/releases\/tag\//i.exec(url);
  return m ? `${m[1]}/${m[2]}` : newsSource(url);
}
