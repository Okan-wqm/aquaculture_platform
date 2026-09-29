/**
 * Reply guards for the pre-FARM-MEDIUM-328 overview subjects
 * (request.farm.getTankRegistry / getBatchOverview / getWaterQualityOverview /
 * getHarvestOverview / getFeedingOverview). They ride the tenant-bound
 * envelope (K10); these guards check the `data` rows the tools hand to the
 * model, so a malformed reply becomes a tool error instead of model context.
 */
type FieldKind = 'string' | 'string|null' | 'number' | 'number|null';

function hasFields(row: unknown, fields: Readonly<Record<string, FieldKind>>): boolean {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false;
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(row));
  return Object.entries(fields).every(([key, kind]) => {
    const value = record[key];
    switch (kind) {
      case 'string':
        return typeof value === 'string';
      case 'string|null':
        return value === null || typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'number|null':
        return value === null || (typeof value === 'number' && Number.isFinite(value));
    }
  });
}

function isListOf<T>(value: unknown, fields: Readonly<Record<string, FieldKind>>): value is T[] {
  return Array.isArray(value) && value.every((row) => hasFields(row, fields));
}

export interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
  status: string;
}

export function isTankRegistry(value: unknown): value is TankRegistryEntry[] {
  return isListOf<TankRegistryEntry>(value, {
    id: 'string',
    code: 'string',
    name: 'string',
    status: 'string',
  });
}

export interface BatchOverviewEntry {
  id: string;
  batchNumber: string;
  name: string | null;
  status: string;
  statusChangedAt: string | null;
}

export function isBatchOverview(value: unknown): value is BatchOverviewEntry[] {
  return isListOf<BatchOverviewEntry>(value, {
    id: 'string',
    batchNumber: 'string',
    name: 'string|null',
    status: 'string',
    statusChangedAt: 'string|null',
  });
}

export interface WaterQualityReading {
  id: string;
  tankId: string | null;
  pondId: string | null;
  measuredAt: string;
  temperature: number | null;
  dissolvedOxygen: number | null;
  pH: number | null;
  ammonia: number | null;
  nitrite: number | null;
}

export function isWaterQualityOverview(value: unknown): value is WaterQualityReading[] {
  return isListOf<WaterQualityReading>(value, {
    id: 'string',
    tankId: 'string|null',
    pondId: 'string|null',
    measuredAt: 'string',
    temperature: 'number|null',
    dissolvedOxygen: 'number|null',
    pH: 'number|null',
    ammonia: 'number|null',
    nitrite: 'number|null',
  });
}

export interface HarvestPlanEntry {
  id: string;
  planCode: string;
  name: string;
  batchId: string;
  status: string;
  plannedDate: string;
}

export function isHarvestOverview(value: unknown): value is HarvestPlanEntry[] {
  return isListOf<HarvestPlanEntry>(value, {
    id: 'string',
    planCode: 'string',
    name: 'string',
    batchId: 'string',
    status: 'string',
    plannedDate: 'string',
  });
}

export interface FeedingRecordEntry {
  id: string;
  batchId: string;
  tankId: string | null;
  feedingDate: string;
  feedingTime: string;
  plannedAmountKg: number;
  actualAmountKg: number;
}

export function isFeedingOverview(value: unknown): value is FeedingRecordEntry[] {
  return isListOf<FeedingRecordEntry>(value, {
    id: 'string',
    batchId: 'string',
    tankId: 'string|null',
    feedingDate: 'string',
    feedingTime: 'string',
    plannedAmountKg: 'number',
    actualAmountKg: 'number',
  });
}
