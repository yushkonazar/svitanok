import { useEffect, useState } from 'react';
import { tg } from '../telegram.ts';

const NON_EDITING_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function focusedInput(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    if (active.disabled || active.readOnly || active.inputMode === 'none') return null;
    return active instanceof HTMLInputElement && NON_EDITING_INPUTS.has(active.type)
      ? null
      : active;
  }
  return active instanceof HTMLElement && active.isContentEditable ? active : null;
}

function viewport() {
  const visual = window.visualViewport;
  const heights = [window.innerHeight, visual?.height, tg?.viewportHeight].filter(
    (height): height is number => typeof height === 'number' && height > 0,
  );
  return {
    height: Math.min(...heights),
    top: visual?.offsetTop ?? 0,
    layoutHeight: document.documentElement.clientHeight || window.innerHeight,
    zoomed: Math.abs((visual?.scale ?? 1) - 1) > 0.05,
  };
}

/** Move the short input/action group together when it fits, otherwise prioritise the input. */
function revealInput(input: HTMLElement) {
  const view = viewport();
  if (view.zoomed) return;
  const top = view.top + 12,
    bottom = view.top + view.height - 12;
  const group = input.closest<HTMLElement>('[data-input-viewport-group]');
  const groupRect = group?.getBoundingClientRect();
  const rect =
    groupRect && groupRect.height <= bottom - top ? groupRect : input.getBoundingClientRect();
  let delta = rect.bottom > bottom ? rect.bottom - bottom : Math.min(0, rect.top - top);
  if (Math.abs(delta) < 1) return;

  // A modal may lock the document: scroll its own container, never the page behind it.
  for (
    let parent = input.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    if (!/auto|scroll/.test(getComputedStyle(parent).overflowY)) continue;
    const previous = parent.scrollTop;
    parent.scrollTop = Math.max(
      0,
      Math.min(parent.scrollHeight - parent.clientHeight, previous + delta),
    );
    delta -= parent.scrollTop - previous;
    if (Math.abs(delta) < 1) return;
  }
  if (getComputedStyle(document.body).position !== 'fixed') {
    window.scrollBy({ top: delta, behavior: 'instant' });
  }
}

/** Keyboard handling belongs to the shell so changing viewport never remounts a form. */
export function useInputViewport() {
  const [state, setState] = useState({ editing: false, inset: 0 });
  useEffect(() => {
    const visual = window.visualViewport;
    let baseline = viewport().height,
      width = window.innerWidth;
    let seenKeyboard = false,
      input: HTMLElement | null = null;
    let frame = 0,
      revealFrame = 0,
      needsReveal = false;
    const mobile = () =>
      tg?.platform === 'ios' ||
      tg?.platform === 'android' ||
      Boolean(window.matchMedia?.('(pointer: coarse)').matches);
    const update = () => {
      frame = 0;
      const current = focusedInput(),
        view = viewport();
      if (width !== window.innerWidth) {
        width = window.innerWidth;
        baseline = Math.max(view.layoutHeight, view.height);
        seenKeyboard = false;
      }
      if (!view.zoomed) {
        if (!current) {
          baseline = Math.max(baseline, view.height);
          seenKeyboard = false;
        } else if (!input) {
          baseline = Math.max(baseline, view.layoutHeight, view.height);
        }
      }
      const overlap = Math.max(0, view.layoutHeight - view.top - view.height);
      const reduced = baseline - view.height > 120 && (mobile() || overlap > 120);
      if (current && reduced && !view.zoomed) seenKeyboard = true;
      // Hide immediately on mobile focus, including clients that report no keyboard geometry.
      // Once a keyboard has been measured, restoring its height brings navigation back even
      // when iOS keeps the input focused after dismissing the keyboard.
      const editing = Boolean(current) && !view.zoomed && (reduced || (mobile() && !seenKeyboard));
      const inset = editing ? Math.ceil(overlap) : 0;
      setState((previous) =>
        previous.editing === editing && previous.inset === inset ? previous : { editing, inset },
      );
      input = current;
      if (needsReveal && editing && current) {
        cancelAnimationFrame(revealFrame);
        // Wait for navigation/padding to commit before measuring the form.
        revealFrame = requestAnimationFrame(() => {
          revealFrame = 0;
          if (focusedInput() === current) revealInput(current);
        });
      }
      needsReveal = false;
    };
    const schedule = (reveal: boolean) => {
      needsReveal ||= reveal;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onFocus = () => schedule(true);
    const onBlur = () => schedule(false);
    const onResize = () => schedule(true);
    // Panning/scrolling the visible viewport must not pull the user back to the input.
    const onScroll = () => schedule(false);
    // Removing a focused form does not reliably emit blur (for example after saving a step).
    const structure = new MutationObserver(() => {
      if (input && !input.isConnected) schedule(false);
    });
    structure.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    window.addEventListener('resize', onResize);
    visual?.addEventListener('resize', onResize);
    visual?.addEventListener('scroll', onScroll);
    tg?.onEvent?.('viewportChanged', onResize);
    schedule(true);
    return () => {
      structure.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(revealFrame);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      window.removeEventListener('resize', onResize);
      visual?.removeEventListener('resize', onResize);
      visual?.removeEventListener('scroll', onScroll);
      tg?.offEvent?.('viewportChanged', onResize);
    };
  }, []);
  return state;
}
