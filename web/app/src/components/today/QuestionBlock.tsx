import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MockData } from '../../api/briefing-schema.ts';
import { useStats, useMockAnswer } from '../../api/hooks.ts';
import { has, textHash } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';
import { SectionLabel } from '../ui/primitives.tsx';
import { SaveButton } from './SaveButton.tsx';

// 🎤 Питання дня (дизайн v2, Svitanok.dc.html): бейдж теми + стрік; питання
// великим Manrope; «Відповідь ↓» розкриває відповідь із акцентною лінією зліва,
// оцінку «Легко/Важко» і «Вивчити →».
//
// F4: оцінка тепер привʼязана до ПИТАННЯ (stats.mockRated[qId]), а не до дня.
// Доти бекенд знав лише «сьогодні щось оцінено», тож обраний варіант жив у стані
// сесії й після перезавантаження зникав: чипи заблоковані, жоден не підсвічений.
// Думку можна змінити — сервер переставить weak, не додаючи seen.

export function QuestionBlock({ d }: { d: MockData }) {
  const [open, setOpen] = useState(false);
  const { data } = useStats();
  const rate = useMockAnswer();
  const navigate = useNavigate();

  const streak = data?.stats.mock.streak ?? 0;
  const qId = textHash(d.question);
  // Джерело правди — сервер; сесійного стану більше немає.
  const picked = data?.stats.mockRated?.[qId] ?? null;

  // F4: «Вивчити» -> куроване джерело роадмепу для теми питання. Доти це був
  // google.com/search за текстом питання — тобто зізнання, що ми не знаємо, куди
  // відправити. resourceUrl лишається фолбеком для старих брифінгів у KV.
  const material = data?.stats.mockMaterials?.[d.topic ?? '']?.[0] ?? null;

  const learn = () => {
    haptic('light');
    if (material) openLink(material.url);
    else if (has(d.resourceUrl)) openLink(d.resourceUrl!);
    else navigate('/stats'); // фолбек — блок роадмепу в статистиці
  };

  const doRate = (v: 'easy' | 'hard') => {
    rate.mutate({ qId, topic: d.topic || '', rating: v });
    haptic('success');
  };

  // Чип лишається активним і після оцінки: думку можна змінити, і сервер це
  // коректно переставить (F4). Доти невибраний чип назавжди блокувався.
  const chip = (v: 'easy' | 'hard', label: string) => {
    const on = picked === v;
    const pos = v === 'easy';
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => doRate(v)}
        className="rounded-full border px-3 py-1.5 text-[11.5px] font-semibold transition-colors"
        style={{
          background: on
            ? pos
              ? 'rgba(120,220,160,.15)'
              : 'rgba(255,120,120,.13)'
            : 'var(--color-glass)',
          borderColor: on ? (pos ? 'var(--color-pos)' : 'var(--color-neg)') : 'var(--color-glassb)',
          color: on ? (pos ? 'var(--color-pos)' : 'var(--color-neg)') : 'var(--color-tx2)',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        {has(d.topic) && (
          <span
            className="rounded-[5px] px-1.5 py-[2.5px] font-mono text-[9px] font-bold tracking-[0.06em]"
            style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
          >
            {d.topic!.toUpperCase()}
          </span>
        )}
        <SectionLabel>ПИТАННЯ ДНЯ</SectionLabel>
        {streak > 0 && (
          <span className="ml-auto font-mono text-[10px] font-semibold text-a2">🔥 СТРІК {streak}</span>
        )}
        <div className={streak > 0 ? '' : 'ml-auto'}>
          <SaveButton kind="question" id={qId} title={d.question} />
        </div>
      </div>

      <div className="text-lg font-bold leading-[1.35] tracking-[-0.015em]">{d.question}</div>

      {open ? (
        <div className="flex flex-col gap-2.5" style={{ animation: 'fadeUp .28s ease' }}>
          {has(d.answer) ? (
            <div
              className="py-0.5 pl-3 text-[13px] leading-[1.6] text-tx2"
              style={{ borderLeft: '2px solid var(--color-a2)' }}
            >
              {d.answer}
            </div>
          ) : (
            <div className="py-0.5 pl-3 text-[13px] leading-[1.6] text-tx3" style={{ borderLeft: '2px solid var(--color-glassb)' }}>
              Відповідь з’явиться згодом. Спробуй відповісти вголос — тренування до співбесіди.
            </div>
          )}
          {has(d.answer) && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-medium text-tx3">ОЦІНИ:</span>
              {chip('easy', 'Легко')}
              {chip('hard', 'Важко')}
              <button
                type="button"
                onClick={learn}
                title={material?.title}
                className="ml-auto truncate text-[11.5px] font-semibold text-tx2"
              >
                {material ? `${material.title} →` : 'Вивчити →'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-4 whitespace-nowrap text-xs font-semibold">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="pb-0.5 text-a1"
            style={{ borderBottom: '1.5px solid rgba(255,138,147,.4)' }}
          >
            Відповідь ↓
          </button>
          <span className="text-tx3">Легко</span>
          <span className="text-tx3">Важко</span>
          <button type="button" onClick={learn} className="ml-auto text-tx2">
            Вивчити →
          </button>
        </div>
      )}
    </div>
  );
}
