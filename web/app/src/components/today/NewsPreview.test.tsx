import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NewsPreview } from './NewsPreview.tsx';
vi.mock('../../api/hooks.ts', () => ({
  useBriefing: () => ({ data: { demo: true } }),
  useSettings: () => ({ data: undefined }),
  useNewsSnapshot: () => ({
    data: {
      groups: [
        {
          scope: 'world',
          topic: 'Головне',
          more: [],
          items: [
            {
              title: 'Перша подія',
              url: 'https://www.bbc.com/news/first',
              rank: 1,
              image: 'https://example.com/image.jpg',
            },
            { title: 'Друга подія', url: 'https://www.bbc.com/news/second', rank: 2 },
          ],
        },
      ],
    },
  }),
}));
afterEach(cleanup);
it('removes the entire artwork area when a publisher image fails', () => {
  const { container } = render(
    <MemoryRouter>
      <NewsPreview />
    </MemoryRouter>,
  );
  expect(container.querySelector('.today-news-art')).not.toBeNull();
  fireEvent.error(container.querySelector('img')!);
  expect(container.querySelector('.today-news-art')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Перша подія' })).toBeInTheDocument();
});
it('lets the reader switch stories and opens the selected article directly', () => {
  render(
    <MemoryRouter>
      <NewsPreview />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Попередня новина' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Наступна новина' }));
  expect(screen.getByRole('link', { name: /Друга подія/ })).toHaveAttribute(
    'href',
    '/news?article=https%3A%2F%2Fwww.bbc.com%2Fnews%2Fsecond',
  );
  expect(screen.getByRole('button', { name: 'Наступна новина' })).toBeDisabled();
});
