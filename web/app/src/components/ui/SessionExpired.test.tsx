import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExpired } from './SessionExpired.tsx';

const telegram = vi.hoisted(() => ({ closeApp: vi.fn(), haptic: vi.fn() }));

vi.mock('../../telegram.ts', () => telegram);

beforeEach(() => {
  telegram.closeApp.mockClear();
  telegram.haptic.mockClear();
});

describe('SessionExpired', () => {
  it('блокує персональний UI і повертає власника до Telegram-чату', async () => {
    const user = userEvent.setup();
    render(<SessionExpired />);
    expect(screen.getByRole('alert')).toHaveTextContent('Дані не показано');
    expect(screen.getByRole('heading', { name: 'Сесію завершено' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Повернутися в чат' }));
    expect(telegram.haptic).toHaveBeenCalledWith('light');
    expect(telegram.closeApp).toHaveBeenCalledOnce();
  });
});
