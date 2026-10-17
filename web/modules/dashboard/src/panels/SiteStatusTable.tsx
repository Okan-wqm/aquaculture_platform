/**
 * Site status — one row per site (or per zone), generic over the row model.
 *
 * WHY generic: the three module dashboards show the same table — a site
 * cell, an alarm cell, the module's own readings — over different row models
 * (model/production, model/control, model/greenhouse). The table is shared-ui
 * DataTable inside a dashboard panel; a row whose worst open alarm is P1 or
 * P2 carries the hazard stripe on its leading edge (colour only for what is
 * abnormal), and the row's way in is the site cell's link.
 *
 * WHY a static table: the rows are a status board of the viewer's few sites
 * in the module's own order, and their cells are composed values (a reading
 * with its limit, a tally of glyphs), not the sortable or searchable scalars
 * DataTable's toolbar works on. So no search box, no sort buttons and no row
 * hover — none of which would do anything here.
 */
import { DataTable, useI18n, type AlarmPriority } from '@aquaculture/shared-ui';
import type { ReactElement, ReactNode } from 'react';

import { DashboardPanel } from './DashboardPanel';

export interface SiteColumn<Row> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: Row) => ReactNode;
  readonly width?: string;
}

export interface SiteStatusTableProps<Row> {
  readonly headingId: string;
  readonly title: string;
  readonly status?: ReactNode;
  readonly footnote?: ReactNode;
  readonly columns: readonly SiteColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** The row's worst open alarm, for the hazard stripe; null for none. */
  readonly alarmOf?: (row: Row) => AlarmPriority | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

const STRIPE: Readonly<Partial<Record<AlarmPriority, string>>> = {
  p1: 'shadow-[inset_5px_0_0_var(--color-sd-hz-red)]',
  p2: 'shadow-[inset_5px_0_0_var(--color-sd-hz-amber)]',
};

export function SiteStatusTable<Row>({
  headingId,
  title,
  status,
  footnote,
  columns,
  rows,
  rowKey,
  alarmOf,
  loading,
  failed,
}: SiteStatusTableProps<Row>): ReactElement {
  const { t } = useI18n();
  const tableColumns = columns.map((column) => ({
    key: column.key,
    header: column.header,
    width: column.width,
    render: (_value: unknown, row: Row): ReactNode => column.render(row),
  }));

  return (
    <DashboardPanel headingId={headingId} title={title} status={status} footnote={footnote}>
      {failed ? (
        <p role="alert" className="m-0 px-6 py-6 text-base text-sd-neutral-800">
          {t('dashboard.sites.loadError')}
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={tableColumns}
          keyExtractor={rowKey}
          loading={loading}
          emptyMessage={t('dashboard.sites.empty')}
          rowClassName={(row) => {
            const priority = alarmOf === undefined ? null : alarmOf(row);
            return priority === null ? '' : (STRIPE[priority] ?? '');
          }}
          searchable={false}
          sortable={false}
          hoverable={false}
          flush
        />
      )}
    </DashboardPanel>
  );
}
