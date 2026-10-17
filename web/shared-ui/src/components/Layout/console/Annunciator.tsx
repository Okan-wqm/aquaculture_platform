/**
 * Annunciator — the tenant console's alarm strip under the header (design
 * handoff "Tenant Console — Industrial", README §7.5).
 *
 * WHAT: a labelled region of four tile buttons — CRIT, HIGH, MED, UNACK — in
 * four columns, two when the console column (the `page` container) is 820 px
 * or narrower. A tile with alarms lights: CRIT hazard red, HIGH hazard amber,
 * MED and UNACK on the surface; a zero count is a grey tile. CRIT's square
 * flashes while a P1 alarm awaits acknowledgement (see AnnunciatorGlyph for
 * why the flash is kept, and how it stops). While the counts load every tile shows "—"; when the query fails
 * every tile greys out and its title says so. The tile of the active filter is
 * pressed (`aria-pressed`); pressing a tile selects its filter, pressing the
 * pressed tile clears it — `onSelect(null)`. The caller routes the choice
 * (the alarm list reads it as `?priority=`, see AnnunciatorPriority).
 *
 * WHY the props carry only real counts: the strip has no value of its own. A
 * count is a number only when `status` is 'ready'; any other status ignores
 * the counts it is given, so a stale or absent number can never light a tile.
 * There is no 'unavailable' status: a viewer who cannot read alarms gets no
 * strip at all, and the caller decides that before rendering it.
 */
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';
import type { MessageKey } from '../../../i18n';

import { ANNUNCIATOR_FILTERS, type AnnunciatorFilter } from './AnnunciatorPriority';
import type { ConsoleDataStatus } from './headerTypes';
import { AnnunciatorTile, type AnnunciatorTone } from './AnnunciatorTile';

/** The console data status without 'unavailable' — a viewer who cannot read alarms gets no strip. */
export type AnnunciatorStatus = Exclude<ConsoleDataStatus, 'unavailable'>;

/** Count per tile; null while not known. Only read when the status is 'ready'. */
export type AnnunciatorCounts = Readonly<Record<AnnunciatorFilter, number | null>>;

export interface AnnunciatorProps {
  readonly status: AnnunciatorStatus;
  readonly counts: AnnunciatorCounts;
  /**
   * The P1 alarms nobody has acknowledged — CRIT's square flashes while any
   * wait and stops once all are acknowledged; null while not known. Read
   * only when the status is 'ready', like the counts.
   */
  readonly unacknowledgedP1: number | null;
  /** The filter the alarm list shows now, or null when it shows every alarm. */
  readonly activePriority: AnnunciatorFilter | null;
  /** A tile was pressed: its filter, or null when the pressed tile was pressed again. */
  readonly onSelect: (priority: AnnunciatorFilter | null) => void;
  readonly className?: string;
}

const LIT_TONE: Readonly<Record<AnnunciatorFilter, AnnunciatorTone>> = {
  p1: 'crit',
  p2: 'high',
  p3: 'med',
  unack: 'unack',
};

const TEXT: Readonly<Record<AnnunciatorFilter, { code: MessageKey; label: MessageKey }>> = {
  p1: { code: 'annunciator.code.p1', label: 'annunciator.label.p1' },
  p2: { code: 'annunciator.code.p2', label: 'annunciator.label.p2' },
  p3: { code: 'annunciator.code.p3', label: 'annunciator.label.p3' },
  unack: { code: 'annunciator.code.unack', label: 'annunciator.label.unack' },
};

/** What a reader hears in place of a count that is not known. */
const PENDING_STATUS: Readonly<Record<AnnunciatorStatus, MessageKey | null>> = {
  loading: 'annunciator.loading',
  error: 'annunciator.unavailable',
  ready: null,
};

function toneOf(id: AnnunciatorFilter, count: number | null): AnnunciatorTone {
  return count !== null && count > 0 ? LIT_TONE[id] : 'idle';
}

export function Annunciator({
  status,
  counts,
  unacknowledgedP1,
  activePriority,
  onSelect,
  className = '',
}: AnnunciatorProps): ReactElement {
  const { t } = useI18n();
  const pendingKey = PENDING_STATUS[status];
  const pendingStatus = pendingKey === null ? undefined : t(pendingKey);
  const errorTitle = status === 'error' ? t('annunciator.error') : undefined;
  const awaitingAck = status === 'ready' && unacknowledgedP1 !== null && unacknowledgedP1 > 0;

  return (
    <section
      aria-label={t('annunciator.region')}
      aria-busy={status === 'loading' ? true : undefined}
      className={`grid grid-cols-4 gap-px border-t border-sd-rule bg-sd-rule @max-[821px]/page:grid-cols-2 print:hidden ${className}`.trim()}
    >
      {ANNUNCIATOR_FILTERS.map((id) => {
        const count = status === 'ready' ? counts[id] : null;
        const pressed = activePriority === id;
        return (
          <AnnunciatorTile
            key={id}
            id={id}
            tone={toneOf(id, count)}
            count={count}
            code={t(TEXT[id].code)}
            label={t(TEXT[id].label)}
            pressed={pressed}
            flashing={id === 'p1' && awaitingAck}
            status={pendingStatus}
            title={errorTitle}
            onPress={() => onSelect(pressed ? null : id)}
          />
        );
      })}
    </section>
  );
}
