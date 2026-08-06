/**
 * ReportsPage — the v4 Reports destination: what the farm looks like right now,
 * and what a regulator is waiting for.
 *
 * TWO SECTIONS, ONE SCREEN. The v4 design shows analytics here; the app's
 * existing `/reports` was the Mattilsynet draft queue. Rather than displace one
 * with the other, both live here: a manager opening Reports on a shift check
 * wants the farm's shape, and the person who owns the submissions wants the
 * deadlines — and the second group is a subset of the first.
 *
 * The regulatory section keeps its own constraints rather than pushing them up
 * to the whole screen: it is MODULE_MANAGER-gated at the route and ONLINE-ONLY
 * by design (a regulator submission never sits in a device queue). Scoping those
 * to the section means a MODULE_USER sees a useful Reports tab instead of an
 * empty one, and an offline worker still reads the farm summary.
 *
 * WHAT IS DELIBERATELY ABSENT: the design's two trend charts — average weight
 * over 7/30/90 days and mortality per bucket. The mobile client has no
 * time-series query. `farmStockInventory` is a snapshot, `stockEventsSummary`
 * returns a this-week count and a recent-event list, and `batchGrowthPrediction`
 * is a single forward estimate. Drawing a trend from any of those would mean
 * inventing the history, so the period selector and both charts are not built.
 * The gap is a tracked finding, not an oversight.
 */
import { useQuery } from '@tanstack/react-query';
import { CloudOff, FileText, TrendingUp } from 'lucide-react';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Card, Chip, EmptyState, ListRow, Skeleton, StatTile } from '@/components/ui';
import type { MobileReportDeadlinesQuery } from '@/generated/graphql';
import { MOBILE_REPORT_DEADLINES } from '@/graphql/operations';
import { useAuth } from '@/hooks/useAuth';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useTanks } from '@/hooks/useTanks';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { useFeatureAccess } from '@/utils/feature-access';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

type DeadlineRow = MobileReportDeadlinesQuery['reportDeadlines'][number];

const REPORT_TYPE_LABELS: Record<string, string> = {
  SEA_LICE: 'Sea Lice (weekly)',
  CLEANER_FISH: 'Cleaner Fish (monthly)',
  SMOLT: 'Smolt (monthly)',
  SLAUGHTER_PLANNED: 'Slaughter Planned',
  SLAUGHTER_EXECUTED: 'Slaughter Executed',
  BIOMASS: 'Biomass (Altinn)',
};

/** The consent thresholds the unit detail's meter also uses. */
const WATCH_AT = 70;
const LIMIT_AT = 90;

function periodLabel(row: DeadlineRow): string {
  if (row.periodWeek != null) return `${row.periodYear} · W${row.periodWeek}`;
  if (row.periodMonth != null) {
    return `${row.periodYear}-${String(row.periodMonth).padStart(2, '0')}`;
  }
  return String(row.periodYear);
}

function dueLabel(row: DeadlineRow): { text: string; tone: 'crit' | 'warn' | 'neutral' } {
  if (row.overdue) return { text: 'Overdue', tone: 'crit' };
  if (row.daysUntilDue != null && row.daysUntilDue <= 2) {
    return { text: `Due in ${row.daysUntilDue}d`, tone: 'warn' };
  }
  return { text: row.dueAt ? `Due ${row.dueAt}` : 'Unscheduled', tone: 'neutral' };
}

export function ReportsPage(): JSX.Element {
  const navigate = useNavigate();
  const isOnline = useNetworkStatus();
  const { tenantId, isAuthenticated } = useAuth();
  const { data: tanks, isLoading: tanksLoading, isError: tanksError } = useTanks();
  // SEC-MEDIUM-050: the regulatory section carries a MODULE_MANAGER floor, the
  // same one the route enforces. Gating the SECTION rather than the screen is
  // what lets a MODULE_USER still read the farm summary above it.
  const { canReach } = useFeatureAccess();
  const canSeeRegulatory = canReach('reports');

  const deadlinesQuery = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'reportDeadlines'),
    queryFn: async () => {
      const result = await graphqlRequest<MobileReportDeadlinesQuery>(MOBILE_REPORT_DEADLINES, {});
      return result.reportDeadlines;
    },
    enabled: isAuthenticated && !!tenantId && isOnline && canSeeRegulatory,
    staleTime: 1000 * 60,
  });

  const rows = useMemo(
    () =>
      (deadlinesQuery.data ?? [])
        .slice()
        .sort(
          (a, b) =>
            Number(b.overdue) - Number(a.overdue) ||
            (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'),
        ),
    [deadlinesQuery.data],
  );

  /**
   * Farm shape from the inventory snapshot. Average weight is biomass-weighted,
   * not a mean of means: a 100k-fish pen and a 5k-fish pen contribute in
   * proportion, which is the number a manager is actually asking for.
   */
  const summary = useMemo(() => {
    const stocked = (tanks ?? []).filter((t) => t.batchMetrics?.batchId);
    const fish = stocked.reduce((n, t) => n + (t.batchMetrics?.pieces ?? 0), 0);
    const biomassKg = stocked.reduce((n, t) => n + (t.batchMetrics?.biomass ?? 0), 0);
    const atWatch = stocked.filter((t) => (t.batchMetrics?.capacityUsedPercent ?? 0) >= WATCH_AT);
    const atLimit = stocked.filter((t) => (t.batchMetrics?.capacityUsedPercent ?? 0) >= LIMIT_AT);
    return {
      stockedCount: stocked.length,
      totalCount: (tanks ?? []).length,
      fish,
      biomassKg,
      // Grams per fish, from the totals rather than averaged averages.
      avgWeightG: fish > 0 ? (biomassKg * 1000) / fish : 0,
      atWatch: atWatch.length,
      atLimit: atLimit.length,
      densest: stocked
        .slice()
        .sort(
          (a, b) =>
            (b.batchMetrics?.capacityUsedPercent ?? 0) - (a.batchMetrics?.capacityUsedPercent ?? 0),
        )
        .slice(0, 5),
    };
  }, [tanks]);

  return (
    <div className="pb-32">
      <AppHeader title="Reports" subtitle="Farm summary and submissions" />

      <div className="px-4 flex flex-col gap-6">
        {/* ── Farm summary ───────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <h2 className="text-body font-semibold text-ink-3 px-1">Farm summary</h2>
          {tanksLoading ? (
            <Skeleton variant="tile" count={2} />
          ) : tanksError ? (
            // "Nothing stocked" is a claim about the farm. A failed fetch is not
            // entitled to make it.
            <EmptyState
              tone="error"
              icon={<TrendingUp size={22} />}
              title="Could not load the farm summary"
              description="These figures are unavailable, not zero."
            />
          ) : summary.stockedCount === 0 ? (
            <EmptyState
              icon={<TrendingUp size={22} />}
              title="Nothing stocked"
              description="Summary figures appear once a batch is stocked into a unit."
              className="py-6"
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  label="Average weight"
                  value={summary.avgWeightG.toFixed(0)}
                  unit="g"
                  caption="Biomass-weighted across stocked units"
                />
                <StatTile
                  label="Standing biomass"
                  value={(summary.biomassKg / 1000).toFixed(1)}
                  unit="t"
                  caption={`${summary.fish.toLocaleString()} fish`}
                />
              </div>
              {summary.atLimit > 0 ? (
                <StatTile
                  label="Units at consent limit"
                  value={String(summary.atLimit)}
                  state="crit"
                  caption={`Of ${summary.stockedCount} stocked · limit ${LIMIT_AT}%`}
                />
              ) : summary.atWatch > 0 ? (
                <StatTile
                  label="Units past the watch line"
                  value={String(summary.atWatch)}
                  state="warn"
                  caption={`Of ${summary.stockedCount} stocked · watch ${WATCH_AT}%`}
                />
              ) : (
                <StatTile
                  label="Units past the watch line"
                  value="0"
                  caption={`All ${summary.stockedCount} stocked units below ${WATCH_AT}%`}
                />
              )}
            </>
          )}
        </section>

        {/* ── Densest units ──────────────────────────────────────────── */}
        {summary.densest.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-body font-semibold text-ink-3 px-1">Closest to consent</h2>
            {summary.densest.map((t) => {
              const pct = t.batchMetrics?.capacityUsedPercent ?? 0;
              return (
                <ListRow
                  key={t.id}
                  leading={t.code || t.name}
                  tone={pct >= LIMIT_AT ? 'crit' : pct >= WATCH_AT ? 'warn' : 'neutral'}
                  title={t.name}
                  subtitle={`${(t.batchMetrics?.density ?? 0).toFixed(1)} kg/m³`}
                  trailing={<span className="font-mono">{pct.toFixed(0)}%</span>}
                  onClick={() => navigate(`/tank/${t.id}`)}
                />
              );
            })}
            <p className="text-meta text-ink-3 px-1">
              Trends over time need a history query the mobile client does not have yet — these are
              today&apos;s figures, not a series.
            </p>
          </section>
        )}

        {/* ── Regulatory submissions ─────────────────────────────────── */}
        {canSeeRegulatory && (
          <section className="flex flex-col gap-2">
            <h2 className="text-body font-semibold text-ink-3 px-1">Regulatory submissions</h2>

            {!isOnline && (
              <Card className="p-3.5 flex items-center gap-3 border-warn">
                <span className="w-9 h-9 shrink-0 rounded-xl bg-warn-dim text-warn inline-flex items-center justify-center">
                  <CloudOff size={18} />
                </span>
                <span className="text-body text-ink-1">
                  Submissions need a connection — a regulator filing is never queued on the device.
                </span>
              </Card>
            )}

            {isOnline && deadlinesQuery.isLoading && <Skeleton variant="row" count={3} />}

            {isOnline && deadlinesQuery.isError && (
              <EmptyState
                tone="error"
                icon={<FileText size={22} />}
                title="Could not load deadlines"
                description="The draft queue could not be fetched. Check your access and try again."
                action={
                  <Chip tone="accent" onClick={() => void deadlinesQuery.refetch()}>
                    Try again
                  </Chip>
                }
              />
            )}

            {isOnline && deadlinesQuery.isSuccess && rows.length === 0 && (
              <EmptyState
                icon={<FileText size={22} />}
                title="No reports due"
                description="Scheduled drafts appear here each period."
                className="py-6"
              />
            )}

            {rows.map((row) => {
              const due = dueLabel(row);
              return (
                <ListRow
                  key={row.id}
                  leading={<FileText size={18} />}
                  tone={due.tone === 'neutral' ? 'neutral' : due.tone}
                  title={REPORT_TYPE_LABELS[row.reportType] ?? row.reportType}
                  subtitle={`${periodLabel(row)} · ${row.status}`}
                  trailing={<span className="font-mono">{due.text}</span>}
                  onClick={() => navigate(`/reports/${row.id}`)}
                />
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}

export default ReportsPage;
