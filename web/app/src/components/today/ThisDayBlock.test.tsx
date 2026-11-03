import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { savePresentation } from '../../lib/presentation.ts';
import { afterEach, expect, it } from 'vitest';
import { ThisDayBlock } from './ThisDayBlock.tsx';
import type { OnThisDayData } from '../../api/briefing-schema.ts';

afterEach(() => {
  cleanup();
  savePresentation({ explanations: false });
  savePresentation({ calm: false });
});

it('moves the zoomed camera only when the next event is outside it, and resets the full view', () => {
  savePresentation({ calm: true });
  const events = [
    {
      year: 1000,
      text: 'Київ',
      location: {
        lat: 50,
        lon: 30,
        label: 'Київ',
        sourceUrl: 'https://example.com/1',
        kind: 'event' as const,
      },
    },
    {
      year: 1100,
      text: 'Поруч',
      location: {
        lat: 51,
        lon: 31,
        label: 'Поруч',
        sourceUrl: 'https://example.com/2',
        kind: 'event' as const,
      },
    },
    {
      year: 1200,
      text: 'Токіо',
      location: {
        lat: 35,
        lon: 139,
        label: 'Токіо',
        sourceUrl: 'https://example.com/3',
        kind: 'event' as const,
      },
    },
  ];
  const { container } = render(<ThisDayBlock d={{ events }} />);
  const map = screen.getByRole('group', { name: 'Мапа місць історичних подій' });
  const fitted = map.getAttribute('viewBox');
  fireEvent.click(screen.getByRole('button', { name: 'Наблизити мапу' }));
  const zoomed = map.getAttribute('viewBox');
  fireEvent.click(screen.getByRole('button', { name: 'Наступна історична подія' }));
  expect(map).toHaveAttribute('viewBox', zoomed);
  fireEvent.click(screen.getByRole('button', { name: 'Наступна історична подія' }));
  expect(map.getAttribute('viewBox')).not.toBe(zoomed);
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '1200: Токіо');
  expect(container.querySelector('.history-pin-pulse')).not.toBeInTheDocument();
  fireEvent.focus(screen.getByRole('slider'));
  expect(container.querySelector('.history-timeline-tooltip')).toHaveTextContent('1200');
  fireEvent.blur(screen.getByRole('slider'));
  expect(container.querySelector('.history-timeline-tooltip')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Усі події' }));
  expect(map).toHaveAttribute('viewBox', fitted);
});
const data: OnThisDayData = {
  events: [
    {
      year: 2001,
      text: 'Подія над морем',
      location: {
        lat: 42,
        lon: 37,
        label: 'Чорне море',
        sourceUrl: 'https://uk.wikipedia.org/wiki/Test',
        kind: 'associated_article',
      },
    },
    { year: 1535, text: 'Надруковано книгу' },
    {
      year: 1957,
      text: 'Запуск супутника',
      location: {
        lat: 45,
        lon: 63,
        label: 'Космодром',
        sourceUrl: 'https://uk.wikipedia.org/wiki/Launch',
        kind: 'event',
      },
    },
  ],
};

it('updates the selected description and map while dragging, including unmapped events', () => {
  render(<ThisDayBlock d={data} />);
  const slider = screen.getByRole('slider');
  expect(slider).toHaveAttribute('aria-valuetext', '1535: Надруковано книгу');
  expect(screen.getByRole('status')).toHaveTextContent('1535');
  const map = screen.getByRole('group', { name: 'Мапа місць історичних подій' });
  fireEvent.input(slider, { target: { value: '1' } });
  expect(slider).toHaveAttribute('aria-valuetext', '1957: Запуск супутника');
  expect(within(map).getByRole('button', { name: '1957: Космодром' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.change(slider, { target: { value: '2' } });
  expect(within(map).getByRole('button', { name: '2001: Чорне море' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByText(/Пов’язане місце/)).toHaveTextContent('Чорне море');
  expect(screen.queryByText(/Місце зі статті/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Попередня історична подія' }));
  fireEvent.click(screen.getByRole('button', { name: 'Попередня історична подія' }));
  expect(screen.getByRole('status')).toHaveTextContent('1535');
  fireEvent.click(screen.getByRole('button', { name: 'Наступна історична подія' }));
  expect(slider).toHaveValue('1');
});

it('filters mapped events, supports marker keyboard navigation and restores the full timeline', () => {
  render(<ThisDayBlock d={data} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Лише події з місцем' });
  fireEvent.click(checkbox);
  expect(screen.getByRole('slider')).toHaveAttribute('max', '1');
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '1957: Запуск супутника');
  fireEvent.keyDown(screen.getByRole('button', { name: '2001: Чорне море' }), { key: 'Enter' });
  expect(screen.getByRole('slider')).toHaveValue('1');
  fireEvent.click(checkbox);
  expect(screen.getByRole('slider')).toHaveAttribute('max', '2');
  expect(screen.getByRole('status')).toHaveTextContent('1535');
});

it('handles legacy briefings without coordinates and empty or refreshed data', () => {
  const { rerender } = render(<ThisDayBlock d={data} />);
  fireEvent.click(screen.getByRole('checkbox'));
  rerender(<ThisDayBlock d={{ events: [{ year: 1000, text: 'Без місця' }] }} />);
  expect(screen.getByRole('slider')).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('1000');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByText('З місцем: 0 / 1')).toBeInTheDocument();
  rerender(<ThisDayBlock d={{ events: [] }} />);
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

it('shows a verified event place without presenting its point as an exact address', () => {
  render(
    <ThisDayBlock
      d={{
        events: [
          {
            year: 1964,
            text: 'у Токіо почалися XVIII Олімпійські ігри.',
            location: {
              lat: 35.689444,
              lon: 139.691667,
              label: 'Токіо',
              sourceUrl: 'https://www.wikidata.org/wiki/Q1490',
              kind: 'event_place',
            },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('button', { name: '1964: Токіо' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  act(() => savePresentation({ explanations: true }));
  expect(screen.getByText(/Місце проведення — Токіо/)).toHaveTextContent(
    'не обов’язково точну адресу',
  );
});
