/**
 * FeedingProtocolV2 hooks (feeding-protocol SSoT — Faz 3)
 *
 * Birleşik protokol (v2) CRUD, ünite atamaları ve etkin sıcaklık rozetleri.
 * Tipler backend jsonb value-object'lerinin birebir aynasıdır
 * (`apps/farm-service/src/feeding-protocol/entities/`). v1 hook'ları
 * (`useFeedingProtocols.ts`) cutover'a kadar v1 sekmesine hizmet eder.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  useTenantQuery,
  graphqlClient,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import {
  FEEDING_PROTOCOLS_V2_QUERY,
  FEEDING_PROTOCOL_V2_QUERY,
  PROTOCOL_ASSIGNMENTS_QUERY,
  CREATE_FEEDING_PROTOCOL_V2_MUTATION,
  UPDATE_FEEDING_PROTOCOL_V2_MUTATION,
  ARCHIVE_FEEDING_PROTOCOL_V2_MUTATION,
  ASSIGN_PROTOCOL_TO_UNIT_MUTATION,
  UPDATE_PROTOCOL_ASSIGNMENT_MUTATION,
  UNASSIGN_PROTOCOL_FROM_UNIT_MUTATION,
  EFFECTIVE_UNIT_TEMPERATURES_QUERY,
} from '../graphql/feedingProtocolV2.operations';

// ============================================================================
// TYPES — backend entity jsonb aynaları
// ============================================================================

export type FeedingProtocolV2Status = 'draft' | 'active' | 'archived';
export type ProtocolAssignmentStatus = 'active' | 'paused' | 'ended';
export type FeedingUnitType = 'tank' | 'pond' | 'cage';
export type ProtocolFcrSource = 'band' | 'matrix' | 'feed';
export type EffectiveTemperatureSource = 'sensor' | 'manual' | 'none';

export interface MealScheduleEntry {
  time: string; // HH:mm
  percentOfDaily: number;
}

export interface MealSchedule {
  mealsPerDay: number;
  entries: MealScheduleEntry[];
}

export interface ProtocolBand {
  minWeightG: number;
  maxWeightG: number;
  feedId: string;
  feedCode: string;
  feedName: string;
  feedingRatePercent: number;
  expectedFcr: number;
  mealSchedule?: MealSchedule;
  notes?: string;
}

export interface TemperatureAdjustment {
  minC: number;
  maxC: number;
  rateMultiplier: number;
}

export interface FcrMatrix {
  temperatures: number[];
  weights: number[];
  fcrValues: number[][];
}

export interface ProtocolSettings {
  autoTransition: boolean;
  transitionBufferG: number;
  growthApplicationMode: 'per_meal' | 'daily';
  underfeedAlertThresholdPercent: number;
  fcrSource: ProtocolFcrSource;
  minDissolvedOxygen?: number;
  minFeedingRatePercent?: number;
  maxFeedingRatePercent?: number;
}

export interface FeedingProtocolV2 {
  id: string;
  name: string;
  description?: string;
  speciesId?: string;
  speciesName?: string;
  status: FeedingProtocolV2Status;
  bands: ProtocolBand[];
  temperatureAdjustments?: TemperatureAdjustment[];
  defaultMealSchedule: MealSchedule;
  fcrMatrix?: FcrMatrix;
  settings: ProtocolSettings;
  isDefault: boolean;
  migrationNote?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface FcrOverride {
  feedId: string;
  expectedFcr: number;
}

export interface AssignmentOverrides {
  mealTimeOffsetMinutes?: number;
  mealsPerDayOverride?: number;
  rateAdjustmentPercent?: number;
  fcrOverrides?: FcrOverride[];
}

export interface AssignmentSuspension {
  from: string;
  to: string;
  type: 'fasting' | 'medication';
  reason: string;
  medicatedFeedId?: string;
}

export interface ProtocolAssignment {
  id: string;
  unitId: string;
  unitType: FeedingUnitType;
  unitName: string;
  unitCode: string;
  siteId: string;
  protocolId: string;
  status: ProtocolAssignmentStatus;
  effectiveFrom: string;
  endedAt?: string;
  overrides: AssignmentOverrides;
  suspensions: AssignmentSuspension[];
  currentFeedId?: string;
  currentBandIndex?: number;
  lastTransitionAt?: string;
  totalTransitions: number;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveUnitTemperature {
  unitId: string;
  celsius: number | null;
  source: EffectiveTemperatureSource;
  measuredAt?: string;
  sensorId?: string;
}

// ── Input aynaları (backend class-validator sınırları BE'de koşar) ──

export interface ProtocolBandInput {
  minWeightG: number;
  maxWeightG: number;
  feedId: string;
  feedingRatePercent: number;
  expectedFcr: number;
  mealSchedule?: MealSchedule;
  notes?: string;
}

export interface CreateFeedingProtocolV2Input {
  name: string;
  description?: string;
  speciesId?: string;
  bands: ProtocolBandInput[];
  temperatureAdjustments?: TemperatureAdjustment[];
  defaultMealSchedule: MealSchedule;
  fcrMatrix?: FcrMatrix;
  settings: ProtocolSettings;
  isDefault?: boolean;
  status?: FeedingProtocolV2Status;
}

export interface UpdateFeedingProtocolV2Input extends CreateFeedingProtocolV2Input {
  id: string;
}

export interface AssignProtocolToUnitInput {
  unitId: string;
  unitType: FeedingUnitType;
  protocolId: string;
  effectiveFrom?: string;
  overrides?: AssignmentOverrides;
  speciesMismatchReason?: string;
}

export interface UpdateProtocolAssignmentInput {
  assignmentId: string;
  overrides?: AssignmentOverrides;
  suspensions?: AssignmentSuspension[];
  status?: 'active' | 'paused';
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface FeedingProtocolsV2Filter {
  status?: FeedingProtocolV2Status;
  speciesId?: string;
}

export interface ProtocolAssignmentsFilter {
  siteId?: string;
  unitId?: string;
  protocolId?: string;
  status?: ProtocolAssignmentStatus;
}

// ============================================================================
// QUERY HOOKS
// ============================================================================

export function useFeedingProtocolsV2(filter?: FeedingProtocolsV2Filter) {
  return useTenantQuery(
    ['feeding-protocols-v2', 'list', filter],
    async () => {
      const data = await graphqlClient.request<{
        feedingProtocolsV2: PaginatedResult<FeedingProtocolV2>;
      }>(FEEDING_PROTOCOLS_V2_QUERY, {
        status: filter?.status,
        speciesId: filter?.speciesId,
        pagination: { page: 1, limit: 100 },
      });
      return data.feedingProtocolsV2;
    },
    { staleTime: 30000 },
  );
}

export function useFeedingProtocolV2(id: string | null) {
  return useTenantQuery(
    ['feeding-protocols-v2', 'detail', id],
    async () => {
      const data = await graphqlClient.request<{ feedingProtocolV2: FeedingProtocolV2 }>(
        FEEDING_PROTOCOL_V2_QUERY,
        { id },
      );
      return data.feedingProtocolV2;
    },
    { staleTime: 30000, enabled: !!id },
  );
}

export function useProtocolAssignments(filter?: ProtocolAssignmentsFilter) {
  return useTenantQuery(
    ['protocol-assignments', 'list', filter],
    async () => {
      const data = await graphqlClient.request<{
        protocolAssignments: PaginatedResult<ProtocolAssignment>;
      }>(PROTOCOL_ASSIGNMENTS_QUERY, {
        siteId: filter?.siteId,
        unitId: filter?.unitId,
        protocolId: filter?.protocolId,
        status: filter?.status,
        pagination: { page: 1, limit: 100 },
      });
      return data.protocolAssignments;
    },
    { staleTime: 30000 },
  );
}

/**
 * Etkin sıcaklık rozetleri — TEK toplu sorgu (ünite başına istek yok, K-11).
 * Sıralı-stabil anahtar: aynı ünite kümesi = aynı cache girdisi.
 */
export function useEffectiveUnitTemperatures(unitIds: string[]) {
  const sortedIds = [...unitIds].sort();
  return useTenantQuery(
    ['unit-effective-temperatures', sortedIds],
    async () => {
      const data = await graphqlClient.request<{
        effectiveUnitTemperatures: EffectiveUnitTemperature[];
      }>(EFFECTIVE_UNIT_TEMPERATURES_QUERY, { unitIds: sortedIds });
      const map = new Map<string, EffectiveUnitTemperature>();
      for (const entry of data.effectiveUnitTemperatures) map.set(entry.unitId, entry);
      return map;
    },
    { staleTime: 60000, enabled: sortedIds.length > 0 },
  );
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

function useProtocolInvalidation() {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols-v2'),
    });
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'protocol-assignments'),
    });
  };
}

export function useCreateFeedingProtocolV2() {
  const invalidate = useProtocolInvalidation();
  return useMutation({
    mutationFn: async (input: CreateFeedingProtocolV2Input) => {
      const data = await graphqlClient.request<{ createFeedingProtocolV2: FeedingProtocolV2 }>(
        CREATE_FEEDING_PROTOCOL_V2_MUTATION,
        { input },
      );
      return data.createFeedingProtocolV2;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateFeedingProtocolV2() {
  const invalidate = useProtocolInvalidation();
  return useMutation({
    mutationFn: async (input: UpdateFeedingProtocolV2Input) => {
      const data = await graphqlClient.request<{ updateFeedingProtocolV2: FeedingProtocolV2 }>(
        UPDATE_FEEDING_PROTOCOL_V2_MUTATION,
        { input },
      );
      return data.updateFeedingProtocolV2;
    },
    onSuccess: () => invalidate(),
  });
}

export function useArchiveFeedingProtocolV2() {
  const invalidate = useProtocolInvalidation();
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlClient.request<{
        archiveFeedingProtocolV2: Pick<FeedingProtocolV2, 'id' | 'status'>;
      }>(ARCHIVE_FEEDING_PROTOCOL_V2_MUTATION, { id });
      return data.archiveFeedingProtocolV2;
    },
    onSuccess: () => invalidate(),
  });
}

export function useAssignProtocolToUnit() {
  const invalidate = useProtocolInvalidation();
  return useMutation({
    mutationFn: async (input: AssignProtocolToUnitInput) => {
      const data = await graphqlClient.request<{ assignProtocolToUnit: ProtocolAssignment }>(
        ASSIGN_PROTOCOL_TO_UNIT_MUTATION,
        { input },
      );
      return data.assignProtocolToUnit;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateProtocolAssignment() {
  const invalidate = useProtocolInvalidation();
  return useMutation({
    mutationFn: async (input: UpdateProtocolAssignmentInput) => {
      const data = await graphqlClient.request<{ updateProtocolAssignment: ProtocolAssignment }>(
        UPDATE_PROTOCOL_ASSIGNMENT_MUTATION,
        { input },
      );
      return data.updateProtocolAssignment;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUnassignProtocolFromUnit() {
  const invalidate = useProtocolInvalidation();
  return useMutation({
    mutationFn: async (assignmentId: string) => {
      const data = await graphqlClient.request<{
        unassignProtocolFromUnit: Pick<ProtocolAssignment, 'id' | 'status' | 'endedAt'>;
      }>(UNASSIGN_PROTOCOL_FROM_UNIT_MUTATION, { assignmentId });
      return data.unassignProtocolFromUnit;
    },
    onSuccess: () => invalidate(),
  });
}
