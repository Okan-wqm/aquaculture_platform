import type { ReactNode } from 'react';
import { EMPTY } from '../../design/format.ts';

export interface EvidenceRefsProps {
  readonly refs: ReadonlyArray<string>;
  readonly max?: number | undefined;
}

/** Evidence references as monospace chips; hover shows the full ref when truncated. */
export function EvidenceRefs({ refs, max = 4 }: EvidenceRefsProps): ReactNode {
  if (refs.length === 0) {
    return <span className="muted">{EMPTY}</span>;
  }
  const shown = refs.slice(0, max);
  const rest = refs.length - shown.length;
  return (
    <ul className="chip-list" aria-label={`${refs.length} kanıt referansı`}>
      {shown.map((ref, index) => (
        <li key={`${ref}-${index}`} className="chip" title={ref}>
          {ref}
        </li>
      ))}
      {rest > 0 ? <li className="chip" title={refs.slice(max).join('\n')}>+{rest}</li> : null}
    </ul>
  );
}
