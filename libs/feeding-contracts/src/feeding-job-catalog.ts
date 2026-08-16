import {
  canonicalJsonSha256,
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';

import {
  FEEDING_LOCAL_TIME_POLICY_V1,
  FEEDING_MAX_ABSOLUTE_MEAL_TIME_OFFSET_MINUTES,
  feedingClockSnapshot,
  feedingLocalMinute,
  feedingShiftLocalDate,
  feedingShiftLocalMinute,
  type FeedingClockSnapshot,
  type FeedingTimezone,
} from './feeding-timezone';

export const FEEDING_JOB_CATALOG_REVISION = 'feeding-job-catalog/v2';

export const FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY = Object.freeze({
  schemaVersion: 'feeding-schedule-dispatch-retry/v1',
  maxAttempts: 8,
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 900,
  multiplier: 2,
  captureFreshnessSeconds: 120,
  maxFutureSkewSeconds: 300,
  terminalDeadlineSeconds: 3600,
  terminalDisposition: 'quarantined',
} as const);

/**
 * Schedule-domain execution semantics admitted under the same catalog digest
 * as job cadence and dispatch policy. Executors derive cutoffs and bounded read
 * sizes from this value; a release cannot change one without changing the
 * catalog authority observed by the scheduler and database kernel.
 */
export const FEEDING_SCHEDULE_EXECUTION_POLICY_V1 = Object.freeze({
  schemaVersion: 'feeding-schedule-execution-policy/v1',
  mealOverdueGraceMinutes: 6 * 60,
  mealClaimPageSize: 1000,
  fcrWarningVariancePercent: 10,
  fcrCriticalVariancePercent: 20,
} as const);

export function feedingMealOverdueCutoff(observedAt: Date): Date {
  const observedAtMilliseconds = observedAt.getTime();
  if (!Number.isFinite(observedAtMilliseconds)) {
    throw new Error('Feeding meal overdue cutoff requires a valid observedAt');
  }
  return new Date(
    observedAtMilliseconds - FEEDING_SCHEDULE_EXECUTION_POLICY_V1.mealOverdueGraceMinutes * 60_000,
  );
}

export function isFeedingMealOverdue(scheduledAt: Date, observedAt: Date): boolean {
  const scheduledAtMilliseconds = scheduledAt.getTime();
  if (!Number.isFinite(scheduledAtMilliseconds)) {
    throw new Error('Feeding meal overdue check requires a valid scheduledAt');
  }
  return scheduledAtMilliseconds < feedingMealOverdueCutoff(observedAt).getTime();
}

const DAILY_SUMMARY_SETTLEMENT_CLOCK = feedingShiftLocalMinute(
  '00:00',
  FEEDING_MAX_ABSOLUTE_MEAL_TIME_OFFSET_MINUTES +
    FEEDING_SCHEDULE_EXECUTION_POLICY_V1.mealOverdueGraceMinutes,
);
if (DAILY_SUMMARY_SETTLEMENT_CLOCK.dayOffset !== 0) {
  throw new Error('Feeding daily-summary settlement exceeds the following local day');
}

/**
 * The latest legal 23:59 meal shifted by +12h becomes 11:59 on D+1. The
 * derived 18:00 cut is the first whole minute strictly beyond its grace.
 */
export const FEEDING_DAILY_SUMMARY_SETTLEMENT_V1 = Object.freeze({
  schemaVersion: 'feeding-daily-summary-settlement/v1',
  occurrenceLocalTime: DAILY_SUMMARY_SETTLEMENT_CLOCK.localTime,
  subjectDayOffset: -1,
} as const);

export function feedingDailySummaryPlanDate(occurrenceLocalDate: string): string {
  return feedingShiftLocalDate(
    occurrenceLocalDate,
    FEEDING_DAILY_SUMMARY_SETTLEMENT_V1.subjectDayOffset,
  );
}

/** Bounded operational contract shared by the scheduler and its DB health mirror. */
export const FEEDING_SCHEDULER_OBSERVABILITY_V1 = Object.freeze({
  schemaVersion: 'feeding-schedule-sweep-evidence/v1',
  heartbeatJob: 'feeding-catalog-reconciler',
  maxHeartbeatAgeSeconds: 180,
  dispositionKeys: Object.freeze([
    'enqueued',
    'idempotent',
    'business_slot_preserved',
    'already_completed',
    'already_running',
    'quarantined',
  ] as const),
} as const);

export const FEEDING_CAPABILITIES = Object.freeze([
  'scheduled.v2',
  'operator.manual',
  'device.mobile',
] as const);

export type FeedingCapability = (typeof FEEDING_CAPABILITIES)[number];

export const FEEDING_SCHEDULE_KINDS = Object.freeze([
  'local_daily',
  'local_weekly',
  'local_monthly',
  'absolute_interval',
  'on_demand',
] as const);

export type FeedingScheduleKind = (typeof FEEDING_SCHEDULE_KINDS)[number];

export const FEEDING_TIMEZONE_SOURCES = Object.freeze([
  'tenant_site_catalog',
  'utc_global',
] as const);
export const FEEDING_CLOCK_PROFILES = Object.freeze(['site_local', 'utc_global'] as const);
export const FEEDING_TARGET_CARDINALITIES = Object.freeze([
  'site',
  'tenant',
  'operation_target',
] as const);

export type FeedingTimezoneSource = (typeof FEEDING_TIMEZONE_SOURCES)[number];
export type FeedingClockProfile = (typeof FEEDING_CLOCK_PROFILES)[number];
export type FeedingTargetCardinality = (typeof FEEDING_TARGET_CARDINALITIES)[number];

export interface FeedingMisfirePolicy {
  readonly mode: 'catch_up';
  readonly catchUpWindowMinutes: number;
  readonly dstGap: typeof FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime;
  readonly dstFold: 'single_semantic_occurrence';
}

interface FeedingJobBase {
  readonly id: string;
  readonly capability: FeedingCapability;
  readonly scheduleKind: FeedingScheduleKind;
  readonly clockProfile: FeedingClockProfile;
  readonly targetCardinality: FeedingTargetCardinality;
  readonly timezoneSource: FeedingTimezoneSource;
  readonly misfire: FeedingMisfirePolicy | null;
  readonly leaseSeconds: number;
  readonly enabled: boolean;
}

export interface LocalDailyFeedingJob extends FeedingJobBase {
  readonly scheduleKind: 'local_daily';
  readonly localTime: string;
}

export interface LocalWeeklyFeedingJob extends FeedingJobBase {
  readonly scheduleKind: 'local_weekly';
  readonly localTime: string;
  readonly localWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export interface LocalMonthlyFeedingJob extends FeedingJobBase {
  readonly scheduleKind: 'local_monthly';
  readonly localTime: string;
  readonly localDayOfMonth: number;
}

export interface AbsoluteIntervalFeedingJob extends FeedingJobBase {
  readonly scheduleKind: 'absolute_interval';
  readonly intervalMinutes: number;
}

export interface OnDemandFeedingJob extends FeedingJobBase {
  readonly scheduleKind: 'on_demand';
}

export type FeedingJobDefinition =
  | LocalDailyFeedingJob
  | LocalWeeklyFeedingJob
  | LocalMonthlyFeedingJob
  | AbsoluteIntervalFeedingJob
  | OnDemandFeedingJob;

/**
 * The only feeding-operation catalogue.
 *
 * A caller supplies only one of these ids. Capability, schedule semantics,
 * lease policy and timezone authority are compiled from this value and are
 * checked again by the database mutation kernel. Retired v1 identities are
 * absent: an old pod presents an unknown job/capability and fails structurally.
 */
const FEEDING_JOB_CATALOG_SOURCE = [
  {
    id: 'v2.day-plan.generate',
    capability: 'scheduled.v2',
    scheduleKind: 'local_daily',
    clockProfile: 'site_local',
    targetCardinality: 'site',
    localTime: '06:00',
    timezoneSource: 'tenant_site_catalog',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 180,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 45 * 60,
    enabled: true,
  },
  {
    id: 'v2.meal-window.sweep',
    capability: 'scheduled.v2',
    scheduleKind: 'absolute_interval',
    clockProfile: 'site_local',
    targetCardinality: 'site',
    intervalMinutes: 15,
    timezoneSource: 'tenant_site_catalog',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 30,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 12 * 60,
    enabled: true,
  },
  {
    id: 'v2.morning.sweep',
    capability: 'scheduled.v2',
    scheduleKind: 'local_daily',
    clockProfile: 'site_local',
    targetCardinality: 'site',
    localTime: '05:30',
    timezoneSource: 'tenant_site_catalog',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 180,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 45 * 60,
    enabled: true,
  },
  {
    id: 'v2.daily-summary.publish',
    capability: 'scheduled.v2',
    scheduleKind: 'local_daily',
    clockProfile: 'site_local',
    targetCardinality: 'site',
    localTime: FEEDING_DAILY_SUMMARY_SETTLEMENT_V1.occurrenceLocalTime,
    timezoneSource: 'tenant_site_catalog',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 360,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 30 * 60,
    enabled: true,
  },
  {
    id: 'v2.stock-coverage.refresh',
    capability: 'scheduled.v2',
    scheduleKind: 'local_daily',
    clockProfile: 'utc_global',
    targetCardinality: 'tenant',
    localTime: '07:00',
    timezoneSource: 'utc_global',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 180,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 45 * 60,
    enabled: true,
  },
  {
    id: 'v2.fcr-alert.sweep',
    capability: 'scheduled.v2',
    scheduleKind: 'local_daily',
    clockProfile: 'site_local',
    targetCardinality: 'site',
    localTime: '18:00',
    timezoneSource: 'tenant_site_catalog',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 180,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 45 * 60,
    enabled: true,
  },
  {
    id: 'v2.retention.purge',
    capability: 'scheduled.v2',
    scheduleKind: 'local_monthly',
    clockProfile: 'utc_global',
    targetCardinality: 'tenant',
    localDayOfMonth: 1,
    localTime: '04:00',
    timezoneSource: 'utc_global',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes: 1440,
      dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 2 * 60 * 60,
    enabled: true,
  },
  {
    id: 'v2.forecast.refresh',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 30 * 60,
    enabled: true,
  },
  {
    id: 'manual.day-plan.regenerate',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'manual.feed.transition',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'manual.feeding.record',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'manual.feeding.update',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'manual.meal.correct',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'manual.meal.finalize',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'manual.meal.skip',
    capability: 'operator.manual',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
  {
    id: 'mobile.meal.record',
    capability: 'device.mobile',
    scheduleKind: 'on_demand',
    clockProfile: 'site_local',
    targetCardinality: 'operation_target',
    timezoneSource: 'tenant_site_catalog',
    misfire: null,
    leaseSeconds: 10 * 60,
    enabled: true,
  },
] as const satisfies readonly FeedingJobDefinition[];

export type FeedingJobId = (typeof FEEDING_JOB_CATALOG_SOURCE)[number]['id'];
export type ScheduledFeedingJobId = Extract<
  (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
  { readonly capability: 'scheduled.v2' }
>['id'];
export type SiteScheduledFeedingJobId = Extract<
  (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
  { readonly capability: 'scheduled.v2'; readonly targetCardinality: 'site' }
>['id'];
export type TenantScheduledFeedingJobId = Extract<
  (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
  { readonly capability: 'scheduled.v2'; readonly targetCardinality: 'tenant' }
>['id'];
export type OnDemandFeedingJobId = Extract<
  (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
  { readonly scheduleKind: 'on_demand' }
>['id'];
export type GovernedFeedingJobDefinition = FeedingJobDefinition & { readonly id: FeedingJobId };

const FEEDING_JOB_IDS: readonly FeedingJobId[] = Object.freeze(
  FEEDING_JOB_CATALOG_SOURCE.map((job) => job.id),
);

export const FEEDING_SCHEDULED_JOB_IDS: readonly ScheduledFeedingJobId[] = Object.freeze(
  FEEDING_JOB_CATALOG_SOURCE.filter(
    (
      job,
    ): job is Extract<
      (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
      { capability: 'scheduled.v2' }
    > => job.capability === 'scheduled.v2',
  ).map((job) => job.id),
);

export const FEEDING_SITE_SCHEDULED_JOB_IDS: readonly SiteScheduledFeedingJobId[] = Object.freeze(
  FEEDING_JOB_CATALOG_SOURCE.filter(
    (
      job,
    ): job is Extract<
      (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
      { capability: 'scheduled.v2'; targetCardinality: 'site' }
    > => job.capability === 'scheduled.v2' && job.targetCardinality === 'site',
  ).map((job) => job.id),
);

export const FEEDING_TENANT_SCHEDULED_JOB_IDS: readonly TenantScheduledFeedingJobId[] =
  Object.freeze(
    FEEDING_JOB_CATALOG_SOURCE.filter(
      (
        job,
      ): job is Extract<
        (typeof FEEDING_JOB_CATALOG_SOURCE)[number],
        { capability: 'scheduled.v2'; targetCardinality: 'tenant' }
      > => job.capability === 'scheduled.v2' && job.targetCardinality === 'tenant',
    ).map((job) => job.id),
  );

export function isSiteScheduledFeedingJobId(
  jobId: ScheduledFeedingJobId,
): jobId is SiteScheduledFeedingJobId {
  return FEEDING_SITE_SCHEDULED_JOB_IDS.some((candidate) => candidate === jobId);
}

export function isTenantScheduledFeedingJobId(
  jobId: ScheduledFeedingJobId,
): jobId is TenantScheduledFeedingJobId {
  return FEEDING_TENANT_SCHEDULED_JOB_IDS.some((candidate) => candidate === jobId);
}

const BASE_KEYS = [
  'id',
  'capability',
  'scheduleKind',
  'clockProfile',
  'targetCardinality',
  'timezoneSource',
  'misfire',
  'leaseSeconds',
  'enabled',
];

export class FeedingCatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedingCatalogValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new FeedingCatalogValidationError(
      `${path} must contain exactly [${required.join(', ')}], received [${actual.join(', ')}]`,
    );
  }
}

function positiveInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > maximum) {
    throw new FeedingCatalogValidationError(`${path} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function compileMisfire(value: unknown, path: string): FeedingMisfirePolicy {
  if (!isRecord(value)) {
    throw new FeedingCatalogValidationError(`${path} must be an object`);
  }
  assertExactKeys(value, ['mode', 'catchUpWindowMinutes', 'dstGap', 'dstFold'], path);
  if (
    value['mode'] !== 'catch_up' ||
    value['dstGap'] !== FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime ||
    value['dstFold'] !== 'single_semantic_occurrence'
  ) {
    throw new FeedingCatalogValidationError(`${path} has an unsupported reconciliation policy`);
  }
  return Object.freeze({
    mode: 'catch_up',
    catchUpWindowMinutes: positiveInteger(
      value['catchUpWindowMinutes'],
      `${path}.catchUpWindowMinutes`,
      10080,
    ),
    dstGap: FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime,
    dstFold: 'single_semantic_occurrence',
  });
}

function compileJob(value: unknown, index: number): GovernedFeedingJobDefinition {
  const path = `jobs[${index}]`;
  if (!isRecord(value)) throw new FeedingCatalogValidationError(`${path} must be an object`);
  if (!isOneOf(value['id'], FEEDING_JOB_IDS)) {
    throw new FeedingCatalogValidationError(`${path}.id is not a governed feeding job identity`);
  }
  if (!isOneOf(value['capability'], FEEDING_CAPABILITIES)) {
    throw new FeedingCatalogValidationError(`${path}.capability is unsupported`);
  }
  if (!isOneOf(value['scheduleKind'], FEEDING_SCHEDULE_KINDS)) {
    throw new FeedingCatalogValidationError(`${path}.scheduleKind is unsupported`);
  }
  if (!isOneOf(value['clockProfile'], FEEDING_CLOCK_PROFILES)) {
    throw new FeedingCatalogValidationError(`${path}.clockProfile is unsupported`);
  }
  if (!isOneOf(value['targetCardinality'], FEEDING_TARGET_CARDINALITIES)) {
    throw new FeedingCatalogValidationError(`${path}.targetCardinality is unsupported`);
  }
  if (!isOneOf(value['timezoneSource'], FEEDING_TIMEZONE_SOURCES)) {
    throw new FeedingCatalogValidationError(`${path}.timezoneSource is unsupported`);
  }
  if (typeof value['enabled'] !== 'boolean') {
    throw new FeedingCatalogValidationError(`${path}.enabled must be boolean`);
  }
  const leaseSeconds = positiveInteger(value['leaseSeconds'], `${path}.leaseSeconds`, 86400);

  if (value['scheduleKind'] === 'on_demand') {
    assertExactKeys(value, BASE_KEYS, path);
    if (
      value['misfire'] !== null ||
      value['targetCardinality'] !== 'operation_target' ||
      value['clockProfile'] !== 'site_local' ||
      value['timezoneSource'] !== 'tenant_site_catalog' ||
      value['capability'] === 'scheduled.v2'
    ) {
      throw new FeedingCatalogValidationError(
        `${path} has inconsistent on-demand authority fields`,
      );
    }
    return Object.freeze({
      id: value['id'],
      capability: value['capability'],
      scheduleKind: 'on_demand',
      clockProfile: 'site_local',
      targetCardinality: 'operation_target',
      timezoneSource: 'tenant_site_catalog',
      misfire: null,
      leaseSeconds,
      enabled: value['enabled'],
    });
  }

  if (value['capability'] !== 'scheduled.v2') {
    throw new FeedingCatalogValidationError(
      `${path} scheduled jobs require scheduled.v2 capability`,
    );
  }
  const misfire = compileMisfire(value['misfire'], `${path}.misfire`);
  const isGlobal = value['clockProfile'] === 'utc_global';
  if (
    (isGlobal &&
      (value['targetCardinality'] !== 'tenant' || value['timezoneSource'] !== 'utc_global')) ||
    (!isGlobal &&
      (value['targetCardinality'] !== 'site' || value['timezoneSource'] !== 'tenant_site_catalog'))
  ) {
    throw new FeedingCatalogValidationError(`${path} clock and target authority fields disagree`);
  }
  const common: {
    readonly id: FeedingJobId;
    readonly capability: 'scheduled.v2';
    readonly clockProfile: FeedingClockProfile;
    readonly targetCardinality: FeedingTargetCardinality;
    readonly timezoneSource: FeedingTimezoneSource;
    readonly misfire: FeedingMisfirePolicy;
    readonly leaseSeconds: number;
    readonly enabled: boolean;
  } = {
    id: value['id'],
    capability: 'scheduled.v2',
    clockProfile: value['clockProfile'],
    targetCardinality: value['targetCardinality'],
    timezoneSource: value['timezoneSource'],
    misfire,
    leaseSeconds,
    enabled: value['enabled'],
  };
  if (value['scheduleKind'] === 'absolute_interval') {
    assertExactKeys(value, [...BASE_KEYS, 'intervalMinutes'], path);
    return Object.freeze({
      ...common,
      scheduleKind: 'absolute_interval',
      intervalMinutes: positiveInteger(value['intervalMinutes'], `${path}.intervalMinutes`, 10080),
    });
  }
  if (
    typeof value['localTime'] !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value['localTime'])
  ) {
    throw new FeedingCatalogValidationError(`${path}.localTime must be HH:mm`);
  }
  if (value['scheduleKind'] === 'local_daily') {
    assertExactKeys(value, [...BASE_KEYS, 'localTime'], path);
    return Object.freeze({
      ...common,
      scheduleKind: 'local_daily',
      localTime: value['localTime'],
    });
  }
  if (value['scheduleKind'] === 'local_weekly') {
    assertExactKeys(value, [...BASE_KEYS, 'localTime', 'localWeekday'], path);
    const localWeekday = positiveInteger(value['localWeekday'], `${path}.localWeekday`, 7);
    if (
      localWeekday === 1 ||
      localWeekday === 2 ||
      localWeekday === 3 ||
      localWeekday === 4 ||
      localWeekday === 5 ||
      localWeekday === 6 ||
      localWeekday === 7
    ) {
      return Object.freeze({
        ...common,
        scheduleKind: 'local_weekly',
        localTime: value['localTime'],
        localWeekday,
      });
    }
    throw new FeedingCatalogValidationError(`${path}.localWeekday is invalid`);
  }
  assertExactKeys(value, [...BASE_KEYS, 'localTime', 'localDayOfMonth'], path);
  return Object.freeze({
    ...common,
    scheduleKind: 'local_monthly',
    localTime: value['localTime'],
    localDayOfMonth: positiveInteger(value['localDayOfMonth'], `${path}.localDayOfMonth`, 31),
  });
}

export function compileFeedingJobCatalog(value: unknown): readonly GovernedFeedingJobDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FeedingCatalogValidationError('feeding job catalog must be a non-empty array');
  }
  const jobs = value.map(compileJob);
  const identities = new Set(jobs.map((job) => job.id));
  if (identities.size !== jobs.length) {
    throw new FeedingCatalogValidationError('feeding job catalog contains duplicate identities');
  }
  if (
    identities.size !== FEEDING_JOB_IDS.length ||
    FEEDING_JOB_IDS.some((id) => !identities.has(id))
  ) {
    throw new FeedingCatalogValidationError(
      'feeding job catalog is not the exact governed job set',
    );
  }
  return Object.freeze(jobs);
}

export const FEEDING_JOB_CATALOG = compileFeedingJobCatalog(FEEDING_JOB_CATALOG_SOURCE);

const CATALOG_BY_ID = new Map<FeedingJobId, GovernedFeedingJobDefinition>(
  FEEDING_JOB_CATALOG.map((job) => [job.id, job]),
);

export function feedingJobDefinition(jobId: FeedingJobId): GovernedFeedingJobDefinition {
  const definition = CATALOG_BY_ID.get(jobId);
  if (!definition) {
    throw new Error(`Unknown feeding job id: ${jobId}`);
  }
  return definition;
}

export function canonicalizeFeedingCatalogArtifact(value: unknown): string {
  return canonicalJsonStringify(createCanonicalJsonDocumentV1(value));
}

const FEEDING_JOB_CATALOG_DOCUMENT = createCanonicalJsonDocumentV1({
  revision: FEEDING_JOB_CATALOG_REVISION,
  dispatchRetryPolicy: FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY,
  scheduleExecutionPolicy: FEEDING_SCHEDULE_EXECUTION_POLICY_V1,
  jobs: FEEDING_JOB_CATALOG,
});
export const FEEDING_JOB_CATALOG_CANONICAL_JSON = canonicalJsonStringify(
  FEEDING_JOB_CATALOG_DOCUMENT,
);

export const FEEDING_JOB_CATALOG_DIGEST = canonicalJsonSha256(
  {
    domain: 'aquaculture.feeding-job-catalog',
    schemaVersion: FEEDING_JOB_CATALOG_REVISION,
  },
  FEEDING_JOB_CATALOG_DOCUMENT,
);

export interface FeedingDueOccurrence {
  readonly scheduleKey: string;
  readonly dueAt: Date;
  readonly localDate: string;
  readonly timezone: FeedingTimezone;
  readonly caughtUp: boolean;
  readonly dstGapAdjusted: boolean;
}

function boundedRequestKey(definition: FeedingJobDefinition, requestKey?: string): string {
  if (!requestKey || requestKey.length > 200) {
    throw new Error(`${definition.id} requires a bounded operation request key`);
  }
  return requestKey;
}

function localPeriodMatches(
  definition: LocalDailyFeedingJob | LocalWeeklyFeedingJob | LocalMonthlyFeedingJob,
  clock: FeedingClockSnapshot,
): boolean {
  switch (definition.scheduleKind) {
    case 'local_daily':
      return true;
    case 'local_weekly':
      return clock.localWeekday === definition.localWeekday;
    case 'local_monthly':
      return Number(clock.localDate.slice(8, 10)) === definition.localDayOfMonth;
  }
}

function localScheduleKey(
  definition: LocalDailyFeedingJob | LocalWeeklyFeedingJob | LocalMonthlyFeedingJob,
  clock: FeedingClockSnapshot,
): string {
  return definition.scheduleKind === 'local_monthly'
    ? clock.localDate.slice(0, 7)
    : clock.localDate;
}

/**
 * Reconciles all semantic occurrences still eligible under the catalogued
 * misfire policy. Results are oldest-first so the database run ledger can skip
 * already-completed keys and claim the first missing occurrence after a restart.
 */
export function feedingDueOccurrences(
  definition: FeedingJobDefinition,
  at: Date,
  timezone: FeedingTimezone,
  requestKey?: string,
): FeedingDueOccurrence[] {
  if (!definition.enabled) return [];
  const atMinute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  switch (definition.scheduleKind) {
    case 'on_demand': {
      const clock = feedingClockSnapshot(atMinute, timezone);
      return [
        {
          scheduleKey: boundedRequestKey(definition, requestKey),
          dueAt: atMinute,
          localDate: clock.localDate,
          timezone,
          caughtUp: false,
          dstGapAdjusted: false,
        },
      ];
    }
    case 'absolute_interval': {
      const policy = definition.misfire;
      if (!policy) throw new Error(`${definition.id} has no scheduled misfire policy`);
      const intervalMs = definition.intervalMinutes * 60_000;
      const startMs = atMinute.getTime() - policy.catchUpWindowMinutes * 60_000;
      const firstBucket = Math.ceil(startMs / intervalMs) * intervalMs;
      const latestBucket = Math.floor(atMinute.getTime() / intervalMs) * intervalMs;
      const occurrences: FeedingDueOccurrence[] = [];
      for (let dueMs = firstBucket; dueMs <= latestBucket; dueMs += intervalMs) {
        const dueAt = new Date(dueMs);
        const clock = feedingClockSnapshot(dueAt, timezone);
        occurrences.push({
          scheduleKey: dueAt.toISOString(),
          dueAt,
          localDate: clock.localDate,
          timezone,
          caughtUp: dueMs < atMinute.getTime(),
          dstGapAdjusted: false,
        });
      }
      return occurrences;
    }
    case 'local_daily':
    case 'local_weekly':
    case 'local_monthly': {
      const policy = definition.misfire;
      if (!policy) throw new Error(`${definition.id} has no scheduled misfire policy`);
      const startMs = atMinute.getTime() - policy.catchUpWindowMinutes * 60_000;
      const targetMinute = feedingLocalMinute(definition.localTime);
      let previous: FeedingClockSnapshot | undefined;
      for (let dueMs = startMs; dueMs <= atMinute.getTime(); dueMs += 60_000) {
        const dueAt = new Date(dueMs);
        const clock = feedingClockSnapshot(dueAt, timezone);
        if (localPeriodMatches(definition, clock) && clock.localTime === definition.localTime) {
          return [
            {
              scheduleKey: localScheduleKey(definition, clock),
              dueAt,
              localDate: clock.localDate,
              timezone,
              caughtUp: dueMs < atMinute.getTime(),
              dstGapAdjusted: false,
            },
          ];
        }

        // A spring-forward can skip the catalogued wall minute entirely. The
        // typed policy maps that semantic occurrence to the first valid instant
        // after the gap; fall-back duplicates keep one semantic schedule key.
        if (
          previous &&
          previous.localDate === clock.localDate &&
          localPeriodMatches(definition, clock) &&
          feedingLocalMinute(previous.localTime) < targetMinute &&
          feedingLocalMinute(clock.localTime) > targetMinute
        ) {
          return [
            {
              scheduleKey: localScheduleKey(definition, clock),
              dueAt,
              localDate: clock.localDate,
              timezone,
              caughtUp: dueMs < atMinute.getTime(),
              dstGapAdjusted: true,
            },
          ];
        }
        previous = clock;
      }
      return [];
    }
  }
}
