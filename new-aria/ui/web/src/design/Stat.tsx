import type { ReactNode } from 'react';
import './Stat.css';

export interface StatProps {
  readonly label: string;
  /** ReactNode so a caller can pass a Badge, a Timestamp or a formatted number. */
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  /** State tint. Use it only when the number itself is the problem. */
  readonly tone?: 'default' | 'danger' | 'warning' | 'success' | undefined;
  /** Smaller value type for tiles that carry a word rather than a number. */
  readonly compact?: boolean | undefined;
}

/** One metric tile: uppercase label, tabular value, optional hint line. */
export function Stat({ label, value, hint, tone = 'default', compact = false }: StatProps): ReactNode {
  return (
    <div className={`stat stat--${tone}${compact ? ' stat--compact' : ''}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint !== undefined ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}
