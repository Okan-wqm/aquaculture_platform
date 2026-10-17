/**
 * "On shift today": the roster built by buildTodayRoster, in shared-ui's
 * DataTable. A row whose person is late or not here carries the design's
 * warning bar on its leading edge.
 */
import React, { useId } from 'react';
import { Card, DataTable, type DataTableColumn, useI18n } from '@aquaculture/shared-ui';

import type { RosterRow } from './todayRoster';
import { ClockInCell, EmployeeCell, StateCell } from './RosterCells';
import { PanelBody } from './PanelBody';

export interface TodayRosterTableProps {
  rows: readonly RosterRow[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function TodayRosterTable({
  rows,
  isLoading,
  isError,
  onRetry,
}: TodayRosterTableProps): React.JSX.Element {
  const { t } = useI18n();
  const headingId = useId();

  const columns: DataTableColumn<RosterRow>[] = [
    {
      key: 'employee',
      header: t('hr.today.roster.employee'),
      minWidth: '220px',
      render: (_value, row) => <EmployeeCell row={row} />,
    },
    {
      key: 'clockIn',
      header: t('hr.today.roster.clockIn'),
      width: '96px',
      render: (_value, row) => <ClockInCell row={row} />,
    },
    {
      key: 'state',
      header: t('hr.today.roster.status'),
      width: '170px',
      render: (_value, row) => <StateCell row={row} />,
    },
    // TODO(data): the design's "Tasks" column (today's task count + "+ Assign") is left out —
    // farm-service tasks are keyed by `assignedTo` (an auth user id) while this roster is keyed by
    // hr employee id, and neither teamWeeklyOverview nor todaysAttendance returns Employee.userId;
    // needs a tasks-per-employee read (todaysTasks grouped by assignee joined through Employee.userId).
  ];

  return (
    <section aria-labelledby={headingId}>
      <Card padding="none" title={<span id={headingId}>{t('hr.today.roster.title')}</span>}>
        <PanelBody
          isLoading={isLoading}
          isError={isError}
          onRetry={onRetry}
          isEmpty={rows.length === 0}
          emptyTitle={t('hr.today.roster.empty')}
        >
          <DataTable
            data={rows}
            columns={columns}
            keyExtractor={(row) => row.employeeId}
            searchable={false}
            sortable={false}
            striped={false}
            stickyHeader={false}
            flush
            rowClassName={(row) =>
              row.flagged ? 'shadow-[inset_5px_0_0_var(--color-warning-500)]' : ''
            }
          />
        </PanelBody>
        <p className="border-t border-gray-200 px-6 py-2.5 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300">
          {t('hr.today.salaryNote')}
        </p>
      </Card>
    </section>
  );
}
