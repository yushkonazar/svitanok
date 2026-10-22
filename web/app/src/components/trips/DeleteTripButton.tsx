import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  changeTrip,
  fetchTrips,
  TravelChangeError,
  type TravelCommand,
  type TravelCurrent,
  type TravelSnapshot,
} from '../../api/trips.ts';
import { isSessionExpired } from '../../api/client.ts';
import { SessionExpired } from '../ui/SessionExpired.tsx';
import { Sheet } from '../ui/Sheet.tsx';

type Target = { id: string; title: string; command: TravelCommand };

export function DeleteTripButton({
  current,
  disabled,
  onNavigate,
}: {
  current: TravelCurrent;
  disabled: boolean;
  onNavigate: (id: string | undefined, notice: string, refreshRequired: boolean) => void;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mutation = useMutation({ mutationFn: (command: TravelCommand) => changeTrip(command) });
  const cache = useQueryClient();
  const busy = mutation.isPending || refreshing;

  const show = async (snapshot: TravelSnapshot | null, removedId?: string) => {
    await cache.cancelQueries({ queryKey: ['trips'] });
    let fallback: TravelSnapshot = { ok: true, items: [], current: null };
    cache.setQueriesData<TravelSnapshot>({ queryKey: ['trips'] }, (previous) => {
      if (!previous) return previous;
      const items = snapshot?.items ?? previous.items.filter((item) => item.id !== removedId);
      const updated = {
        ...previous,
        items,
        current:
          previous.current && items.some((item) => item.id === previous.current?.id)
            ? previous.current
            : null,
      };
      fallback = { ...updated, current: null };
      return updated;
    });
    const id = snapshot?.current?.id;
    cache.setQueryData(['trips', id], snapshot ?? fallback);
    await cache.invalidateQueries({ queryKey: ['trips'], refetchType: 'none' });
    setTarget(null);
    onNavigate(
      id,
      removedId
        ? snapshot
          ? 'Поїздку видалено.'
          : 'Поїздку видалено. Онови список, щоб завантажити решту записів.'
        : 'Список оновлено. Перевір збережені записи.',
      Boolean(removedId && !snapshot),
    );
  };

  const remove = async () => {
    if (!target || busy) return;
    setError(null);
    try {
      const snapshot = await mutation.mutateAsync(target.command);
      await show(snapshot, target.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Не вдалося підтвердити видалення.'));
    }
  };
  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    try {
      await show(await fetchTrips());
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Не вдалося оновити список.'));
    } finally {
      setRefreshing(false);
    }
  };
  const uncertain = error instanceof TravelChangeError && error.uncertain;
  return (
    <>
      <button
        className="trips-delete-button"
        disabled={disabled || busy}
        onClick={() => {
          setError(null);
          setTarget({
            id: current.id,
            title: String(current.answers.to ?? 'Нова подорож'),
            command: {
              op: 'delete',
              id: current.id,
              revision:
                current.kind === 'draft'
                  ? (current.revision ?? 0)
                  : (current.workspace?.revision ?? 0),
              data: { confirm: true, kind: current.kind },
            },
          });
        }}
      >
        Видалити поїздку
      </button>
      {target && (
        <Sheet label="Видалення поїздки" onClose={() => !busy && setTarget(null)}>
          <div className="trips-delete-confirm">
            <h2>Видалити «{target.title}»?</h2>
            <p>
              {target.command.data?.kind === 'draft'
                ? 'Чернетку й результати планування буде видалено.'
                : 'Бриф, план, список речей і журнал цієї поїздки буде видалено. Супровід припиниться.'}
            </p>
            <p>Цю дію неможливо скасувати.</p>
            {isSessionExpired(error) ? (
              <SessionExpired />
            ) : error ? (
              <p className="trips-error" role="alert">
                {error.message}
              </p>
            ) : null}
            <div className="trips-actions">
              <button disabled={busy} onClick={() => setTarget(null)}>
                Залишити
              </button>
              {uncertain ? (
                <button disabled={busy} onClick={() => void refresh()}>
                  {refreshing ? 'Оновлюю…' : 'Оновити список'}
                </button>
              ) : (
                <button
                  className="trips-delete-button"
                  disabled={busy || isSessionExpired(error)}
                  onClick={() => void remove()}
                >
                  {mutation.isPending ? 'Видаляю…' : 'Так, видалити'}
                </button>
              )}
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
