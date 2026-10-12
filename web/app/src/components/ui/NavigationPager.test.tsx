import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NavigationPager } from './NavigationPager.tsx';

const tabs = ['Сьогодні', 'Новини', 'Чек-ін', 'Мій стан', 'Фінанси', 'Дозвілля'].map(
  (label, i) => ({ id: String(i), label, path: `/${i}` }),
);
describe('paged bottom navigation', () => {
  it('keeps the current screen on a horizontal swipe and only navigates on a tap', () => {
    const navigate = vi.fn();
    render(
      <NavigationPager
        tabs={tabs}
        activePath="/2"
        hidden={false}
        onNavigate={navigate}
        icon={() => null}
      />,
    );
    const bar = screen.getByRole('navigation');
    fireEvent.touchStart(bar.firstElementChild!, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(bar.firstElementChild!, {
      changedTouches: [{ clientX: 100, clientY: 102 }],
    });
    expect(screen.getByRole('button', { name: 'Дозвілля' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Дозвілля' }));
    expect(navigate).toHaveBeenCalledWith('/5');
  });
  it('preserves vertical scrolling and exposes accessible paging controls', () => {
    const navigate = vi.fn();
    render(
      <NavigationPager
        tabs={tabs}
        activePath="/0"
        hidden={false}
        onNavigate={navigate}
        icon={() => null}
      />,
    );
    const bar = screen.getByRole('navigation').firstElementChild!;
    fireEvent.touchStart(bar, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(bar, { changedTouches: [{ clientX: 99, clientY: 250 }] });
    expect(screen.getByRole('button', { name: 'Сьогодні' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Наступні розділи' }));
    expect(screen.getByRole('button', { name: 'Дозвілля' })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('selects the appropriate navigation page after a deep link without inserting fake tabs', () => {
    const props = { tabs, hidden: false, onNavigate: vi.fn(), icon: () => null };
    const { rerender } = render(<NavigationPager {...props} activePath="/0" />);
    rerender(<NavigationPager {...props} activePath="/5" />);
    expect(screen.getByRole('button', { name: 'Дозвілля' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('button', { name: 'Сьогодні' })).not.toBeInTheDocument();
  });
});
