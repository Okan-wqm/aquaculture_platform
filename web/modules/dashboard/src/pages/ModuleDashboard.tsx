/**
 * The layout every module dashboard shares (design D6 `dashboard` page): the
 * page heading, the module's Site status table, its Active alarms beside the
 * Inbox, and — for a tenant admin — Recent activity.
 *
 * WHY one layout: Production, Control & sensors and Greenhouse differ only in
 * their site table and in the module whose alarms they list; the panels, the
 * order and the gates are the same on all three.
 */
import { PageHeader } from '@aquaculture/shared-ui';
import type { AlertModule } from '@platform/shared-ui/generated/graphql-types';
import { useMemo, type ReactElement, type ReactNode } from 'react';

import { useActiveSites } from '../hooks/useActiveSites';
import { ActiveAlarmsPanel } from '../panels/ActiveAlarmsPanel';
import { InboxPanel } from '../panels/InboxPanel';
import { RecentActivityPanel } from '../panels/RecentActivityPanel';

export interface ModuleDashboardProps {
  readonly title: string;
  readonly description: string;
  readonly module: AlertModule;
  /** The module's Site status table, given the render's clock. */
  readonly siteTable: (now: Date) => ReactNode;
}

export function ModuleDashboard({
  title,
  description,
  module,
  siteTable,
}: ModuleDashboardProps): ReactElement {
  const sites = useActiveSites();
  // Null until the site list answers (or when it failed): no site can be named yet.
  const siteNames = useMemo(
    (): ReadonlyMap<string, string> | null =>
      sites.data === undefined ? null : new Map(sites.data.map((site) => [site.id, site.name])),
    [sites.data],
  );
  // Ages ("12 min ago") are read against the render's clock; every panel
  // re-renders on its refresh.
  const now = new Date();

  return (
    <div className="sd-page sd-stack">
      <PageHeader title={title} description={description} />
      {siteTable(now)}
      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-2">
        <ActiveAlarmsPanel module={module} siteNames={siteNames} now={now} />
        <InboxPanel now={now} />
      </div>
      <RecentActivityPanel now={now} />
    </div>
  );
}
