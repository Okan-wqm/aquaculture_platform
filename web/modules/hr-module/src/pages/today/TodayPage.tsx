/**
 * Team › Today (/hr/today) — who is in today, who is late or absent, whose
 * leave covers today and which sites nobody is responsible for.
 *
 * Real reads only, each from the hook that already owns it:
 *   - useDailyAttendanceOverview(today)   → KPI attendance counts
 *   - useTeamTodaysAttendance()           → every record of today (managers;
 *                                           hr-service narrows other roles to
 *                                           their own record)
 *   - useTeamWeeklyOverview(week, -, site) → today's planned shifts, narrowed
 *                                           by site on the server
 *   - useTeamLeaveCalendar(-, today, today) → approved + pending leave today
 *   - useSiteResponsibility()             → farm-service active sites + contacts
 * Every read except the sites follows the workspace's module (the hooks resolve
 * it themselves); the site filter and panel appear only where farm sites apply
 * (see showsFarmSites). Salary is not shown here by design (see the roster footer).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { PageHeader, useI18n } from '@aquaculture/shared-ui';
import { ScopedDescription } from '../../components/common';

import { useDailyAttendanceOverview, useTeamTodaysAttendance } from '../../hooks/useAttendance';
import { useTeamLeaveCalendar } from '../../hooks/useLeaves';
import { useModuleScope } from '../../hooks/useModuleScope';
import { formatDateISO, getWeekMonday, useTeamWeeklyOverview } from '../../hooks/useScheduling';
import { useSiteResponsibility } from '../../hooks/useSiteResponsibility';
import { OpenLeavePanel } from './OpenLeavePanel';
import { SiteFilterChips } from './SiteFilterChips';
import { TodayKpiBand } from './TodayKpiBand';
import { TodayRosterTable } from './TodayRosterTable';
import { UnassignedSitesPanel } from './UnassignedSitesPanel';
import { showsFarmSites } from './siteScope';
import { buildTodayRoster } from './todayRoster';
import { unassignedSites } from './unassignedSites';

const MINUTE_MS = 60_000;

/**
 * The page's clock, ticking each minute: "today" rolls over at midnight and a
 * planned shift turns from "not started" to "not clocked in" without a reload
 * (todaysAttendance already refetches each minute).
 */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function TodayPage(): React.JSX.Element {
  const { t } = useI18n();
  const now = useMinuteClock();
  const today = formatDateISO(now);
  const weekStart = formatDateISO(getWeekMonday(now));
  const farmSites = showsFarmSites(useModuleScope());
  const [chosenSiteId, setSiteId] = useState<string | undefined>(undefined);
  // A site picked in Production must not keep narrowing the plan after the reader
  // moves to a workspace where sites do not apply.
  const siteId = farmSites ? chosenSiteId : undefined;

  const overview = useDailyAttendanceOverview(today);
  const attendance = useTeamTodaysAttendance();
  const team = useTeamWeeklyOverview(weekStart, undefined, siteId);
  const leave = useTeamLeaveCalendar(undefined, today, today);
  const sites = useSiteResponsibility();

  const roster = useMemo(
    () =>
      buildTodayRoster({
        plans: team.data?.employeePlans ?? [],
        records: attendance.data ?? [],
        today,
        now,
        includeUnplanned: siteId === undefined,
      }),
    [team.data, attendance.data, today, now, siteId],
  );

  // teamLeaveCalendar takes no site; under a site filter the list keeps the
  // people the site-filtered plan returned.
  const openLeave = useMemo(() => {
    const entries = leave.data ?? [];
    if (siteId === undefined) return entries;
    const onSite = new Set((team.data?.employeePlans ?? []).map((plan) => plan.employeeId));
    return entries.filter((entry) => onSite.has(entry.employeeId));
  }, [leave.data, team.data, siteId]);

  const flaggedSites = useMemo(() => unassignedSites(sites.data ?? []), [sites.data]);
  const scheduled = team.data?.daysSummary.find((day) => day.date === today)?.workingCount;

  return (
    <div className="sd-page sd-stack">
      <PageHeader
        title={t('hr.today.title')}
        description={<ScopedDescription text={t('hr.today.description')} />}
      />
      <TodayKpiBand
        overview={overview.data}
        overviewError={overview.isError}
        onRetryOverview={() => void overview.refetch()}
        scheduled={scheduled}
        siteScoped={siteId !== undefined}
      />
      {farmSites && (
        <SiteFilterChips sites={sites.data ?? []} selected={siteId} onSelect={setSiteId} />
      )}
      <TodayRosterTable
        rows={roster}
        isLoading={team.isLoading || attendance.isLoading}
        isError={team.isError || attendance.isError}
        onRetry={() => {
          void team.refetch();
          void attendance.refetch();
        }}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <OpenLeavePanel
          entries={openLeave}
          isLoading={leave.isLoading || (siteId !== undefined && team.isLoading)}
          isError={leave.isError}
          onRetry={() => void leave.refetch()}
        />
        {farmSites && (
          <UnassignedSitesPanel
            sites={flaggedSites}
            isLoading={sites.isLoading}
            isError={sites.isError}
            onRetry={() => void sites.refetch()}
          />
        )}
      </div>
    </div>
  );
}

export default TodayPage;
