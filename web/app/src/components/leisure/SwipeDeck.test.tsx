import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SwipeDeck } from './SwipeDeck.tsx';
import { readLeisureDemo } from '../../api/leisure-demo.ts';
import { readPendingLeisure, keepPendingLeisure } from './pending-command.ts';
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function setup(onLike = vi.fn().mockResolvedValue({})) {
  const items = readLeisureDemo().items;
  const props = {
    items,
    busy: false,
    onLike,
    onReject: vi.fn(),
    onVisit: vi.fn(),
    onOpen: vi.fn(),
    reasons: () => ['Новий варіант'],
  };
  const rendered = render(<SwipeDeck {...props} />);
  return { ...props, ...rendered };
}
function swipe(x: number, y: number) {
  const surface = screen.getByLabelText('Картка дозвілля');
  fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 120, clientY: 200 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 120 + x, clientY: 200 + y });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: 120 + x, clientY: 200 + y });
}
describe('swipe deck', () => {
  it('opens full details with a short tap anywhere on the card without recording a reaction', () => {
    const { onOpen, onLike, onReject, onVisit, items } = setup();
    const surface = screen.getByRole('button', { name: 'Картка дозвілля' });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 120, clientY: 200 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 123, clientY: 202 });
    fireEvent.click(surface);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(items[0]);
    expect(onLike).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(onVisit).not.toHaveBeenCalled();
  });
  it('does not open details from the click produced after a drag, including a drag back to the origin', () => {
    const { onOpen, onReject } = setup();
    const surface = screen.getByRole('button', { name: 'Картка дозвілля' });
    swipe(-110, 4);
    fireEvent.click(surface);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, clientX: 120, clientY: 200 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 170, clientY: 201 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 120, clientY: 200 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 120, clientY: 200 });
    fireEvent.click(surface);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.pointerDown(surface, { pointerId: 3, button: 0, clientX: 120, clientY: 200 });
    fireEvent.pointerUp(surface, { pointerId: 3, clientX: 120, clientY: 200 });
    fireEvent.click(surface);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it('ignores the click after a cancelled touch, and opens from Enter or Space', () => {
    const { onOpen, items } = setup();
    const surface = screen.getByRole('button', { name: 'Картка дозвілля' });
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 120, clientY: 200 });
    fireEvent.pointerCancel(surface);
    fireEvent.click(surface);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(surface, { key: 'Enter' });
    fireEvent.keyDown(surface, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith(items[0]);
  });
  it('waits for acknowledgement before advancing and permits only one pending choice', async () => {
    let finish!: () => void;
    const onLike = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const { items } = setup(onLike);
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво' }));
    expect(screen.getByRole('heading', { name: items[0]!.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво' }));
    expect(onLike).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: items[0]!.title })).not.toBeInTheDocument(),
    );
  });
  it('returns a failed right choice to the same card', async () => {
    const { items } = setup(vi.fn().mockRejectedValue(new Error('Зв’язок перервався')));
    fireEvent.click(screen.getByRole('button', { name: 'Цікаво' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Зв’язок перервався');
    expect(screen.getByRole('heading', { name: items[0]!.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Цікаво' })).toBeEnabled();
  });
  it('opens a reason or a visit form without persisting a premature reaction', () => {
    const { onReject, onVisit, onLike, items } = setup();
    swipe(-110, 5);
    expect(onReject).toHaveBeenCalledWith(items[0]);
    swipe(4, 120);
    expect(onVisit).toHaveBeenCalledWith(items[0]);
    expect(onLike).not.toHaveBeenCalled();
  });
  it('ignores short gestures, ambiguous diagonals and cancelled gestures', () => {
    const { onLike, onReject, onVisit } = setup();
    swipe(30, 4);
    swipe(-100, 100);
    const surface = screen.getByLabelText('Картка дозвілля');
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 120, clientY: 200 });
    fireEvent.pointerCancel(surface);
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 300, clientY: 200 });
    expect(onLike).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(onVisit).not.toHaveBeenCalled();
  });
  it('supports keyboard alternatives and shows the completed state', async () => {
    const { items, rerender, onLike, onReject, onVisit, onOpen, reasons } = setup();
    fireEvent.keyDown(screen.getByLabelText('Картка дозвілля'), { key: 'ArrowLeft' });
    expect(onReject).toHaveBeenCalledWith(items[0]);
    rerender(
      <SwipeDeck
        items={[]}
        busy={false}
        onLike={onLike}
        onReject={onReject}
        onVisit={onVisit}
        onOpen={onOpen}
        reasons={reasons}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Усі варіанти переглянуто');
  });
  it('keeps the exact unacknowledged command across a reload and clears it after acknowledgement', () => {
    const command = {
      op: 'visit',
      id: 'film',
      commandId: 'same-command-id',
      payload: { reason: 'Обожнюю Marvel' },
    };
    keepPendingLeisure(command);
    expect(readPendingLeisure()).toEqual(command);
    keepPendingLeisure(null);
    expect(readPendingLeisure()).toBeNull();
    sessionStorage.setItem('svitanok-leisure-pending-v1', 'invalid');
    expect(readPendingLeisure()).toBeNull();
  });
});
