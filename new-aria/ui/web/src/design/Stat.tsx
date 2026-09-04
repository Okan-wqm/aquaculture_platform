import type { ReactNode } from 'react';
import './Stat.css';

export interface StatProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: 'default' | 'danger' | 'warning' | 'success' | undefined;
}

/** Single KPI tile. Value is a ReactNode so callers can pass a Badge or Timestamp. */
export function Stat({ label, value, hint, tone = 'default' }: StatProps): ReactNode {
  return (
    <div className={`stat stat--${tone}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint !== undefined ? <span className="stat__hint">{hint}</span> : null}
    </div>
  );
}
