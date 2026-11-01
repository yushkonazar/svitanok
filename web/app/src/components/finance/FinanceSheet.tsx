import { Children, cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { Sheet as BaseSheet } from '../ui/Sheet.tsx';
import './finance-analytics.css';

/** Keep the existing form header and its pending/close behavior; supply one where absent. */
export function Sheet({ children, label = 'Фінанси', ...props }: ComponentProps<typeof BaseSheet>) {
  const close = (
    <button
      type="button"
      className="renewal-secondary"
      aria-label="Закрити вікно"
      onClick={props.onClose}
    >
      ×
    </button>
  );
  const content = Children.toArray(children);
  let body: ReactNode;
  const container = content.length === 1 ? content[0] : null;
  if (
    isValidElement<{ children?: ReactNode; className?: string }>(container) &&
    typeof container.type === 'string'
  ) {
    const nodes = Children.toArray(container.props.children);
    const first = nodes[0];
    if (
      isValidElement<{ children?: ReactNode; className?: string }>(first) &&
      first.props.className?.includes('renewal-section-head')
    ) {
      const parts = Children.toArray(first.props.children);
      const hasClose = parts.some(
        (node) =>
          isValidElement<{ children?: ReactNode }>(node) &&
          node.type === 'button' &&
          node.props.children === '×',
      );
      if (!hasClose) nodes[0] = cloneElement(first, {}, ...parts, close);
    } else {
      const heading =
        isValidElement(first) && first.type === 'h2' ? (
          nodes.shift()
        ) : (
          <h2 className="text-lg font-bold">{label}</h2>
        );
      nodes.unshift(
        <div className="renewal-section-head" key="sheet-header">
          {heading}
          {close}
        </div>,
      );
    }
    body = cloneElement(container, {}, ...nodes);
  } else
    body = (
      <div className="renewal-finance">
        <div className="renewal-section-head">
          <h2 className="text-lg font-bold">{label}</h2>
          {close}
        </div>
        {children}
      </div>
    );
  return (
    <BaseSheet {...props} label={label} panelClassName="finance-sheet">
      {body}
    </BaseSheet>
  );
}
