import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RequestDiagnostics } from './RequestDiagnostics.tsx';
import {
  readRequestDiagnostics,
  recordRequestDiagnostic,
  type RequestDiagnostic,
} from '../../api/request-diagnostics.ts';
const entry: RequestDiagnostic = {
  at: '2026-10-18T07:28:00Z',
  area: 'leisure',
  operation: 'reaction',
  requestId: 'request-123',
  phase: 'command',
  status: 503,
  code: 'storage-failure',
  layer: 'server',
  durationMs: 100,
  attempt: 1,
};
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());
describe('copyable private request diagnostics', () => {
  it('copies machine-readable time, status and scope with a readable explanation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<RequestDiagnostics entry={entry} />);
    fireEvent.click(screen.getByText('Технічні деталі запиту'));
    expect(screen.getByText(/Сервер не зміг звернутися до сховища/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Скопіювати звіт про помилку' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Скопійовано' })).toBeInTheDocument(),
    );
    expect(JSON.parse(writeText.mock.calls[0]![0]).entries).toEqual([entry]);
  });
  it('bounds the session log and removes unapproved extra fields when reading', () => {
    sessionStorage.setItem(
      'svitanok-request-diagnostics-v1',
      JSON.stringify([
        { ...entry, payload: { privateNote: 'secret' }, authorization: 'do-not-copy' },
      ]),
    );
    expect(readRequestDiagnostics()).toEqual([entry]);
    for (let i = 0; i < 30; i++) recordRequestDiagnostic({ ...entry, requestId: 'request-' + i });
    expect(readRequestDiagnostics()).toHaveLength(25);
    expect(JSON.stringify(readRequestDiagnostics())).not.toContain('do-not-copy');
  });
});
