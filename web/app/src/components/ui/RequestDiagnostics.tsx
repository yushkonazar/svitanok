import { useEffect, useState } from 'react';
import {
  diagnosticReport,
  readRequestDiagnostics,
  type RequestDiagnostic,
} from '../../api/request-diagnostics.ts';
const explanations: Record<string, string> = {
  'network-failure': 'З’єднання обірвалося або відповіді немає',
  timeout: 'Перевищено час очікування відповіді',
  'storage-failure': 'Сервер не зміг звернутися до сховища',
  'service-failure': 'Внутрішній сервіс не виконав запит',
  'server-failure': 'Сервер повернув помилку',
  'invalid-response': 'Клієнт не розпізнав формат відповіді',
  'command-rejected': 'Сервер відхилив дані дії',
  'session-expired': 'Сесія застаріла — перевідкрий Mini App',
};
export function RequestDiagnostics({ entry }: { entry?: RequestDiagnostic }) {
  const [entries, setEntries] = useState(readRequestDiagnostics),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    const update = () => setEntries(readRequestDiagnostics());
    window.addEventListener('svitanok-request-diagnostic', update);
    return () => window.removeEventListener('svitanok-request-diagnostic', update);
  }, []);
  const rows = entry ? [entry] : entries;
  if (!rows.length) return null;
  return (
    <details className="request-diagnostics">
      <summary>Технічні деталі запиту</summary>
      <p>
        Час, екран, HTTP-код і місце збою. Без ключів, текстів задач та особистих відгуків. Дані
        лише цього сеансу й пристрою.
      </p>
      {rows.slice(0, 5).map((row, i) => (
        <p key={i}>
          {new Date(row.at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })} · {row.area} /{' '}
          {row.operation} · {row.status == null ? 'відповіді HTTP немає' : `HTTP ${row.status}`} ·{' '}
          {explanations[row.code] ?? row.code} · {row.phase}
          <br />
          ID: {row.requestId}
        </p>
      ))}
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(diagnosticReport(rows))
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? 'Скопійовано' : 'Скопіювати звіт про помилку'}
      </button>
      <pre tabIndex={0}>{diagnosticReport(rows)}</pre>
    </details>
  );
}
