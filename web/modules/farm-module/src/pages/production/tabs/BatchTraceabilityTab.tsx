/**
 * BatchTraceabilityTab
 *
 * WHY: the full lifecycle story of a batch (which tanks it lived in, what it
 * ate, what happened to it) was only reachable by stitching together the
 * Tanks/Feeding tabs by hand. This tab renders the backend's composed
 * `batchTraceability` report as one auditable page with a print/export path.
 *
 * WHAT: summary header + KPI cards, residency table ("where the fish lived"),
 * whole-batch feed totals, and a reverse-chronological events timeline — all
 * from a single federated query via useBatchTraceability. The "Print report"
 * button hands the same data to the pure HTML builder and a hidden-iframe
 * print (batchTraceabilityReportExport.ts).
 */
import { parseMoney, DataTable, type DataTableColumn, Button } from '@aquaculture/shared-ui';
import React, { useMemo } from 'react';

import type { Batch } from '../../../hooks/useBatches';
import {
  useBatchTraceability,
  type BatchTraceability,
  type BatchTraceabilityEvent,
} from '../../../hooks/useBatchTraceability';
import {
  formatDecimal,
  formatEventTypeLabel,
  formatQuantity,
  formatResidencyPeriod,
  formatSignedNumber,
  formatTraceabilityDate,
  formatTraceabilityDateTime,
  formatWaterTemperature,
  printBatchTraceabilityReport,
} from './batchTraceabilityReportExport';

interface BatchTraceabilityTabProps {
  /**
   * WHY only `id`: the traceability summary is self-describing (it carries
   * batchNumber/status/species/protocol), so the tab needs nothing else from
   * the route batch — narrowing the prop keeps the coupling minimal while the
   * full `Batch` from BatchDetailPage remains assignable.
   */
  batch: Pick<Batch, 'id'>;
}

/** Chip colours per GraphQL enum KEY of BatchHistoryEventType. */
const EVENT_CHIP_COLOURS: Record<string, string> = {
  CREATED: 'bg-blue-100 text-blue-800',
  STATUS_CHANGED: 'bg-indigo-100 text-indigo-800',
  ALLOCATED: 'bg-cyan-100 text-cyan-800',
  TRANSFERRED: 'bg-purple-100 text-purple-800',
  MORTALITY: 'bg-red-100 text-red-800',
  CULL: 'bg-orange-100 text-orange-800',
  FEEDING: 'bg-amber-100 text-amber-800',
  GROWTH_SAMPLE: 'bg-teal-100 text-teal-800',
  HARVEST: 'bg-green-100 text-green-800',
  CLOSED: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  UPDATED: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300',
};

const BatchTraceabilityTab: React.FC<BatchTraceabilityTabProps> = ({ batch }) => {
  const { traceability, isLoading, error } = useBatchTraceability(batch.id);

  // Reverse-chron timeline regardless of backend ordering — newest event on top.
  const sortedEvents = useMemo<BatchTraceabilityEvent[]>(
    () =>
      [...(traceability?.events ?? [])].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      ),
    [traceability],
  );

  if (isLoading) {
    return (
      <div className="animate-pulse text-gray-500 dark:text-gray-400">Loading traceability report…</div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <h2 className="text-lg font-semibold text-red-800">
          Traceability report could not be loaded
        </h2>
        <p className="mt-1 text-sm text-red-700">{error.message}</p>
      </div>
    );
  }

  if (!traceability) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No traceability data is available for this batch.
        </p>
      </div>
    );
  }

  const { summary, residencies, feedTotals } = traceability;

  type FeedRow = (typeof feedTotals)[number];
  const feedRowColumns: DataTableColumn<FeedRow>[] = [
    {
      key: 'feed',
      header: 'Feed',
      render: (_value, feed) => feed.feedName ?? '—',
    },
    {
      key: 'code',
      header: 'Code',
      render: (_value, feed) => feed.feedCode ?? '—',
    },
    {
      key: 'totalKg',
      header: 'Total (kg)',
      render: (_value, feed) => formatDecimal(feed.totalKg),
    },
    {
      key: 'totalCost',
      header: 'Total Cost',
      render: (_value, feed) => formatDecimal(feed.totalCostDecimal != null ? parseMoney(feed.totalCostDecimal) : null, 2),
    }
  ];

  type ResidencyRow = (typeof residencies)[number];
  const residencyRowColumns: DataTableColumn<ResidencyRow>[] = [
    {
      key: 'tank',
      header: 'Tank',
      render: (_value, residency) => (
        <>
          <div className="font-medium text-gray-900 dark:text-gray-100">
            {residency.tankName ?? '—'}
            {residency.isCurrent && (
              <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                current
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{residency.tankCode ?? '—'}</div>
        </>
      ),
    },
    {
      key: 'period',
      header: 'Period',
      render: (_value, residency) => formatResidencyPeriod(residency),
    },
    {
      key: 'days',
      header: 'Days',
      render: (_value, residency) => formatDecimal(residency.durationDays, 0),
    },
    {
      key: 'qtyAtEntry',
      header: 'Qty at Entry',
      render: (_value, residency) => formatQuantity(residency.quantityAtEntry),
    },
    {
      key: 'avgWeightAtEntryG',
      header: 'Avg Weight at Entry (g)',
      render: (_value, residency) => formatDecimal(residency.avgWeightAtEntryG),
    },
    {
      key: 'waterTempCMinAvgMax',
      header: 'Water Temp °C (min / avg / max)',
      render: (_value, residency) => formatWaterTemperature(residency.water),
    },
    {
      key: 'feedKg',
      header: 'Feed (kg)',
      render: (_value, residency) => formatDecimal(residency.feedTotalKg),
    }
  ];

  return (
    <div className="space-y-6">
      <SummaryHeader traceability={traceability} />

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard label="Days in Production" value={String(summary.daysInProduction)} />
        <KpiCard
          label="Survival Rate"
          value={
            summary.survivalRatePercent !== null
              ? `${summary.survivalRatePercent.toFixed(1)} %`
              : '—'
          }
        />
        <KpiCard
          label="Current Count / Avg Weight"
          value={`${formatQuantity(summary.currentQuantity)} / ${
            summary.currentAvgWeightG !== null
              ? `${summary.currentAvgWeightG.toFixed(1)} g`
              : '—'
          }`}
        />
        <KpiCard label="Total Feed" value={`${summary.totalFeedKg.toFixed(1)} kg`} />
        <KpiCard
          label="Total Feed Cost"
          value={summary.totalFeedCostDecimal !== null ? parseMoney(summary.totalFeedCostDecimal).toFixed(2) : '—'}
        />
        <KpiCard
          label="FCR (actual)"
          value={summary.fcrActual !== null ? summary.fcrActual.toFixed(2) : '—'}
        />
      </div>

      {/* Residency table — where the fish lived */}
      <section>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Where the fish lived</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Every tank this batch stayed in, with water temperature and feed
          consumption aggregated per stay.
        </p>
        <DataTable<ResidencyRow>
          data={residencies}
          columns={residencyRowColumns}
          keyExtractor={(residency) => `${residency.tankId}-${residency.movedAt}`}
          emptyMessage="No tank residencies recorded."
          searchable={false}
          sortable={false}
          stickyHeader={false}
          compact
        />
      </section>

      {/* Feed totals */}
      <section>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Feed totals</h3>
        <DataTable<FeedRow>
          data={feedTotals}
          columns={feedRowColumns}
          keyExtractor={(feed) => feed.feedId}
          emptyMessage="No feed consumption recorded."
          searchable={false}
          sortable={false}
          stickyHeader={false}
          compact
        />
      </section>

      {/* Events timeline */}
      <section>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Events timeline</h3>
        {sortedEvents.length === 0 ? (
          <div className="mt-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">No events recorded for this batch.</p>
          </div>
        ) : (
          <ol className="mt-3 space-y-2">
            {sortedEvents.map((event) => (
              <li
                key={event.id}
                className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-2 py-0.5 text-xs font-semibold rounded-full capitalize ${
                      EVENT_CHIP_COLOURS[event.eventType] ?? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {formatEventTypeLabel(event.eventType)}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatTraceabilityDateTime(event.timestamp)}
                  </span>
                  {event.tankCode && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">· {event.tankCode}</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{event.description}</p>
                <div className="mt-1 flex flex-wrap gap-4 text-xs text-gray-500 dark:text-gray-400">
                  {event.quantityChange !== null && (
                    <span>Qty change: {formatSignedNumber(event.quantityChange)}</span>
                  )}
                  {event.biomassChangeKg !== null && (
                    <span>Biomass change: {formatSignedNumber(event.biomassChangeKg, 1)} kg</span>
                  )}
                  {event.performedBy && <span>By: {event.performedBy}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
};

/** Summary header — batch identity + protocol + the print/export action. */
const SummaryHeader: React.FC<{ traceability: BatchTraceability }> = ({ traceability }) => {
  const { summary } = traceability;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Traceability — {summary.batchNumber}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Status: <span className="font-medium text-gray-700 dark:text-gray-300">{summary.status}</span>
          {' · '}Species:{' '}
          <span className="font-medium text-gray-700 dark:text-gray-300">{summary.speciesName ?? '—'}</span>
          {' · '}Protocol:{' '}
          <span className="font-medium text-gray-700 dark:text-gray-300">{summary.protocolName ?? '—'}</span>
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Stocked {formatTraceabilityDate(summary.stockedAt)}
          {summary.harvestedAt && ` · Harvested ${formatTraceabilityDate(summary.harvestedAt)}`}
        </p>
      </div>
      <Button variant="primary" size="sm" type="button" onClick={() => printBatchTraceabilityReport(traceability)}>Print report</Button>
    </div>
  );
};

const KpiCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">{label}</div>
    <div className="mt-1 text-base font-medium text-gray-900 dark:text-gray-100">{value}</div>
  </div>
);


export default BatchTraceabilityTab;
