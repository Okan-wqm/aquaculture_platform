/**
 * Team › Today (/hr/today) — who is in today, who is late or absent, whose
 * leave covers today and which sites nobody is responsible for.
 *
 * Real reads only, each from the hook that already owns it:
 *   - useDailyAttendanceOverview(today)   → KPI attendance counts
 *   - useTodaysAttendance()               → every record of today (managers;
 *                                           hr-service narrows other roles to
 *                                           their own record)
 *   - useTeamWeeklyOverview(week, -, site) → today's planned shifts, narrowed
 *                                           by site on the server
 *   - useTeamLeaveCalendar(-, today, today) → approved + pending leave today
 *   - useSiteResponsibility()             → farm-service active sites + contacts
 * Salary is not shown here by design (see the roster footer).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { PageHeader, useI18n } from '@aquaculture/shared-ui';

import { useDailyAttendanceOverview, useTodaysAttendance } from '../../hooks/useAttendance';
import { useTeamLeaveCalendar } from '../../hooks/useLeaves';
import { formatDateISO, getWeekMonday, useTeamWeeklyOverview } from '../../hooks/useScheduling';
import { useSiteResponsibility } from '../../hooks/useSiteResponsibility';
import { OpenLeavePanel } from './OpenLeavePanel';
import { SiteFilterChips } from './SiteFilterChips';
import { TodayKpiBand } from './TodayKpiBand';
import { TodayRosterTable } from './TodayRosterTable';
import { UnassignedSitesPanel } from './UnassignedSitesPanel';
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
  const [siteId, setSiteId] = useState<string | undefined>(undefined);

  const overview = useDailyAttendanceOverview(today);
  const attendance = useTodaysAttendance();
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
      <PageHeader title={t('hr.today.title')} description={t('hr.today.description')} />
      <TodayKpiBand
        overview={overview.data}
        overviewError={overview.isError}
        onRetryOverview={() => void overview.refetch()}
        scheduled={scheduled}
        siteScoped={siteId !== undefined}
      />
      <SiteFilterChips sites={sites.data ?? []} selected={siteId} onSelect={setSiteId} />
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
        <UnassignedSitesPanel
          sites={flaggedSites}
          isLoading={sites.isLoading}
          isError={sites.isError}
          onRetry={() => void sites.refetch()}
        />
      </div>
    </div>
  );
}

export default TodayPage;
