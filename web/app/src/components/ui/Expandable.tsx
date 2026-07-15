import { useState } from 'react';
import type { ReactNode, MouseEvent } from 'react';

// Розгортання по кліку (роадмеп v3, E2) — відповідник vanilla expandable
// (index.html:1549-1563). Клік на посиланні/кнопці всередині НЕ згортає
// (як делегований guard closest('a,button')). swap: у розгорнутому стані base
// ховається, показується more (погодна плитка); інакше more з'являється під base.

export function Expandable({
  base,
  more,
  swap = false,
}: {
  base: ReactNode;
  more: ReactNode;
  swap?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('a,button')) return;
    setOpen((v) => !v);
  };

  return (
    <div onClick={onClick} className="cursor-pointer select-none">
      {swap ? (
        open ? (
          more
        ) : (
          base
        )
      ) : (
        <>
          {base}
          {open && more}
        </>
      )}
    </div>
  );
}
