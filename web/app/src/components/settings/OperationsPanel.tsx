import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCredentials, saveCredentialMetadata } from '../../api/client.ts';
import type { CredentialEntry, CredentialMetadata } from '../../api/credentials-schema.ts';
import { inTelegram } from '../../telegram.ts';
import { useSearchParams } from 'react-router-dom';

const locations: Record<string, string> = {
  cloudflare: 'Cloudflare',
  vps: 'VPS',
  github: 'GitHub',
  offline: 'Офлайн-копія',
};
const featureNames: Record<string, string> = {
  calendar_read: 'Читати календар',
  calendar: 'Змінювати події',
  mail: 'Читати пошту',
  contacts_read: 'Шукати контакти',
  contacts: 'Створювати контакти',
  drive: 'Зберігати власні файли',
  drive_read: 'Шукати й читати файли Drive',
  tasks: 'Керувати задачами',
};

export function CredentialEditor({
  entry,
  pending,
  onSave,
  onCancel,
}: {
  entry: CredentialEntry;
  pending: boolean;
  onSave: (value: CredentialMetadata) => void;
  onCancel: () => void;
}) {
  const [rotatedAt, setRotatedAt] = useState(entry.rotatedAt ?? ''),
    [expiresAt, setExpiresAt] = useState(entry.expiresAt ?? ''),
    [nonExpiring, setNonExpiring] = useState(entry.expiryKind === 'non-expiring'),
    [rotation, setRotation] = useState(
      entry.rotateAfterDays == null ? '' : String(entry.rotateAfterDays),
    ),
    [version] = useState(entry.version);
  return (
    <form
      className="renewal-inset mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || entry.version !== version) return;
        onSave({
          id: entry.id,
          version,
          rotatedAt: rotatedAt || null,
          expiresAt: nonExpiring ? null : expiresAt || null,
          expiryKind: nonExpiring ? 'non-expiring' : expiresAt ? 'date' : 'unknown',
          rotateAfterDays: rotation ? Number(rotation) : null,
        });
      }}
    >
      <p className="renewal-chart-note">Лише відомі дати. Не вставляй сюди значення ключа.</p>
      <label className="renewal-field mt-3">
        Останнє оновлення
        <input
          aria-label="Останнє оновлення"
          type="date"
          value={rotatedAt}
          onChange={(e) => setRotatedAt(e.target.value)}
          disabled={pending}
        />
      </label>
      <label className="renewal-field mt-3">
        Строк дії у провайдера
        <input
          aria-label="Строк дії у провайдера"
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          disabled={pending || nonExpiring}
        />
      </label>
      <label className="flex gap-3 mt-3 items-start text-sm">
        <input
          type="checkbox"
          checked={nonExpiring}
          disabled={pending}
          onChange={(e) => {
            setNonExpiring(e.target.checked);
            if (e.target.checked) setExpiresAt('');
          }}
        />
        Провайдер підтвердив, що строк дії не обмежений
      </label>
      <p className="renewal-chart-note">
        Залиш порожнім, якщо строк не вказано. Дата оновлення не визначає строк дії.
      </p>
      <label className="renewal-field mt-3">
        Нагадування про ротацію
        <select
          aria-label="Нагадування про ротацію"
          value={rotation}
          onChange={(e) => setRotation(e.target.value)}
          disabled={pending}
        >
          <option value="">Без планового нагадування</option>
          {[
            ...new Set([90, 180, 365, ...(entry.rotateAfterDays ? [entry.rotateAfterDays] : [])]),
          ].map((days) => (
            <option key={days} value={days}>
              Через {days} днів після оновлення
            </option>
          ))}
        </select>
      </label>
      <p className="renewal-chart-note">
        Ротація — твоя рекомендація, а не завершення роботи ключа.
      </p>
      {entry.name === 'BACKUP_ENC_KEY' && (
        <p className="text-sm mt-2">
          Ключ резервних копій не можна міняти без перешифрування й перевірки відновлення.
        </p>
      )}
      {entry.version !== version && (
        <p role="alert" className="mt-2">
          Дані змінилися в іншому місці. Закрий форму й відкрий її знову для перевірки.
        </p>
      )}
      <div className="flex gap-3 mt-4">
        <button className="renewal-primary" disabled={pending || entry.version !== version}>
          {pending ? 'Зберігаю…' : 'Зберегти дати'}
        </button>
        <button type="button" className="renewal-secondary" disabled={pending} onClick={onCancel}>
          Скасувати
        </button>
      </div>
    </form>
  );
}
export function OperationsPanel() {
  const [params] = useSearchParams();
  const [open, setOpen] = useState(params.get('panel') === 'access'),
    [editing, setEditing] = useState<string | null>(null),
    [legacy, setLegacy] = useState(false),
    [saved, setSaved] = useState(false);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: fetchCredentials,
    enabled: open && inTelegram(),
    staleTime: 60000,
    refetchOnWindowFocus: 'always',
  });
  const save = useMutation({
    mutationFn: saveCredentialMetadata,
    onSuccess: (value) => {
      qc.setQueryData(['credentials'], value);
      setEditing(null);
      setSaved(true);
    },
  });
  const data = query.data;
  return (
    <details open={open} className="renewal-card" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold text-sm">Доступи й строки дії</summary>
      <div className="mt-4">
        <p className="renewal-chart-note">
          Тут лише облік дат. Він не змінює ключі й не доводить, що доступ працює.
        </p>
        {!inTelegram() ? (
          <p className="renewal-muted mt-3">
            Особистий реєстр доступний у чаті з ботом, не в демо.
          </p>
        ) : query.isPending ? (
          <p role="status">Завантажую доступи…</p>
        ) : null}
        {query.isError && (
          <div role="alert" className="mt-3">
            <p>{query.error.message}</p>
            <button className="renewal-link" onClick={() => void query.refetch()}>
              Повторити
            </button>
          </div>
        )}
        {data && (
          <>
            {!data.available && (
              <p className="renewal-muted mt-3">
                Редагування буде доступне після оновлення системи. Відомі дані можна переглянути.
              </p>
            )}
            <h3 className="font-semibold mt-5">Підключення Google</h3>
            <p className="renewal-muted mt-2">
              {!data.google.configured
                ? 'Не підключено'
                : !data.google.known
                  ? 'Дозволи ще не перевірені'
                  : !data.google.verified
                    ? 'Є кешовані дані; поточний доступ ще не підтверджено'
                    : data.google.missing.length
                      ? 'Частині функцій бракує дозволів'
                      : data.google.extra.length
                        ? 'Є ширший доступ — варто переглянути'
                        : 'Права відповідають поточним функціям'}
              .
            </p>
            {data.google.checkedAt && (
              <p className="renewal-chart-note">
                Дані перевірено{' '}
                {new Date(data.google.checkedAt).toLocaleString('uk-UA', {
                  timeZone: 'Europe/Kyiv',
                })}
                .
              </p>
            )}
            {Object.entries(data.google.features).map(([feature, available]) => (
              <p key={feature} className="text-sm mt-1">
                {featureNames[feature] ?? feature}:{' '}
                {available == null ? 'невідомо' : available ? 'є дозвіл' : 'немає дозволу'}
              </p>
            ))}
            {!!data.google.redundant.length && (
              <p className="renewal-chart-note mt-2">
                Є дублювання дозволів. Саме по собі воно не розширює доступ.
              </p>
            )}
            <details className="mt-3">
              <summary className="renewal-link">Технічні деталі дозволів</summary>
              <p className="renewal-chart-note break-all">
                Додаткові: {data.google.extra.join(', ') || 'немає'}.
              </p>
              <p className="renewal-chart-note break-all">
                Потрібні, але не видані: {data.google.missing.join(', ') || 'немає'}.
              </p>
              <p className="renewal-chart-note">
                Перепідключення Google виконується окремо. Цей екран не запитує нових прав і не
                відкликає чинних.
              </p>
            </details>
            <h3 className="font-semibold mt-5">Ключі за місцем використання</h3>
            {saved && (
              <p role="status" className="mt-2">
                Дати збережено. Сам ключ не змінено.
              </p>
            )}
            {save.isError && (
              <p role="alert" className="text-neg mt-2">
                {save.error.message}
                <button
                  className="renewal-link ml-2"
                  onClick={() => {
                    setEditing(null);
                    void query.refetch();
                  }}
                >
                  Оновити реєстр
                </button>
              </p>
            )}
            {data.entries
              .filter((entry) => legacy || !entry.legacy)
              .map((entry) => (
                <div key={entry.id} className="renewal-inset mt-3">
                  <h4 className="font-semibold text-sm">
                    {entry.label} · {locations[entry.location] ?? entry.location}
                  </h4>
                  <p className="renewal-chart-note">
                    {entry.configured == null
                      ? 'Наявність тут не перевіряється'
                      : entry.configured
                        ? 'Є в конфігурації'
                        : 'Немає в конфігурації'}
                    ; це не перевірка чинності.
                  </p>
                  <p className="renewal-chart-note">
                    {entry.expiryKind === 'non-expiring'
                      ? 'Безстроковий за вказаними даними; чинність окремо не перевірена.'
                      : entry.expiresAt
                        ? `Строк дії: ${entry.expiresAt}`
                        : 'Строк дії не вказано — це не помилка.'}
                  </p>
                  {entry.rotateAfterDays && (
                    <p className="renewal-chart-note">
                      Обране нагадування: кожні {entry.rotateAfterDays} днів після оновлення.
                    </p>
                  )}
                  {!entry.rotatedAt && entry.legacyRotationAt && (
                    <p className="renewal-chart-note">
                      Є старий запис оновлення без уточнення місця. Він не визначає строк дії.
                    </p>
                  )}
                  <details>
                    <summary className="renewal-link text-xs mt-1">Назва в системі</summary>
                    <code className="text-xs break-all">{entry.name}</code>
                  </details>
                  {editing === entry.id ? (
                    <CredentialEditor
                      key={entry.id}
                      entry={entry}
                      pending={save.isPending}
                      onCancel={() => setEditing(null)}
                      onSave={(value) => save.mutate(value)}
                    />
                  ) : (
                    data.available && (
                      <button
                        className="renewal-link mt-2"
                        disabled={save.isPending}
                        onClick={() => {
                          setEditing(entry.id);
                          setSaved(false);
                          save.reset();
                        }}
                      >
                        Вказати дати
                      </button>
                    )
                  )}
                </div>
              ))}
            <button className="renewal-link mt-4" onClick={() => setLegacy(!legacy)}>
              {legacy ? 'Сховати старі інтеграції' : 'Показати старі інтеграції'}
            </button>
          </>
        )}
      </div>
    </details>
  );
}
