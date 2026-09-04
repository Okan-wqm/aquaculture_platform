import type { ReactNode } from 'react';
import { EMPTY } from '../../design/format.ts';

export interface EvidenceRefsProps {
  readonly refs: ReadonlyArray<string>;
  readonly max?: number | undefined;
}

/**
 * Evidence references as monospace chips.
 *
 * WHY: a claim without its evidence pointer is unverifiable, so the refs must be
 * legible in the row itself rather than hidden behind a click. WHAT: the first
 * `max` refs render inline; the remainder collapse into a `+n` chip whose title
 * lists them, and the accessible label states how many there are in total.
 */
export function EvidenceRefs({ refs, max = 4 }: EvidenceRefsProps): ReactNode {
  if (refs.length === 0) {
    return (
      <span className="muted" title="No evidence reference recorded">
        {EMPTY}
      </span>
    );
  }
  const shown = refs.slice(0, max);
  const rest = refs.length - shown.length;
  return (
    <ul className="chip-list" aria-label={refs.length === 1 ? '1 evidence reference' : `${refs.length} evidence references`}>
      {shown.map((ref, index) => (
        <li key={`${ref}-${index}`} className="chip" title={ref}>
          {ref}
        </li>
      ))}
      {rest > 0 ? (
        <li className="chip" title={refs.slice(max).join('\n')}>
          +{rest}
        </li>
      ) : null}
    </ul>
  );
}
