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
import { CloudOff, FileText, TrendingUp } from 'lucide-react';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Card, Chip, EmptyState, ListRow, Skeleton, StatTile } from '@/components/ui';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useReportDeadlines } from '@/hooks/useReportDeadlines';
import { useTanks } from '@/hooks/useTanks';
import { farmSummary, WATCH_AT } from '@/utils/farm-summary';
import { useFeatureAccess } from '@/utils/feature-access';
import { dueLabel, periodLabel, reportTypeLabel } from '@/utils/report-deadline-display';

export function ReportsPage(): JSX.Element {
  const navigate = useNavigate();
  const isOnline = useNetworkStatus();
  const { data: tanks, isLoading: tanksLoading, isError: tanksError } = useTanks();
  // SEC-MEDIUM-050: the regulatory section carries a MODULE_MANAGER floor, the
  // same one the route enforces. Gating the SECTION rather than the screen is
  // what lets a MODULE_USER still read the farm summary above it.
  const { canReach } = useFeatureAccess();
  const canSeeRegulatory = canReach('reports');

  // The query, its tenant key, its three gates and the row order all live in the
  // hook (src/hooks/useReportDeadlines.ts) so the cabin board's Reports view
  // renders the same queue from the same cache entry rather than a second copy.
  const deadlinesQuery = useReportDeadlines();
  const rows = deadlinesQuery.data ?? [];

  /**
   * Farm shape from the inventory snapshot. The arithmetic lives in
   * src/utils/farm-summary.ts because the board's Reports view answers the same
   * four questions — two copies would eventually disagree about one farm.
   */
  const summary = useMemo(() => farmSummary(tanks ?? []), [tanks]);

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
                  label="Units over consent"
                  value={String(summary.atLimit)}
                  state="crit"
                  caption={`Of ${summary.stockedCount} stocked · flagged by the farm service`}
                />
              ) : summary.atWatch > 0 ? (
                <StatTile
                  label="Units past the watch line"
                  value={String(summary.atWatch)}
                  state="warn"
                  caption={`Of ${summary.stockedCount} stocked · advisory ${WATCH_AT}% density`}
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
        {/* `!tanksError` is load-bearing, not belt-and-braces: TanStack keeps the
            LAST GOOD `data` when a refetch fails, so without this a failed
            refresh would draw "Could not load the farm summary" above a list of
            pens presented as today's densest. Half a screen of stale figures
            under an outage notice is the seven-times-found defect wearing a
            disguise (src/utils/loadable.ts). */}
        {!tanksError && summary.densest.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-body font-semibold text-ink-3 px-1">Closest to consent</h2>
            {summary.densest.map((t) => {
              const pct = t.batchMetrics?.capacityUsedPercent ?? 0;
              return (
                <ListRow
                  key={t.id}
                  leading={t.code || t.name}
                  tone={
                    t.batchMetrics?.isOverCapacity === true
                      ? 'crit'
                      : pct >= WATCH_AT
                        ? 'warn'
                        : 'neutral'
                  }
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
                  title={reportTypeLabel(row)}
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
