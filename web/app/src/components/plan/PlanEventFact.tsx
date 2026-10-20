import type { PlanWorkspace } from '../../api/plan.ts';

function when(iso: string) {
  return new Date(iso).toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PlanEventFact({ event }: { event: PlanWorkspace['events'][number] }) {
  if (event.observedUnits == null || event.reportTarget == null || !event.actualAt)
    return <small>{when(event.at)}</small>;
  return (
    <small className="plan-event-fact">
      <span>
        Факт: {event.observedUnits} / {event.reportTarget} {event.reportUnit}
      </span>
      <span>Час факту: {when(event.actualAt)}</span>
      <span>Записано: {when(event.at)}</span>
      {event.reportRetracted ? (
        <span>Позначку скасовано</span>
      ) : (
        event.eligibleUnits != null &&
        event.eligibleUnits < event.observedUnits && <span>Умову вчасності не виконано.</span>
      )}
    </small>
  );
}
