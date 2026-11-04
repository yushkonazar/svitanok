import { useId, useState } from 'react';
import type { Field, CheckinPreferences } from '../../../../core/checkin/catalog.mjs';
import {
  CHECKIN_CARDS_V4,
  FOLLOWUP_CARDS_V4,
  contextualFieldV4,
} from '../../../../core/checkin/adaptive-v4.mjs';
import {
  activeChoiceScopes,
  choiceScopes,
  defaultChoiceScope,
  editableChoiceField,
  editableChoiceValue,
  normalizeChoiceCatalog,
  type ChoiceCommand,
} from '../../../../core/checkin/choices.mjs';
import { useSaveCheckinChoice } from '../../api/hooks.ts';
import { CheckinChoiceError } from '../../api/client.ts';
import { FieldInput } from './CheckinV2Screen.tsx';

type Answers = Record<string, unknown>;
type Props = {
  field: Field;
  answers: Answers;
  p: CheckinPreferences;
  date: string;
  onChange: (key: string, value: unknown) => void;
  choices?: unknown;
};
const uuid = () => crypto.randomUUID().replaceAll('-', '');
export function ChoiceFieldInput(props: Props) {
  const field = props.field;
  return (
    <div className="checkin-managed-field">
      <FieldInput {...props} />
      {editableChoiceField(field) && (
        <ChoiceManager key={activeChoiceScopes(field.id, props.answers).join(':')} {...props} />
      )}
    </div>
  );
}

function ChoiceManager({ field, answers, choices, onChange }: Props) {
  const save = useSaveCheckinChoice(),
    id = useId();
  const catalog = normalizeChoiceCatalog(choices),
    scopes = activeChoiceScopes(field.id, answers);
  const base =
    [...Object.values(CHECKIN_CARDS_V4).flat(), ...FOLLOWUP_CARDS_V4]
      .flatMap((c) => c.fields)
      .find((f) => f.id === field.id) ?? field;
  const relevant = contextualFieldV4(base, answers).options ?? [];
  const entries = catalog.entries.filter((e) => e.field === field.id);
  const rows = [
    ...relevant
      .filter(([, v]) => editableChoiceValue(v))
      .map(([label, value]) => {
        const entry = entries.find((e) => e.id === value),
          parts = label.split(' :: ');
        return (
          entry ?? {
            field: field.id,
            id: String(value),
            label: parts.at(-1) ?? '',
            group: parts.length > 1 ? (parts[0] ?? 'Основне') : 'Основне',
            scope: 'default',
            deleted: false,
          }
        );
      }),
    ...entries.filter((e) => e.id.startsWith('user_') && scopes.includes(e.scope)),
  ];
  const [editing, setEditing] = useState<{
    id: string;
    label: string;
    group: string;
    scope: string;
    fresh: boolean;
  } | null>(null);
  const [notice, setNotice] = useState(''),
    [showDeleted, setShowDeleted] = useState(false),
    [open, setOpen] = useState(false);
  const [retryCommand, setRetryCommand] = useState<{
    signature: string;
    command: ChoiceCommand;
  } | null>(null);
  async function submit(op: ChoiceCommand['op'], optionId: string, data?: typeof editing) {
    if (save.isPending) return;
    const payload = {
      op,
      field: field.id,
      optionId,
      ...(data ? { label: data.label, group: data.group, scope: data.scope } : {}),
    };
    const signature = JSON.stringify(payload);
    const command =
      retryCommand?.signature === signature
        ? retryCommand.command
        : { ...payload, requestId: uuid(), expectedRevision: catalog.revision };
    setRetryCommand({ signature, command });
    setNotice('');
    try {
      await save.mutateAsync(command);
      setRetryCommand(null);
      if (op === 'delete') {
        const selected = answers[field.id];
        if (Array.isArray(selected) && selected.includes(optionId))
          onChange(
            field.id,
            selected.filter((v) => v !== optionId),
          );
        else if (selected === optionId) onChange(field.id, null);
      }
      setEditing(null);
      setNotice(
        op === 'delete'
          ? 'Варіант видалено. Попередні записи збережено.'
          : op === 'restore'
            ? 'Варіант відновлено.'
            : 'Збережено для наступних відповідей.',
      );
    } catch (error) {
      if (error instanceof CheckinChoiceError && error.status < 500) setRetryCommand(null);
      setNotice(error instanceof Error ? error.message : 'Не вдалося зберегти. Спробуй ще раз.');
    }
  }
  return (
    <details className="checkin-choice-manager" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
      >
        Керувати варіантами
      </summary>
      {open && (
        <div className="flex flex-col gap-3 mt-3">
          <button
            type="button"
            className="renewal-link text-sm text-left"
            disabled={save.isPending}
            onClick={() => {
              setEditing({
                id: `user_${uuid()}`,
                label: '',
                group: 'Мої варіанти',
                scope: defaultChoiceScope(field.id, answers),
                fresh: true,
              });
              setNotice('');
            }}
          >
            ＋ Свій варіант
          </button>
          {editing ? (
            <div
              className="checkin-choice-editor"
              role="group"
              aria-label={editing.fresh ? 'Новий варіант' : 'Редагування варіанта'}
            >
              <label htmlFor={`${id}-name`}>Назва</label>
              <input
                id={`${id}-name`}
                className="checkin-text-input"
                autoComplete="off"
                maxLength={100}
                value={editing.label}
                disabled={save.isPending}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              />
              <label htmlFor={`${id}-group`}>Категорія</label>
              <input
                id={`${id}-group`}
                className="checkin-text-input"
                list={`${id}-groups`}
                autoComplete="off"
                maxLength={50}
                value={editing.group}
                disabled={save.isPending}
                onChange={(e) => setEditing({ ...editing, group: e.target.value })}
              />
              <datalist id={`${id}-groups`}>
                {[...new Set(rows.map((e) => e.group))].map((group) => (
                  <option key={group} value={group} />
                ))}
              </datalist>
              {editing.id.startsWith('user_') && choiceScopes(field.id).length > 1 && (
                <>
                  <label htmlFor={`${id}-scope`}>Коли показувати</label>
                  <select
                    id={`${id}-scope`}
                    className="checkin-text-input"
                    disabled={save.isPending}
                    value={editing.scope}
                    onChange={(e) => setEditing({ ...editing, scope: e.target.value })}
                  >
                    {choiceScopes(field.id).map(([label, value]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <div className="flex flex-wrap gap-2 mt-2">
                <button
                  type="button"
                  className="renewal-secondary"
                  disabled={save.isPending || !editing.label.trim() || !editing.group.trim()}
                  onClick={() => submit(editing.fresh ? 'create' : 'update', editing.id, editing)}
                >
                  {save.isPending ? 'Зберігаю…' : 'Зберегти варіант'}
                </button>
                <button
                  type="button"
                  className="renewal-link"
                  disabled={save.isPending}
                  onClick={() => {
                    setEditing(null);
                    setNotice('');
                  }}
                >
                  Скасувати
                </button>
              </div>
            </div>
          ) : (
            <>
              {rows
                .filter((e) => !e.deleted)
                .map((entry) => (
                  <div className="checkin-choice-editor-row" key={entry.id}>
                    <span>
                      <b>{entry.label}</b>
                      <small>{entry.group}</small>
                    </span>
                    <button
                      type="button"
                      disabled={save.isPending}
                      aria-label={`Редагувати: ${entry.label}`}
                      onClick={() => {
                        setEditing({ ...entry, fresh: false });
                        setNotice('');
                      }}
                    >
                      Змінити
                    </button>
                    <button
                      type="button"
                      disabled={save.isPending}
                      aria-label={`Видалити: ${entry.label}`}
                      onClick={() => submit('delete', entry.id)}
                    >
                      Видалити
                    </button>
                  </div>
                ))}
              {rows.some((e) => e.deleted) && (
                <button
                  type="button"
                  className="renewal-link text-xs text-left"
                  aria-expanded={showDeleted}
                  onClick={() => setShowDeleted(!showDeleted)}
                >
                  Видалені варіанти · {rows.filter((e) => e.deleted).length}
                </button>
              )}
              {showDeleted &&
                rows
                  .filter((e) => e.deleted)
                  .map((entry) => (
                    <div className="checkin-choice-editor-row" key={entry.id}>
                      <span>{entry.label}</span>
                      <button
                        type="button"
                        disabled={save.isPending}
                        aria-label={`Відновити: ${entry.label}`}
                        onClick={() => submit('restore', entry.id)}
                      >
                        Відновити
                      </button>
                    </div>
                  ))}
            </>
          )}
          <p role={save.isError ? 'alert' : 'status'} className="text-xs text-tx3">
            {notice}
          </p>
        </div>
      )}
    </details>
  );
}
