import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton.tsx';
import './MonoPanel.css';

export interface MonoPanelProps {
  /** What the block is: "stdout", "stderr", "completion proof", "diff". */
  readonly label: string;
  readonly text: string;
  readonly tone?: 'default' | 'error' | undefined;
  readonly maxHeight?: 'sm' | 'md' | 'lg' | undefined;
  /** Adds a copy control to the panel head. Default true. */
  readonly copyable?: boolean | undefined;
  readonly actions?: ReactNode;
}

/**
 * Monospace output panel for stdout, stderr, JSON and diffs.
 *
 * WHY: kernel output is evidence, so it is rendered as text — never as HTML —
 * and the panel scrolls inside itself rather than stretching the page.
 */
export function MonoPanel({ label, text, tone = 'default', maxHeight = 'md', copyable = true, actions }: MonoPanelProps): ReactNode {
  const empty = text === '';
  return (
    <figure className={`mono-panel mono-panel--${tone} mono-panel--${maxHeight}`}>
      <figcaption className="mono-panel__head">
        <span className="mono-panel__label">{label}</span>
        <span className="row">
          {actions}
          {copyable && !empty ? <CopyButton value={text} label={`Copy ${label}`} /> : null}
        </span>
      </figcaption>
      <pre className="mono-panel__pre" tabIndex={0}>
        {empty ? '(empty)' : text}
      </pre>
    </figure>
  );
}
