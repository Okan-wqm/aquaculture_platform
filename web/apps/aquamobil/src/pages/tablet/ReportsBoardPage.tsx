/**
 * ReportsBoardPage — the cabin board's Reports view.
 *
 * SAME TWO SECTIONS AS THE PHONE, SIDE BY SIDE. The handheld stacks the farm
 * summary above the regulatory queue and a manager scrolls between them. A board
 * has the width to show both at once, which is the entire reason this view
 * exists: the person planning the week wants the farm's shape and the regulator's
 * deadlines in one glance, not in two scroll positions.
 *
 * NOTHING IS RECOMPUTED HERE. The figures come from farmSummary()
 * (src/utils/farm-summary.ts) and the queue from useReportDeadlines()
 * (src/hooks/useReportDeadlines.ts) — the same function and the same query the
 * phone's ReportsPage uses, sharing one React Query cache entry. A manager who
 * walks in from the pens and looks up at the wall must not be shown a different
 * average weight than the phone in their hand showed thirty seconds ago.
 *
 * WHAT IS DELIBERATELY ABSENT — the design's two trend charts (average weight
 * over 7/30/90 days, mortality per bucket) and the period selector above them.
 * This client has NO time-series query: `farmStockInventory` is a snapshot,
 * `stockEventsSummary` is a this-week count plus a recent-event list, and
 * `batchGrowthPrediction` is one forward estimate. A trend drawn from any of
 * those would be an invented history rendered in the farm's own voice, which is
 * the worst thing this app can do. The screen says so in one line, exactly as
 * the phone does. The gap is ORPHAN-MEDIUM-580, not an oversight.
 *
 * PERMISSIONS are the phone's, unchanged: the regulatory column self-gates on
 * canReach('reports') — the entitlement AND the MODULE_MANAGER floor mirroring
 * @Roles(TENANT_ADMIN, MODULE_MANAGER) on RegulatoryReportDraftResolver
 * (SEC-MEDIUM-050 / FARM-HIGH-214). A MODULE_USER gets the farm summary at full
 * width and no submissions column at all — the same thing they get on the
 * handheld, laid out for the wider surface rather than gated differently.
 */
import { useI18n } from '@aquaculture/shared-ui/i18n';
import { clsx } from 'clsx';
import { CloudOff, FileText, TrendingUp } from 'lucide-react';
import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card, DataState, EmptyState, ListRow, StatTile } from '@/components/ui';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useReportDeadlines, type ReportDeadline } from '@/hooks/useReportDeadlines';
import { useTanks } from '@/hooks/useTanks';
import { BoardRegion } from '@/pages/tablet/BoardRegion';
import { farmSummary, WATCH_AT, type FarmSummary } from '@/utils/farm-summary';
import { useFeatureAccess } from '@/utils/feature-access';
import { toLoadable } from '@/utils/loadable';
import { dueLabel, periodLabel, reportTypeLabel } from '@/utils/report-deadline-display';
import { fixedOrNone } from '@/utils/unit-display';

export function ReportsBoardPage(): ReactElement {
  const { t } = useI18n();
  const { canReach } = useFeatureAccess();
  const canSeeRegulatory = canReach('reports');

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div
        className={clsx(
          'flex-1 min-h-0 grid gap-3 p-3',
          // ONE COLUMN WHEN THE SUBMISSIONS COLUMN IS NOT THIS ROLE'S TO SEE.
          // A field worker gets the farm summary across the whole board rather
          // than a permanent empty half explaining what they may not read —
          // which is the same thing the phone does by simply not rendering the
          // section, expressed in the grid instead of in a gap.
          canSeeRegulatory
            ? 'grid-cols-[minmax(0,1fr)_360px] board-wide:grid-cols-[minmax(0,1fr)_420px]'
            : 'grid-cols-1',
        )}
      >
        <BoardRegion label={t('m.reports.farmSummary')} icon={TrendingUp}>
          <FarmSummarySection />
        </BoardRegion>

        {canSeeRegulatory && (
          <BoardRegion label={t('m.reports.regulatory')} icon={FileText}>
            <RegulatorySection />
          </BoardRegion>
        )}
      </div>

      <p className="shrink-0 px-4 pb-3 text-meta text-ink-3">{t('m.reports.boardNoHistory')}</p>
    </div>
  );
}

/**
 * The farm's shape: the hero figures, then the pens closest to consent.
 *
 * Every number below is reachable ONLY through <DataState/>'s ready arm. That is
 * the whole point: `useTanks` hands back the last good `data` when a refetch
 * fails, so reading it directly would let a failed refresh draw "0 units past the
 * watch line" — an all-clear about stocking density that nobody checked. This
 * exact substitution has been found seven times in this app; src/utils/loadable.ts
 * exists to make it a compile-time impossibility rather than a review item.
 */
function FarmSummarySection(): ReactElement {
  const { t } = useI18n();
  // The phone's query, shared: React Query dedupes it with the board's top bar
  // and the unit grid, so every reader on this device costs one fetch.
  const units = toLoadable(useTanks());

  return (
    <DataState
      value={units}
      label={t('m.reports.farmSummaryThing')}
      skeleton="tile"
      skeletonCount={3}
      // Reached only when the fetch SUCCEEDED and the tenant holds no units.
      // Deliberately worded as a fact about the farm, because that is what it is.
      empty={
        <EmptyState
          icon={<TrendingUp size={22} />}
          title={t('m.reports.noUnits')}
          description={t('m.reports.noUnitsHint')}
        />
      }
    >
      {(tanks) => {
        const summary = farmSummary(tanks);

        if (summary.stockedCount === 0) {
          return (
            <EmptyState
              icon={<TrendingUp size={22} />}
              title={t('m.reports.nothingStocked')}
              description={
                summary.totalCount === 1
                  ? t('m.reports.unitsNoneStocked.one')
                  : t('m.reports.unitsNoneStocked.other', { count: summary.totalCount })
              }
            />
          );
        }

        return (
          <>
            {/* auto-fill rather than a column count: this region is the elastic
                track and runs from ~500px to ~900px wide across board sizes.
                One minmax covers that range without inventing a third
                breakpoint for the shell to keep in step with. */}
            <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              <StatTile
                label={t('m.reports.avgWeight')}
                value={summary.avgWeightG.toFixed(0)}
                unit="g"
                caption={t('m.reports.avgWeightCaption')}
              />
              <StatTile
                label={t('m.reports.biomass')}
                value={(summary.biomassKg / 1000).toFixed(1)}
                unit="t"
                caption={t('m.reports.fishCount', { count: summary.fish.toLocaleString() })}
              />
              <ConsentTile summary={summary} />
            </div>

            <DensestSection summary={summary} />
          </>
        );
      }}
    </DataState>
  );
}

/**
 * The one tile that changes its claim: over consent, past the watch line, or
 * clear.
 *
 * `atLimit` comes from the FARM SERVICE's own `isOverCapacity`, which fires on
 * density, status and biomass axes — not from a local percentage. A hardcoded
 * threshold here once made this screen and Today disagree about the same pen.
 * WATCH_AT only ever labels the advisory band.
 *
 * Every non-neutral state carries a caption naming the threshold, because
 * StatTile's own type refuses colour without an explanation — a tile that turns
 * coral with nothing to read is colour-alone, and a colourblind worker at three
 * metres reads the words.
 */
function ConsentTile({ summary }: { summary: FarmSummary }): ReactElement {
  const { t } = useI18n();
  if (summary.atLimit > 0) {
    return (
      <StatTile
        label={t('m.reports.overConsent')}
        value={String(summary.atLimit)}
        state="crit"
        caption={t('m.reports.overConsentCaption', { stocked: summary.stockedCount })}
      />
    );
  }
  if (summary.atWatch > 0) {
    return (
      <StatTile
        label={t('m.reports.pastWatch')}
        value={String(summary.atWatch)}
        state="warn"
        caption={t('m.reports.pastWatchCaption', {
          stocked: summary.stockedCount,
          watch: WATCH_AT,
        })}
      />
    );
  }
  return (
    <StatTile
      label={t('m.reports.pastWatch')}
      value="0"
      caption={t('m.reports.allBelowWatch', { stocked: summary.stockedCount, watch: WATCH_AT })}
    />
  );
}

/**
 * The five pens closest to their consent limit.
 *
 * Tapping one goes to the unit's own detail — the SAME destination and the same
 * ungated route the phone's Reports uses. The board's own unit inspector lives
 * on the Board view and reads a different URL parameter, so sending a manager
 * there from here would be a cross-view jump that loses this screen; the unit
 * detail is one back-tap from anywhere.
 */
function DensestSection({ summary }: { summary: FarmSummary }): ReactElement | null {
  const { t } = useI18n();
  const navigate = useNavigate();

  if (summary.densest.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-body font-semibold text-ink-3">{t('m.reports.closestToConsent')}</h3>
      {summary.densest.map((tank) => {
        const metrics = tank.batchMetrics;
        const percent = metrics?.capacityUsedPercent;
        return (
          <ListRow
            key={tank.id}
            leading={tank.code || tank.name}
            tone={
              metrics?.isOverCapacity === true
                ? 'crit'
                : percent != null && percent >= WATCH_AT
                  ? 'warn'
                  : 'neutral'
            }
            title={tank.name}
            // fixedOrNone, not `?? 0`: both figures are nullable on the wire and
            // null means "no configured consent capacity", which is a different
            // fact from "at 0.0 kg/m³". A fabricated zero in the farm's voice is
            // the same defect class as an all-clear from a failed fetch.
            subtitle={`${fixedOrNone(metrics?.density, 1)} kg/m³`}
            trailing={<span className="font-mono">{fixedOrNone(percent, 0)}%</span>}
            onClick={() => navigate(`/tank/${tank.id}`)}
          />
        );
      })}
    </section>
  );
}

/**
 * The Mattilsynet draft queue.
 *
 * ONLINE-ONLY BY DESIGN, and the offline case is checked before anything else: a
 * regulator filing is never queued on a device, so `useReportDeadlines` does not
 * even enable its query offline. Without this branch a disabled query would sit
 * at `loading` forever and the column would show a skeleton that never resolves —
 * a spinner is not an explanation.
 */
function RegulatorySection(): ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const isOnline = useNetworkStatus();
  const deadlines = toLoadable(useReportDeadlines());

  if (!isOnline) {
    return (
      <Card className="p-3.5 flex items-start gap-3 border-warn">
        <span className="w-9 h-9 shrink-0 rounded-xl bg-warn-dim text-warn inline-flex items-center justify-center">
          <CloudOff size={18} aria-hidden />
        </span>
        <span className="text-body text-ink-1">{t('m.reports.needsConnection')}</span>
      </Card>
    );
  }

  return (
    <DataState
      value={deadlines}
      label={t('m.reports.deadlinesThing')}
      skeleton="row"
      skeletonCount={4}
      empty={
        <EmptyState
          icon={<FileText size={22} />}
          title={t('m.reports.noneDue')}
          description={t('m.reports.noneDueHint')}
        />
      }
    >
      {(rows) => (
        <>
          {rows.map((row) => (
            <DeadlineRow key={row.id} row={row} onOpen={() => navigate(`/reports/${row.id}`)} />
          ))}
        </>
      )}
    </DataState>
  );
}

/** One scheduled filing: what it is, which period it covers, how urgent it is. */
function DeadlineRow({ row, onOpen }: { row: ReportDeadline; onOpen: () => void }): ReactElement {
  const due = dueLabel(row);
  return (
    <ListRow
      leading={<FileText size={18} />}
      tone={due.tone}
      title={reportTypeLabel(row)}
      subtitle={`${periodLabel(row)} · ${row.status}`}
      trailing={<span className="font-mono">{due.text}</span>}
      // The review screen is FeatureRoute-guarded on the same `reports` feature
      // that gated this whole column, so the board opens nothing the handheld
      // would refuse.
      onClick={onOpen}
    />
  );
}

export default ReportsBoardPage;
