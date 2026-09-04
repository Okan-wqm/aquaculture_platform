import type { ReactNode } from 'react';
import './MonoPanel.css';

export interface MonoPanelProps {
  readonly label: string;
  readonly text: string;
  readonly tone?: 'default' | 'error' | undefined;
  readonly maxHeight?: 'sm' | 'md' | 'lg' | undefined;
}

/** Monospace output panel (stdout/stderr/JSON). Text is rendered as text; never HTML. */
export function MonoPanel({ label, text, tone = 'default', maxHeight = 'md' }: MonoPanelProps): ReactNode {
  return (
    <figure className={`mono-panel mono-panel--${tone} mono-panel--${maxHeight}`}>
      <figcaption className="mono-panel__label">{label}</figcaption>
      <pre className="mono-panel__pre" tabIndex={0}>
        {text === '' ? '(boş)' : text}
      </pre>
    </figure>
  );
}
