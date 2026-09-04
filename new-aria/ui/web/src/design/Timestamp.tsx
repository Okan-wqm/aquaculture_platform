import type { ReactNode } from 'react';
import { EMPTY, formatRelative, parseIso } from './format.ts';
import { useNow } from './now.ts';

export interface TimestampProps {
  readonly value: string | null | undefined;
  /** Show the absolute ISO string inline instead of only on hover. */
  readonly absolute?: boolean | undefined;
}

/** Relative wording with the exact ISO value on hover (and in the machine-readable dateTime). */
export function Timestamp({ value, absolute = false }: TimestampProps): ReactNode {
  const now = useNow();
  const date = parseIso(value);
  if (date === null) {
    return <span className="muted">{EMPTY}</span>;
  }
  const iso = date.toISOString();
  return (
    <time dateTime={iso} title={iso} className="nowrap">
      {absolute ? `${iso} (${formatRelative(iso, now)})` : formatRelative(iso, now)}
    </time>
  );
}
