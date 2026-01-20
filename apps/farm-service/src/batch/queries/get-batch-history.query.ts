/**
 * GetBatchHistoryQuery
 *
 * Batch'in tüm operasyon geçmişini getirir.
 *
 * @module Batch/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export enum BatchHistoryEventType {
  CREATED = 'created',
  STATUS_CHANGED = 'status_changed',
  ALLOCATED = 'allocated',
  TRANSFERRED = 'transferred',
  MORTALITY = 'mortality',
  CULL = 'cull',
  FEEDING = 'feeding',
  GROWTH_SAMPLE = 'growth_sample',
  HARVEST = 'harvest',
  CLOSED = 'closed',
  UPDATED = 'updated',
}

export interface BatchHistoryEntry {
  id: string;
  eventType: BatchHistoryEventType;
  timestamp: Date;
  description: string;
  details: Record<string, unknown>;
  performedBy?: string;
  tankId?: string;
  tankCode?: string;
  quantityChange?: number;
  biomassChangeKg?: number;
}

export class GetBatchHistoryQuery implements ITenantQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly eventTypes?: BatchHistoryEventType[],
    public readonly fromDate?: Date,
    public readonly toDate?: Date,
    public readonly limit: number = 100,
  ) {}
}
