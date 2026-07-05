/**
 * GetBatchTraceabilityQuery — one batch's full lifecycle report (Phase 6).
 *
 * Composes the existing per-domain SSoTs into a single read model:
 *  - residency intervals from `batch_locations` (where the batch lived + how long)
 *  - the operation timeline from the existing GetBatchHistoryQuery (stocking,
 *    transfers, grading, mortality, cull, harvest)
 *  - per-batch feed consumption from `feeding_records` (totals + per residency)
 *  - water temperature during each residency from `water_quality_measurements`
 *
 * @module Batch/Queries
 */
import { IQuery } from '@platform/cqrs';

import { BatchHistoryEntry } from './get-batch-history.query';

export class GetBatchTraceabilityQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
  ) {}
}

export interface BatchFeedTotal {
  feedId: string;
  feedName?: string;
  feedCode?: string;
  totalKg: number;
  totalCost?: number;
}

export interface BatchResidencyWater {
  temperatureMinC?: number;
  temperatureAvgC?: number;
  temperatureMaxC?: number;
  measurementCount: number;
}

export interface BatchResidency {
  tankId: string;
  tankName?: string;
  tankCode?: string;
  movedAt: Date;
  exitedAt?: Date;
  isCurrent: boolean;
  durationDays: number;
  quantityAtEntry: number;
  avgWeightAtEntryG?: number;
  transferReason?: string;
  water: BatchResidencyWater;
  feed: BatchFeedTotal[];
  feedTotalKg: number;
}

export interface BatchTraceabilitySummary {
  batchId: string;
  batchNumber: string;
  status: string;
  speciesName?: string;
  stockedAt: Date;
  harvestedAt?: Date;
  daysInProduction: number;
  initialQuantity: number;
  currentQuantity: number;
  initialAvgWeightG?: number;
  currentAvgWeightG?: number;
  survivalRatePercent?: number;
  protocolId?: string;
  protocolName?: string;
  totalFeedKg: number;
  totalFeedCost?: number;
  fcrActual?: number;
}

export interface BatchTraceabilityResult {
  summary: BatchTraceabilitySummary;
  residencies: BatchResidency[];
  feedTotals: BatchFeedTotal[];
  events: BatchHistoryEntry[];
}
