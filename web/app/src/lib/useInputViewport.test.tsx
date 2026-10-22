import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useInputViewport } from './useInputViewport.ts';
import { NavigationPager } from '../components/ui/NavigationPager.tsx';

const { host } = vi.hoisted(() => ({
  host: { platform: '', viewportHeight: 0, onEvent: vi.fn(), offEvent: vi.fn() },
}));
vi.mock('../telegram.ts', () => ({ tg: host, haptic: vi.fn() }));

let visual: EventTarget & { height: number; offsetTop: number; scale: number };
let coarse: boolean, layoutHeight: number;
const flush = () =>
  act(() => {
    vi.advanceTimersByTime(10);
  });
const rect = (top: number, bottom: number) => ({
  top,
  bottom,
  height: bottom - top,
  left: 0,
  right: 300,
  width: 300,
  x: 0,
  y: top,
  toJSON: () => ({}),
});
function Harness({ showForm = true }: { showForm?: boolean }) {
  const view = useInputViewport();
  return (
    <>
      <output data-testid="inset">{view.inset}</output>
      {showForm && (
        <form data-input-viewport-group>
          <label>
            Місто
            <input defaultValue="Прага" />
          </label>
          <button type="button">Далі</button>
        </form>
      )}
      <label>
        Нотатка
        <textarea />
      </label>
      <label>
        Позначка
        <input type="checkbox" />
      </label>
      <label>
        Лише читання
        <input readOnly />
      </label>
      <NavigationPager
        tabs={[{ id: 'trips', path: '/trips', label: 'Подорожі' }]}
        activePath="/trips"
        hidden={view.editing}
        onNavigate={vi.fn()}
        icon={() => null}
      />
    </>
  );
}
function focus(label = 'Місто') {
  const input = screen.getByLabelText(label);
  act(() => input.focus());
  flush();
  return input;
}
const nav = () => screen.getByRole('navigation', { hidden: true });
function resize(height: number, top = 0) {
  visual.height = height;
  visual.offsetTop = top;
  act(() => visual.dispatchEvent(new Event('resize')));
  flush();
}
beforeEach(() => {
  vi.useFakeTimers();
  host.platform = '';
  host.viewportHeight = 0;
  host.onEvent.mockReset();
  host.offEvent.mockReset();
  coarse = true;
  layoutHeight = 780;
  visual = Object.assign(new EventTarget(), { height: 780, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', visual);
  vi.stubGlobal('innerHeight', 780);
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: coarse })),
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 1),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(() => layoutHeight);
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
});
afterEach(() => {
  document.body.style.position = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('input visibility with a mobile keyboard', () => {
  it('hides navigation on focus, reveals the input and action above the iOS keyboard, and preserves the draft', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Місто');
    vi.spyOn(input.closest('form')!, 'getBoundingClientRect').mockReturnValue(rect(560, 700));
    focus();
    expect(nav()).toHaveAttribute('hidden');
    vi.mocked(window.scrollBy).mockClear();
    resize(360, 40);
    expect(screen.getByTestId('inset')).toHaveTextContent('380');
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 312, behavior: 'instant' });
    expect(input).toHaveValue('Прага');
    resize(780);
    expect(nav()).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    expect(input).toHaveValue('Прага');
  });

  it('handles Android resizing both viewports without adding a second keyboard-sized gap', () => {
    render(<Harness />);
    focus();
    layoutHeight = 360;
    window.innerHeight = 360;
    resize(360);
    expect(nav()).toHaveAttribute('hidden');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    layoutHeight = 780;
    window.innerHeight = 780;
    resize(780);
    expect(nav()).not.toHaveAttribute('hidden');
  });

  it('uses Telegram viewport events when VisualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined);
    coarse = false;
    host.platform = 'ios';
    host.viewportHeight = 780;
    render(<Harness />);
    focus();
    const callback = host.onEvent.mock.calls.find(([event]) => event === 'viewportChanged')![1];
    host.viewportHeight = 360;
    act(() => callback({ isStateStable: true }));
    flush();
    expect(nav()).toHaveAttribute('hidden');
    expect(screen.getByTestId('inset')).toHaveTextContent('420');
    host.viewportHeight = 780;
    act(() => callback({ isStateStable: true }));
    flush();
    expect(nav()).not.toHaveAttribute('hidden');
  });

  it('falls back to mobile focus without geometry and restores navigation on blur', () => {
    vi.stubGlobal('visualViewport', undefined);
    render(<Harness />);
    const input = focus();
    expect(nav()).toHaveAttribute('hidden');
    act(() => input.blur());
    flush();
    expect(nav()).not.toHaveAttribute('hidden');
  });

  it('restores navigation if saving replaces the focused form without blur or viewport events', async () => {
    vi.stubGlobal('visualViewport', undefined);
    const { rerender } = render(<Harness />);
    focus();
    expect(nav()).toHaveAttribute('hidden');
    await act(async () => {
      rerender(<Harness showForm={false} />);
    });
    flush();
    expect(nav()).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
  });

  it('does not treat desktop focus, ordinary desktop resizing, checkboxes or read-only fields as keyboard entry', () => {
    coarse = false;
    render(<Harness />);
    focus();
    expect(nav()).not.toHaveAttribute('hidden');
    layoutHeight = 400;
    window.innerHeight = 400;
    resize(400);
    expect(nav()).not.toHaveAttribute('hidden');
    coarse = true;
    focus('Позначка');
    expect(nav()).not.toHaveAttribute('hidden');
    focus('Лише читання');
    expect(nav()).not.toHaveAttribute('hidden');
  });

  it('keeps the input ahead of a group too tall to fit and leaves manual panning alone', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Місто');
    vi.spyOn(input.closest('form')!, 'getBoundingClientRect').mockReturnValue(rect(0, 700));
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300, 348));
    focus();
    vi.mocked(window.scrollBy).mockClear();
    resize(360);
    expect(window.scrollBy).not.toHaveBeenCalled();
    visual.offsetTop = 100;
    act(() => visual.dispatchEvent(new Event('scroll')));
    flush();
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('does not mistake pinch zoom for a keyboard or force the focused input back into view', () => {
    render(<Harness />);
    focus();
    vi.mocked(window.scrollBy).mockClear();
    visual.scale = 2;
    resize(390);
    expect(nav()).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('recalculates the baseline after rotating the device and restores navigation at the new height', () => {
    render(<Harness />);
    focus();
    resize(360);
    window.innerWidth = 844;
    window.innerHeight = 430;
    layoutHeight = 430;
    resize(220);
    expect(nav()).toHaveAttribute('hidden');
    expect(screen.getByTestId('inset')).toHaveTextContent('210');
    resize(430);
    expect(nav()).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('inset')).toHaveTextContent('0');
  });

  it('scrolls the containing panel instead of the locked page and removes subscriptions on unmount', () => {
    const { unmount } = render(<Harness />);
    const input = screen.getByLabelText('Місто');
    const panel = input.closest('form')!;
    panel.style.overflowY = 'auto';
    vi.spyOn(panel, 'clientHeight', 'get').mockReturnValue(200);
    vi.spyOn(panel, 'scrollHeight', 'get').mockReturnValue(800);
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(rect(100, 800));
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() =>
      rect(500 - panel.scrollTop, 548 - panel.scrollTop),
    );
    document.body.style.position = 'fixed';
    focus();
    resize(360);
    expect(panel.scrollTop).toBe(200);
    expect(window.scrollBy).not.toHaveBeenCalled();
    const callback = host.onEvent.mock.calls.find(([event]) => event === 'viewportChanged')![1];
    unmount();
    expect(host.offEvent).toHaveBeenCalledWith('viewportChanged', callback);
    vi.mocked(window.scrollBy).mockClear();
    resize(300);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
});
