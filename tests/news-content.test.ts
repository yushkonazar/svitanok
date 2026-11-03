import { expect, it } from 'vitest';
import {
  canonicalNewsText,
  newsContext,
  safeNewsImage,
  newsSourceExcerpt,
} from '../web/core/brief/news-content.mjs';
import { parseNewsFeed } from '../web/core/brief/news-snapshot.mjs';
it('extracts NASA prose and removes publisher menus, recurring introductions and newsletter calls', () => {
  const html =
    '<nav>Today’s APOD Archive Search Calendar</nav><p class="label">APOD</p><p class="heading-22">Astronomy Picture of the Day</p><p class="media-detail-hero__subtext">Discover the cosmos! Each day a different image appears.</p><p class="media-detail-hero__description"><strong>Explanation:</strong> This meteor did not come from that comet. Their trajectories differ.</p><p>Sign up for the Breaking News email</p>';
  expect(newsSourceExcerpt(html)).toBe(
    'This meteor did not come from that comet. Their trajectories differ.',
  );
});
it('omits repeated headlines and publisher boilerplate but retains extra source facts', () => {
  expect(
    newsContext(
      'Уряд ухвалив рішення',
      'Уряд ухвалив рішення. Читайте більше на сайті. Нові правила почнуть діяти з 1 грудня.',
    ),
  ).toBe('Нові правила почнуть діяти з 1 грудня.');
  expect(newsContext('Уряд ухвалив рішення', 'Уряд ухвалив рішення.')).toBe('');
});
it('retains a specific number or negation even in a short source sentence', () => {
  expect(newsContext('Виплати продовжено', 'Виплати продовжено на 30 днів.')).toBe(
    'Виплати продовжено на 30 днів.',
  );
  expect(newsContext('Рішення ухвалено', 'Рішення не ухвалено.')).toBe('Рішення не ухвалено.');
});
it('normalizes presentation while preserving numbers, signs and negation', () => {
  expect(canonicalNewsText('  РІШЕННЯ: «12,5%»! ')).toBe(canonicalNewsText('рішення 12.5%'));
  expect(canonicalNewsText('Виплати 50')).not.toBe(canonicalNewsText('Виплати 60'));
  expect(canonicalNewsText('Рішення не ухвалено')).not.toBe(canonicalNewsText('Рішення ухвалено'));
});
it('uses richer RSS content, discards embedded executable text and keeps only publisher images', () => {
  const xml =
    '<item><title>Рішення ухвалено</title><link>https://suspilne.media/a</link><pubDate>2026-11-03T10:00:00Z</pubDate><description>Рішення ухвалено.</description><content:encoded><![CDATA[<p>Рішення ухвалено.</p><script>steal secrets</script><p>Нові правила почнуть діяти з 1 грудня.</p><img src="https://cdn4.suspilne.media/photo.jpg"/>]]></content:encoded></item>';
  expect(parseNewsFeed(xml, Date.parse('2026-11-03T12:00:00Z'))[0]).toMatchObject({
    excerpt: 'Нові правила почнуть діяти з 1 грудня.',
    image: 'https://cdn4.suspilne.media/photo.jpg',
  });
  expect(parseNewsFeed(xml, Date.parse('2026-11-03T12:00:00Z'))[0]?.sourceExcerpt).not.toContain(
    'steal',
  );
});
it('never expands the image proxy to arbitrary hosts, ports or credentials', () => {
  for (const url of [
    'https://cdn4.suspilne.media/a.jpg',
    'https://s.dou.ua/a.jpg',
    'https://www.nasa.gov/a.jpg',
  ])
    expect(safeNewsImage(url)).toBe(url);
  for (const url of [
    'https://www.nasa.gov.evil.test/a',
    'https://127.0.0.1/a',
    'https://user@www.nasa.gov/a',
    'https://www.nasa.gov:8080/a',
  ])
    expect(safeNewsImage(url)).toBeNull();
});
