/**
 * A site's open alarms per priority — the annunciator's glyph-and-count
 * pairs (shared-ui AlarmPriorityCounts), or "None".
 */
import { AlarmPriorityCounts, useI18n, type AlarmPriorityTally } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { worstPriority } from '../model/alarms';

export function AlarmTally({ tally }: { readonly tally: AlarmPriorityTally }): ReactElement {
  const { t } = useI18n();
  return worstPriority(tally) === null ? (
    <span className="text-sm text-sd-neutral-700">{t('dashboard.sites.none')}</span>
  ) : (
    <AlarmPriorityCounts counts={tally} />
  );
}
