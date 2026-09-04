import type { ReactNode } from 'react';
import './Badge.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'muted';

export interface BadgeProps {
  readonly tone?: BadgeTone | undefined;
  /** Kernel values (profiles, statuses, tool lifecycle) render verbatim in here. */
  readonly children: ReactNode;
  /** Hover explanation: what the value means, or the full ISO date. */
  readonly title?: string | undefined;
  readonly mono?: boolean | undefined;
}

/** Status pill. Colour is meaning: it never decorates a label. */
export function Badge({ tone = 'neutral', children, title, mono = false }: BadgeProps): ReactNode {
  return (
    <span className={`badge badge--${tone}${mono ? ' badge--mono' : ''}`} title={title}>
      {children}
    </span>
  );
}
