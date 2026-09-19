/**
 * AlarmAnnouncer — a newly raised critical or high alarm is announced, not
 * only blinked (FE-HIGH-080).
 *
 * The operator shell signalled a new critical alarm with a border blink and a
 * pulsing icon and nothing else, so a non-sighted or low-vision operator got
 * no notification of a safety-critical alarm. This live region announces
 * count increases per severity; it renders nothing visible.
 */
import React, { useEffect, useRef, useState } from 'react';

import { normalizeSeverity, type Severity } from '@aquaculture/shared-ui';

const ANNOUNCED: readonly Severity[] = ['critical', 'high'];

export interface AlarmAnnouncerProps {
  alarms: ReadonlyArray<{ id: string; severity: string }>;
}

export const AlarmAnnouncer: React.FC<AlarmAnnouncerProps> = ({ alarms }) => {
  const previous = useRef<Record<Severity, number> | null>(null);
  const [message, setMessage] = useState<{ text: string; tick: number } | null>(null);

  useEffect(() => {
    const counts = {
      critical: 0,
      high: 0,
      medium: 0,
      warning: 0,
      low: 0,
      info: 0,
    } satisfies Record<Severity, number>;
    for (const alarm of alarms) counts[normalizeSeverity(alarm.severity)] += 1;
    const before = previous.current;
    previous.current = counts;
    if (before === null) return;
    const parts = ANNOUNCED.filter((level) => counts[level] > before[level]).map((level) => {
      const added = counts[level] - before[level];
      return `${added} new ${level} alarm${added > 1 ? 's' : ''}`;
    });
    if (parts.length > 0) setMessage((m) => ({ text: parts.join(', '), tick: (m?.tick ?? 0) + 1 }));
  }, [alarms]);

  return (
    <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
      {message && <span key={message.tick}>{message.text}</span>}
    </div>
  );
};
