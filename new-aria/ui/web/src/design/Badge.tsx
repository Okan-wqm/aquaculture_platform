import type { ReactNode } from 'react';
import './Badge.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'muted';

export interface BadgeProps {
  readonly tone?: BadgeTone | undefined;
  readonly children: ReactNode;
  /** Hover explanation (Turkish gloss for an English kernel value, or the full ISO date). */
  readonly title?: string | undefined;
  readonly mono?: boolean | undefined;
}

export function Badge({ tone = 'neutral', children, title, mono = false }: BadgeProps): ReactNode {
  return (
    <span className={`badge badge--${tone}${mono ? ' badge--mono' : ''}`} title={title}>
      {children}
    </span>
  );
}
