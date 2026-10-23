import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TripOfferCard, offerPrice } from './TripOfferCard.tsx';
import type { TravelOption } from '../../api/trips.ts';
import { openLink } from '../../telegram.ts';
vi.mock('../../telegram.ts', () => ({ openLink: vi.fn() }));
const option: TravelOption = {
  id: 'fixture-stay',
  kind: 'stay',
  title: 'Fixture Hotel',
  source_url: 'https://www.booking.com/hotel/cz/fixture.html',
  checked_at: '2026-10-23T09:00:00Z',
  availability: 'page_observed',
  stale: false,
  price: { amount: 280, currency: 'EUR', quantity: 1, unit: 'stay', total_confirmed: true },
  schedule: 'Довге пояснення про час заселення.',
  missing: 'Уточнити пізнє заселення.',
  highlights: ['4 гості · 2 ночі'],
  service_links: [
    {
      id: 'booking',
      label: 'Booking.com',
      url: 'https://www.booking.com/hotel/cz/fixture.html?checkin=2026-11-13&checkout=2026-11-15&group_adults=4',
      prefilled: true,
    },
  ],
};
describe('compact travel offers', () => {
  it('shows full stay price and keeps long explanations behind details', async () => {
    const user = userEvent.setup();
    render(
      <TripOfferCard
        option={option}
        selected={false}
        disabled={false}
        running={false}
        onChoose={vi.fn()}
        onMap={vi.fn()}
      />,
    );
    expect(screen.getByText('280 EUR')).toBeVisible();
    expect(screen.getByText('за весь період і групу')).toBeVisible();
    expect(screen.getByText(option.schedule!)).not.toBeVisible();
    await user.click(screen.getByText('Деталі й умови'));
    expect(screen.getByText(option.schedule!)).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'На Booking ↗' }));
    expect(openLink).toHaveBeenCalledWith(option.service_links![0].url);
  });
  it('opening a map does not select or book the offer', async () => {
    const user = userEvent.setup(),
      onMap = vi.fn(),
      onChoose = vi.fn();
    render(
      <TripOfferCard
        option={option}
        selected={false}
        focused
        disabled={false}
        running={false}
        onChoose={onChoose}
        onMap={onMap}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'На мапі' }));
    expect(onMap).toHaveBeenCalledOnce();
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Обрати й далі →' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
  it('distinguishes unit prices from confirmed totals and multiplies only a confirmed quantity', () => {
    const perPerson = {
      ...option,
      kind: 'transport',
      price: { amount: 90, currency: 'EUR', quantity: 2, unit: 'person', total_confirmed: false },
    };
    expect(offerPrice(perPerson)).toMatchObject({ amount: '90', total: false, label: 'за людину' });
    expect(
      offerPrice({ ...perPerson, price: { ...perPerson.price, total_confirmed: true } }),
    ).toMatchObject({ amount: '180', total: true });
    expect(offerPrice({ ...option, price: null })).toBeNull();
  });
});
