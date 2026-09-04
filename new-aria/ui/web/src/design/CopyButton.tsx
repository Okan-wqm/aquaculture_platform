import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export interface CopyButtonProps {
  /** Exact text placed on the clipboard — a hash, an id, a path or a command. */
  readonly value: string;
  /** Accessible name; defaults to "Copy". Give the thing a name when there are many. */
  readonly label?: string | undefined;
  /** Show the label next to the glyph instead of only in the accessible name. */
  readonly withText?: boolean | undefined;
}

type CopyOutcome = 'idle' | 'copied' | 'failed';

/**
 * Copies one exact value to the clipboard.
 *
 * WHY: hashes, cycle ids and ledger paths are the currency of this console and
 * re-typing them is where transcription errors enter an evidence trail.
 * WHAT: writes via the async clipboard API and reports the outcome in place; a
 * browser that denies clipboard access (insecure context) reports "Copy failed"
 * rather than silently doing nothing.
 */
export function CopyButton({ value, label = 'Copy', withText = false }: CopyButtonProps): ReactNode {
  const [outcome, setOutcome] = useState<CopyOutcome>('idle');

  useEffect(() => {
    if (outcome === 'idle') {
      return undefined;
    }
    const timer = setTimeout(() => setOutcome('idle'), 2000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setOutcome('copied');
    } catch {
      setOutcome('failed');
    }
  };

  const text = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : label;
  return (
    <button
      type="button"
      className={withText ? 'button button--sm' : 'button button--sm button--icon button--ghost'}
      onClick={() => {
        void copy();
      }}
      title={withText ? undefined : text}
      aria-label={withText ? undefined : text}
    >
      <Icon name={outcome === 'copied' ? 'check' : 'copy'} size={14} />
      {withText ? text : null}
      <span aria-live="polite" className="visually-hidden">
        {outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}
