/**
 * OrgCycleWarning — says out loud that the department data contains a parent
 * loop. The chart still shows every department (the loop is broken at its first
 * member); this notice is what stops the bad data from being silently tidied away.
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';
import type { OrgDepartment } from './buildOrgTree';

export function OrgCycleWarning({
  cycles,
}: {
  cycles: readonly (readonly OrgDepartment[])[];
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <section
      aria-labelledby="org-cycle-warning-title"
      className="rounded-lg border border-warning-200 bg-warning-50 p-4 text-sm text-warning-900 dark:border-warning-800 dark:bg-warning-900/20 dark:text-warning-100"
    >
      <h2 id="org-cycle-warning-title" className="font-semibold">
        {t('hr.orgChart.cycleHeading')}
      </h2>
      <p className="mt-1">{t('hr.orgChart.cycleBody')}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {cycles.map((cycle) => (
          <li key={cycle.map((department) => department.id).join('>')}>
            {cycle.map((department) => department.name).join(' → ')}
          </li>
        ))}
      </ul>
    </section>
  );
}
