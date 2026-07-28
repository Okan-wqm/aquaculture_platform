/**
 * FeedingProtocolV2 hooks (feeding-protocol SSoT — Faz 3)
 *
 * Birleşik protokol (v2) CRUD, ünite atamaları ve etkin sıcaklık rozetleri.
 * Tipler backend jsonb value-object'lerinin birebir aynasıdır
 * (`apps/farm-service/src/feeding-protocol/entities/`). v1 protokol
 * hook'ları Faz 8'de silindi — v2 tek kontrattır.
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
  FEEDING_DAY_PLANS_QUERY,
  RECORD_MEAL_FEEDING_MUTATION,
  FINALIZE_MEAL_MUTATION,
  SKIP_MEAL_MUTATION,
  CORRECT_MEAL_POUR_MUTATION,
  PROTOCOL_FEED_FORECAST_QUERY,
  REGENERATE_DAY_PLAN_MUTATION,
  TRANSITION_UNIT_FEED_MUTATION,
} from '../graphql/feedingProtocolV2.operations';
import { buildCommandEnvelope } from '../utils/command-envelope';

// ============================================================================
// TYPES — backend entity jsonb aynaları
// ============================================================================
// Tel sözleşmesi (kasa kuralı): GraphQL ENUM alanları tel üzerinde AD taşır —
// registerEnumType adları TS enum ANAHTARLARIDIR ('ACTIVE', 'PARTIALLY_FED').
// jsonb yükleri (snapshot, settings, overrides) ve düz String alanları
// (UpdateProtocolAssignmentInput.status, suspension.type, temperature source)
// ise TS enum DEĞERLERİNİ (lowercase) taşır. Union'lar bu ayrımı birebir
// yazar; karıştırmak MealBoard'daki tüm öğünleri "kapalı" göstermişti.

export type FeedingProtocolV2Status = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ProtocolAssignmentStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';
export type FeedingUnitType = 'TANK' | 'POND' | 'CAGE';
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
  /** Düz String input (@IsIn backend'de) — enum DEĞİL, lowercase DEĞER gönderilir. */
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

// ============================================================================
// ÖĞÜN MOTORU v2 (Faz 6 — MealBoard)
// ============================================================================

// GraphQL enum alanları — tel üzerinde AD (bkz. dosya başındaki kasa kuralı).
export type FeedingDayPlanStatus =
  | 'PLANNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'CANCELLED';
export type FeedingMealStatus =
  | 'SCHEDULED'
  | 'FED'
  | 'PARTIALLY_FED'
  | 'SKIPPED'
  | 'MISSED'
  | 'CANCELLED';
/** snapshot jsonb içinden okunur → TS enum DEĞERİ (lowercase). */
export type FcrResolvedSource = 'override' | 'band' | 'matrix' | 'feed';

/** Backend `DayPlanSnapshot` jsonb aynası — üretim anındaki hesap provenansı. */
export interface DayPlanSnapshot {
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  waterTempC: number | null;
  temperatureSource: EffectiveTemperatureSource;
  usingDefaultTemperature: boolean;
  bandIndex: number;
  feed: { id: string; code: string; name: string };
  baseRatePercent: number;
  tempMultiplier: number;
  effectiveRatePercent: number;
  expectedFcr: number;
  fcrResolvedSource: FcrResolvedSource;
  /** D-2 karışık-tank rozeti — B3 öncesi üretilmiş snapshot'larda alanlar yok. */
  mixedBatch?: boolean;
  weightCvPercent?: number | null;
}

export interface RecalcLogEntry {
  at: string;
  reason: string;
  plannedTotalKg?: number;
  biomassKg?: number;
  note?: string;
}

export interface MealPour {
  pourIndex: number;
  kg: number;
  at: string;
  by: string;
  feedingMethod?: string;
  originalKg?: number;
  correctedAt?: string;
  correctedBy?: string;
  corrections?: number;
}

/**
 * Öğün öncesi oksijen verdikti (W7 — FARM-MEDIUM-271).
 *
 * sensor-service YALNIZ olumsuz verdikt yayar, bu yüzden alanın YOKLUĞU
 * "oksijen yeterli" DEĞİL, "olumsuz sinyal gelmedi"dir (ünitenin DO sensörü
 * olmayabilir, protokolde taban tanımlı olmayabilir). UI bu ayrımı korur:
 * rozet yalnız damga varken çıkar, yeşil bir "onay" rozeti gösterilmez.
 */
export interface MealReadinessView {
  status: 'low_oxygen' | 'no_reading';
  minDissolvedOxygen: number;
  observedDissolvedOxygen?: number;
  observedAt?: string;
  lowOxygenReductionPercent?: number;
  evaluatedAt: string;
}

export interface FeedingMealView {
  id: string;
  dayPlanId: string;
  unitId: string;
  siteId: string;
  mealIndex: number;
  scheduledAt: string;
  percentOfDaily: number;
  plannedKg: number;
  status: FeedingMealStatus;
  actualKg: number;
  pours: MealPour[];
  varianceKg: number | null;
  variancePercent: number | null;
  feedId: string;
  fedAt?: string;
  fedBy?: string;
  feedingMethod?: string;
  recalculatedAt?: string;
  notes?: string;
  readiness?: MealReadinessView | null;
}

export interface FeedingDayPlanView {
  id: string;
  assignmentId: string;
  protocolId: string;
  unitId: string;
  siteId: string;
  unitType: FeedingUnitType;
  unitName: string;
  unitCode: string;
  planDate: string;
  snapshot: DayPlanSnapshot;
  plannedTotalKg: number;
  unplannedActualKg: number;
  mealsPlanned: number;
  status: FeedingDayPlanStatus;
  skipReason?: string;
  /** Son 50 girdi (W8/FARM-MEDIUM-286 — dizi DB düzeyinde kırpılır). */
  recalcLog: RecalcLogEntry[];
  /** Planın ömrü boyunca TOPLAM yeniden hesap — kırpmadan bağımsız. */
  recalcCount: number;
  createdAt: string;
  updatedAt: string;
  meals?: FeedingMealView[];
}

export interface MealFeedingResult {
  id: string;
  status: FeedingMealStatus;
  actualKg: number;
  varianceKg: number | null;
  variancePercent: number | null;
}

export interface DayPlanAdminResult {
  /** Telde GraphQL enum ADI taşınır (DayPlanAdminOutcome). */
  outcome: 'RECALCULATED' | 'GENERATED' | 'TRANSITIONED';
  dayPlanId?: string;
}

export function useFeedingDayPlans(planDate: string, siteId?: string) {
  return useTenantQuery(
    ['feeding-day-plans', { planDate, siteId }],
    async () => {
      const data = await graphqlClient.request<{ feedingDayPlans: FeedingDayPlanView[] }>(
        FEEDING_DAY_PLANS_QUERY,
        { planDate, siteId },
      );
      return data.feedingDayPlans;
    },
    { staleTime: 15000, enabled: !!planDate },
  );
}

function useDayPlanInvalidation() {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'feeding-day-plans'),
    });
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'protocol-assignments'),
    });
  };
}

/**
 * Döküm kaydı (C-17): stok düşüren komut — zarf ZORUNLU ve mutation başına
 * TEK KEZ üretilir (retry aynı clientCommandId ile idempotent replay olur).
 */
export function useRecordMealFeeding() {
  const invalidate = useDayPlanInvalidation();
  return useMutation({
    mutationFn: async (params: {
      mealId: string;
      pourKg: number;
      finalize: boolean;
      feedingMethod?: string;
      notes?: string;
    }) => {
      const envelope = await buildCommandEnvelope('recordMealFeeding', {
        mealId: params.mealId,
        pourKg: params.pourKg,
        finalize: params.finalize,
      });
      const data = await graphqlClient.request<{ recordMealFeeding: MealFeedingResult }>(
        RECORD_MEAL_FEEDING_MUTATION,
        { input: { ...params, ...envelope } },
      );
      return data.recordMealFeeding;
    },
    onSuccess: () => invalidate(),
  });
}

/**
 * Öğünü döküm eklemeden kapat (W8 — FARM-MEDIUM-269). Sunucu yalnız
 * PARTIALLY_FED öğünü kabul eder; hiç dökümü olmayan öğünün doğru fiili
 * `useSkipMeal`'dir.
 */
export function useFinalizeMeal() {
  const invalidate = useDayPlanInvalidation();
  return useMutation({
    mutationFn: async (params: { mealId: string }) => {
      const envelope = await buildCommandEnvelope('finalizeMeal', { mealId: params.mealId });
      const data = await graphqlClient.request<{ finalizeMeal: MealFeedingResult }>(
        FINALIZE_MEAL_MUTATION,
        { input: { ...params, ...envelope } },
      );
      return data.finalizeMeal;
    },
    onSuccess: () => invalidate(),
  });
}

export function useSkipMeal() {
  const invalidate = useDayPlanInvalidation();
  return useMutation({
    mutationFn: async (params: { mealId: string; reason: string }) => {
      const data = await graphqlClient.request<{ skipMeal: MealFeedingResult }>(
        SKIP_MEAL_MUTATION,
        { input: params },
      );
      return data.skipMeal;
    },
    onSuccess: () => invalidate(),
  });
}

export function useCorrectMealPour() {
  const invalidate = useDayPlanInvalidation();
  return useMutation({
    mutationFn: async (params: { mealId: string; pourIndex: number; correctedKg: number }) => {
      const data = await graphqlClient.request<{ correctMealPour: MealFeedingResult }>(
        CORRECT_MEAL_POUR_MUTATION,
        { input: params },
      );
      return data.correctMealPour;
    },
    onSuccess: () => invalidate(),
  });
}

export function useRegenerateDayPlan() {
  const invalidate = useDayPlanInvalidation();
  return useMutation({
    mutationFn: async (unitId: string) => {
      const data = await graphqlClient.request<{ regenerateDayPlan: DayPlanAdminResult }>(
        REGENERATE_DAY_PLAN_MUTATION,
        { unitId },
      );
      return data.regenerateDayPlan;
    },
    onSuccess: () => invalidate(),
  });
}

export function useTransitionUnitFeed() {
  const invalidate = useDayPlanInvalidation();
  return useMutation({
    mutationFn: async (params: { unitId: string; toFeedId: string }) => {
      const data = await graphqlClient.request<{ transitionUnitFeed: DayPlanAdminResult }>(
        TRANSITION_UNIT_FEED_MUTATION,
        params,
      );
      return data.transitionUnitFeed;
    },
    onSuccess: () => invalidate(),
  });
}

// ============================================================================
// Tükenme tahmini (Faz 7 — protocolFeedForecast, K-10 dilimlenmiş snapshot)
// ============================================================================

export interface ForecastPerFeedView {
  feedId: string;
  feedCode: string;
  feedName: string;
  currentStockKg: number;
  dailyConsumptionSeries: number[];
  remainingStockSeries: number[];
  stockoutDate: string | null;
  daysOfCover: number | null;
  firstConsumptionDate: string | null;
  coverageFromAdoptionDays: number | null;
  reorderDate: string | null;
  reorderQuantityKg: number | null;
  procurementLeadTimeDays: number;
  leadTimeSource: 'feed' | 'default';
}

export interface ForecastTransitionView {
  fromFeedId: string;
  toFeedId: string;
  estimatedDate: string;
  daysFromNow: number;
}

export interface ForecastPerUnitView {
  unitId: string;
  unitName: string;
  unitCode: string;
  /** Ünitenin BUGÜNKÜ yemi (gün-0 bandı) — FARM-LOW-265. */
  currentFeedId: string | null;
  /** Ufuk sonunda ulaşılan yem (simülasyonun son bandı). */
  terminalFeedId: string | null;
  transitions: ForecastTransitionView[];
}

export interface ForecastAlertView {
  type:
    | 'STOCKOUT_FORECAST'
    | 'TRANSITION_COVERAGE_GAP'
    | 'REORDER_NOW'
    /** Havuz iyi ama sitenin yerel stoğu yetmiyor → satın alma değil TAŞIMA. */
    | 'SITE_TRANSFER_NEEDED';
  feedId: string;
  unitId?: string | null;
  /** Tipe özgü büyüklük (kapsama günü / eksik gün). */
  days: number;
  /** Alarmın işaret ettiği gün indeksi — dilimleme birimi. */
  atDay: number;
}

export interface ProtocolFeedForecastView {
  siteScopeKey: string;
  /**
   * 'TENANT' = kapsama/alarm otoritesi (havuz kararı); 'SITE' =
   * bilgilendirici kapsam, yalnız SITE_TRANSFER_NEEDED üretir.
   */
  poolScope: 'TENANT' | 'SITE';
  /** Snapshot 26 saatten eskiyse true — bayatlık gizlenmez. */
  stale: boolean;
  horizonDays: number;
  /** Snapshot tazeliği — "şu an itibarıyla" damgası (D-6). */
  computedAt: string;
  perFeed: ForecastPerFeedView[];
  perUnit: ForecastPerUnitView[];
  alerts: ForecastAlertView[];
  mortalityAssumption: { applied: boolean; source: 'species_survival_rate' | 'none' };
}

/**
 * Materyalize snapshot okuması — sorgu anında yeniden hesap YOK (K-10).
 * `refresh` MANAGER+ için insan-tetikli yedektir (tenant başına 5dk throttle,
 * ana tazelik yolu D-6 event-driven yenileme).
 *
 * `enabled`: siteler henüz yüklenmemişken siteId'siz istek atmamak için
 * (MODULE_USER'da Forbidden + gereksiz çift istek — FARM-MEDIUM-232);
 * siteId'siz tenant-geneli okuma MANAGER+ için bilinçli kullanım olarak kalır.
 */
export function useProtocolFeedForecast(
  siteId?: string,
  horizonDays = 90,
  options?: { enabled?: boolean },
) {
  return useTenantQuery(
    ['protocol-feed-forecast', { siteId, horizonDays }],
    async () => {
      const data = await graphqlClient.request<{
        protocolFeedForecast: ProtocolFeedForecastView | null;
      }>(PROTOCOL_FEED_FORECAST_QUERY, { siteId, horizonDays });
      return data.protocolFeedForecast;
    },
    { staleTime: 60000, enabled: options?.enabled ?? true },
  );
}
