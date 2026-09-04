import type { ReactNode } from 'react';
import type { BadgeTone } from './Badge.tsx';
import './StatusDot.css';

export interface StatusDotProps {
  readonly tone: BadgeTone;
  /** The kernel value, rendered verbatim. Colour never replaces the word. */
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly mono?: boolean | undefined;
}

/**
 * Inline state marker for dense table cells, where a badge would be too heavy.
 *
 * WHY: colour alone fails for colour-blind operators and in print, so the dot is
 * always accompanied by the literal status word it colours.
 */
export function StatusDot({ tone, children, title, mono = false }: StatusDotProps): ReactNode {
  return (
    <span className={`status-dot status-dot--${tone}${mono ? ' status-dot--mono' : ''}`} title={title}>
      <span className="status-dot__mark" aria-hidden="true" />
      <span className="status-dot__label">{children}</span>
    </span>
  );
}
