import {
  canonicalJsonSha256,
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1,
  type FarmDurableMutationAuthorityIdV1,
} from '@aquaculture/shared-contracts';

import {
  FEEDING_DURABLE_MUTATION_AUTHORITY_BY_COORDINATE,
  FEEDING_MUTATION_SINK_RELATIONS,
  feedingMutationCoordinatesForWriter,
  type FeedingDurableMutationCoordinate,
} from './feeding-durable-relation-authority';
import {
  FEEDING_JOB_CATALOG,
  FEEDING_SCHEDULED_JOB_IDS,
  FEEDING_SCHEDULER_OBSERVABILITY_V1,
  type FeedingJobId,
} from './feeding-job-catalog';
import { freezeAuthorityGraphV1 } from './authority-immutability';
import { FEEDING_MEAL_MOBILE_COMMAND_V1 } from './feeding-record-vocabulary';

export const FEEDING_MUTATION_AUTHORITY_CATALOG_REVISION_V1 =
  'feeding-mutation-authority-catalog/v1';

export const FEEDING_SCHEDULER_TRIGGER = Object.freeze({
  name: FEEDING_SCHEDULER_OBSERVABILITY_V1.heartbeatJob,
  schedule: '* * * * *',
} as const);

export const FEEDING_DISPATCH_CONSUMER_TRIGGER = Object.freeze({
  name: 'feeding-schedule-dispatch-consumer',
  intervalMs: 5_000,
} as const);

export interface FeedingEventSubscriptionAuthorityV1 {
  readonly id: string;
  readonly runtimeServiceId: 'farm-service';
  readonly provider: string;
  readonly subscriptionMethod: string;
  readonly handlerMethod: string;
  readonly eventTypes: readonly string[];
}

const FEEDING_EVENT_SUBSCRIPTION_AUTHORITY_SOURCE = [
  {
    id: 'feeding-forecast-refresh/v1',
    runtimeServiceId: 'farm-service',
    provider: 'ForecastRefreshListener',
    subscriptionMethod: 'onModuleInit',
    handlerMethod: 'onEvent',
    eventTypes: [
      'StockMovementRecorded',
      'FeedTypeTransitioned',
      'FeedingProtocolAssigned',
      'FeedingProtocolAssignmentPaused',
    ],
  },
] as const satisfies readonly FeedingEventSubscriptionAuthorityV1[];

function assertEventSubscriptionAuthorities(
  authorities: readonly FeedingEventSubscriptionAuthorityV1[],
): void {
  const ids = new Set<string>();
  const ingresses = new Set<string>();
  const eventTypes = new Set<string>();
  for (const authority of authorities) {
    if (ids.has(authority.id)) {
      throw new Error(`Duplicate feeding event-subscription authority: ${authority.id}`);
    }
    ids.add(authority.id);
    const ingress = `${authority.runtimeServiceId}:${authority.provider}.${authority.subscriptionMethod}->${authority.handlerMethod}`;
    if (ingresses.has(ingress)) {
      throw new Error(`Duplicate feeding event-subscription ingress: ${ingress}`);
    }
    ingresses.add(ingress);
    if (authority.eventTypes.length === 0) {
      throw new Error(`Feeding event-subscription authority has no event type: ${authority.id}`);
    }
    for (const eventType of authority.eventTypes) {
      if (eventType.length === 0 || eventTypes.has(eventType)) {
        throw new Error(`Duplicate or empty feeding subscription event type: ${eventType}`);
      }
      eventTypes.add(eventType);
    }
  }
}

assertEventSubscriptionAuthorities(FEEDING_EVENT_SUBSCRIPTION_AUTHORITY_SOURCE);

/** Closed event-subscription ingress authority; listeners project this registry verbatim. */
export const FEEDING_EVENT_SUBSCRIPTION_AUTHORITIES_V1: readonly FeedingEventSubscriptionAuthorityV1[] =
  freezeAuthorityGraphV1(FEEDING_EVENT_SUBSCRIPTION_AUTHORITY_SOURCE);

function requireEventSubscriptionAuthority(id: string): FeedingEventSubscriptionAuthorityV1 {
  const authority = FEEDING_EVENT_SUBSCRIPTION_AUTHORITIES_V1.find(
    (candidate) => candidate.id === id,
  );
  if (!authority) throw new Error(`Missing feeding event-subscription authority: ${id}`);
  return authority;
}

export const FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY = requireEventSubscriptionAuthority(
  'feeding-forecast-refresh/v1',
);

export const FEEDING_MUTATION_CLASSIFICATIONS = Object.freeze([
  'operation',
  'configuration',
  'retired',
] as const);

export type FeedingMutationClassification = (typeof FEEDING_MUTATION_CLASSIFICATIONS)[number];

export type FeedingMutationLifecycle = 'active' | 'retired';

export interface FeedingDurableSinkAuthority {
  /** Schema-qualified relation or durable outbox coordinate. */
  readonly coordinate: FeedingDurableMutationCoordinate;
  /** The globally unique aggregate/repository authority for this coordinate. */
  readonly writer: FarmDurableMutationAuthorityIdV1;
}

export const FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID =
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.FEEDING_AGGREGATE;

interface FeedingMutationIngressBase {
  readonly provider: string;
  readonly method: string;
}

export interface FeedingGraphqlMutationIngress extends FeedingMutationIngressBase {
  readonly kind: 'graphql_mutation';
}

export interface FeedingCronMutationIngress extends FeedingMutationIngressBase {
  readonly kind: 'cron';
  readonly trigger: string;
}

export interface FeedingIntervalMutationIngress extends FeedingMutationIngressBase {
  readonly kind: 'interval';
  readonly trigger: string;
}

export interface FeedingEventMutationIngress extends FeedingMutationIngressBase {
  readonly kind: 'event_subscription';
  readonly subscriptionMethod: string;
  readonly eventTypes: readonly string[];
}

export type FeedingMutationIngress =
  | FeedingGraphqlMutationIngress
  | FeedingCronMutationIngress
  | FeedingIntervalMutationIngress
  | FeedingEventMutationIngress;

export const FEEDING_MUTATION_TRANSACTION_BOUNDARIES_V1 = Object.freeze([
  'feeding_operation_kernel',
  'tenant_transaction',
  'restore_authority',
] as const);

export type FeedingMutationTransactionBoundaryV1 =
  (typeof FEEDING_MUTATION_TRANSACTION_BOUNDARIES_V1)[number];

export interface FeedingMutationTransactionAuthorityV1 {
  /** Stable runtime provider token; the composition root proves singleton wiring. */
  readonly provider: string;
  /** The sole method allowed to open the catalogued transaction boundary. */
  readonly method: string;
  readonly boundary: FeedingMutationTransactionBoundaryV1;
  /** Every feeding mutation is executed against the governed tenant schema. */
  readonly schema: 'farm';
}

export interface FeedingMutationAuthorityV1 {
  readonly id: string;
  readonly classification: FeedingMutationClassification;
  readonly lifecycle: FeedingMutationLifecycle;
  readonly runtimeServiceId: 'farm-service' | 'farm-feeding-scheduler';
  readonly ingress: FeedingMutationIngress;
  /** Presentation and durable admission owners, in execution order. */
  readonly admissionOwners: readonly string[];
  /** First process-local component that owns dispatch after presentation. */
  readonly dispatchOwner: string;
  /** CQRS handler symbol when this ingress is carried by CommandBus. */
  readonly commandHandler: string | null;
  readonly transaction: FeedingMutationTransactionAuthorityV1;
  /** Closed operation identities, or empty for non-control-plane legacy/configuration paths. */
  readonly operationJobIds: readonly FeedingJobId[];
  readonly durableSinks: readonly FeedingDurableSinkAuthority[];
}

export type FeedingMutationAuthorityCatalogV1 = readonly FeedingMutationAuthorityV1[];

type GraphqlEntryInput = Omit<FeedingMutationAuthorityV1, 'id' | 'ingress' | 'runtimeServiceId'> & {
  readonly provider: string;
  readonly method: string;
};

type RuntimeEntryInput = Omit<FeedingMutationAuthorityV1, 'id' | 'ingress'> & {
  readonly ingress:
    | FeedingCronMutationIngress
    | FeedingIntervalMutationIngress
    | FeedingEventMutationIngress;
};

function graphqlEntry(input: GraphqlEntryInput): FeedingMutationAuthorityV1 {
  return {
    id: `graphql_mutation:${input.provider}.${input.method}`,
    classification: input.classification,
    lifecycle: input.lifecycle,
    runtimeServiceId: 'farm-service',
    ingress: { kind: 'graphql_mutation', provider: input.provider, method: input.method },
    admissionOwners: input.admissionOwners,
    dispatchOwner: input.dispatchOwner,
    commandHandler: input.commandHandler,
    transaction: input.transaction,
    operationJobIds: input.operationJobIds,
    durableSinks: input.durableSinks,
  };
}

function runtimeEntry(input: RuntimeEntryInput): FeedingMutationAuthorityV1 {
  return {
    ...input,
    id: `${input.ingress.kind}:${input.ingress.provider}.${input.ingress.method}`,
  };
}

function sinks(
  ...coordinates: readonly FeedingDurableMutationCoordinate[]
): readonly FeedingDurableSinkAuthority[] {
  return coordinates.map((coordinate) => ({
    coordinate,
    writer: FEEDING_DURABLE_MUTATION_AUTHORITY_BY_COORDINATE[coordinate],
  }));
}

const FEEDING_OPERATION_KERNEL_COORDINATES = feedingMutationCoordinatesForWriter(
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.FEEDING_OPERATION_KERNEL,
);

/** Adds the journal rows written by every coordinator-owned operation transaction. */
function coordinatedOperationSinks(
  ...coordinates: readonly FeedingDurableMutationCoordinate[]
): readonly FeedingDurableSinkAuthority[] {
  return sinks(
    ...FEEDING_OPERATION_KERNEL_COORDINATES,
    'farm.feeding_historical_provenance_events',
    ...coordinates,
  );
}

const OPERATION_ADMISSION = [
  'GqlAuthGuard+Roles',
  'FeedingOperationCoordinatorService.executeOperation',
  'farm.claim_feeding_job',
] as const;

const PROTOCOL_CONFIGURATION_ADMISSION = [
  'GqlAuthGuard+Roles',
  'FeedingProtocolV2Resolver.commandBus',
] as const;

const FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1 = {
  provider: 'FeedingOperationCoordinatorService',
  method: 'execute',
  boundary: 'feeding_operation_kernel',
  schema: 'farm',
} as const satisfies FeedingMutationTransactionAuthorityV1;

const FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1 = {
  provider: 'FeedingMutationTransactionAuthority',
  method: 'execute',
  boundary: 'tenant_transaction',
  schema: 'farm',
} as const satisfies FeedingMutationTransactionAuthorityV1;

const FEEDING_SCHEDULE_DISPATCH_TRANSACTION_AUTHORITY_V1 = {
  provider: 'FeedingScheduleDispatchPort',
  method: 'enqueue',
  boundary: 'feeding_operation_kernel',
  schema: 'farm',
} as const satisfies FeedingMutationTransactionAuthorityV1;

const FEEDING_RECORD_CREATE_SINKS = coordinatedOperationSinks(
  'farm.feeding_records',
  'farm.feeding_record_write_provenance',
  'farm.batches_v2',
  'farm.tank_batches',
  'farm.tanks',
  'farm.stock_movements',
  'farm.feeding_day_plans',
  'farm.outbox_events',
);

const FEEDING_RECORD_UPDATE_SINKS = coordinatedOperationSinks(
  'farm.feeding_records',
  'farm.batches_v2',
  'farm.tank_batches',
  'farm.tanks',
  'farm.stock_movements',
  'farm.feeding_day_plans',
  'farm.outbox_events',
);

const MEAL_OPERATION_SINKS = coordinatedOperationSinks(
  'farm.feeding_meals',
  'farm.feeding_records',
  'farm.feeding_record_write_provenance',
  'farm.batches_v2',
  'farm.tank_batches',
  'farm.tanks',
  'farm.stock_movements',
  'farm.feeding_day_plans',
  'farm.outbox_events',
);

const MEAL_FINALIZATION_SINKS = coordinatedOperationSinks(
  'farm.feeding_meals',
  'farm.batches_v2',
  'farm.tank_batches',
  'farm.tanks',
  'farm.feeding_day_plans',
  'farm.outbox_events',
);

const DAY_PLAN_OPERATION_SINKS = coordinatedOperationSinks(
  'farm.feeding_day_plans',
  'farm.feeding_meals',
  'farm.feeding_protocol_assignments',
  'farm.outbox_events',
);

const FORECAST_OPERATION_SINKS = coordinatedOperationSinks(
  'farm.feeding_forecast_generations',
  'farm.feeding_forecast_active_generation',
  'farm.feeding_forecast_snapshots',
  'farm.outbox_events',
);

const SCHEDULED_OPERATION_SINKS = coordinatedOperationSinks(
  'farm.feeding_day_plans',
  'farm.feeding_meals',
  'farm.batches_v2',
  'farm.tank_batches',
  'farm.tanks',
  'farm.feeding_forecast_generations',
  'farm.feeding_forecast_active_generation',
  'farm.feeding_forecast_snapshots',
  'farm.feeding_protocol_assignments',
  'farm.farm_mobile_command_receipts',
  'farm.outbox_events',
);

const SCHEDULE_DISPATCH_SINKS = sinks(
  'farm.feeding_schedule_dispatches',
  'farm.feeding_schedule_dispatch_transitions',
);

const PROTOCOL_SINKS = sinks('farm.feeding_protocols_v2');
const PROTOCOL_ARCHIVE_SINKS = sinks(
  'farm.feeding_protocols_v2',
  'farm.feeding_protocol_assignments',
  'farm.outbox_events',
);
const PROTOCOL_ASSIGNMENT_SINKS = sinks('farm.feeding_protocol_assignments', 'farm.outbox_events');

const FEEDING_MUTATION_AUTHORITY_CATALOG_SOURCE_V1: FeedingMutationAuthorityCatalogV1 = [
  graphqlEntry({
    provider: 'FeedingResolver',
    method: 'createFeedingRecord',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'CreateFeedingRecordHandler',
    commandHandler: 'CreateFeedingRecordHandler',
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.feeding.record'],
    durableSinks: FEEDING_RECORD_CREATE_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingResolver',
    method: 'updateFeedingRecord',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'UpdateFeedingRecordHandler',
    commandHandler: 'UpdateFeedingRecordHandler',
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.feeding.update'],
    durableSinks: FEEDING_RECORD_UPDATE_SINKS,
  }),
  graphqlEntry({
    provider: 'MealExecutionResolver',
    method: FEEDING_MEAL_MOBILE_COMMAND_V1.operationType,
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.recordMeal',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['mobile.meal.record'],
    durableSinks: MEAL_OPERATION_SINKS,
  }),
  graphqlEntry({
    provider: 'MealExecutionResolver',
    method: 'correctMealPour',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.correctMeal',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.meal.correct'],
    durableSinks: MEAL_OPERATION_SINKS,
  }),
  graphqlEntry({
    provider: 'MealExecutionResolver',
    method: 'finalizeMeal',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.finalizeMeal',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.meal.finalize'],
    durableSinks: MEAL_FINALIZATION_SINKS,
  }),
  graphqlEntry({
    provider: 'MealExecutionResolver',
    method: 'skipMeal',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.skipMeal',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.meal.skip'],
    durableSinks: MEAL_OPERATION_SINKS,
  }),
  graphqlEntry({
    provider: 'MealExecutionResolver',
    method: 'regenerateDayPlan',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.regenerateDayPlan',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.day-plan.regenerate'],
    durableSinks: DAY_PLAN_OPERATION_SINKS,
  }),
  graphqlEntry({
    provider: 'MealExecutionResolver',
    method: 'transitionUnitFeed',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.transitionFeed',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['manual.feed.transition'],
    durableSinks: DAY_PLAN_OPERATION_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedForecastResolver',
    method: 'refreshProtocolFeedForecast',
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: OPERATION_ADMISSION,
    dispatchOwner: 'FeedingOperationCommandPort.refreshForecast',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['v2.forecast.refresh'],
    durableSinks: FORECAST_OPERATION_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'createFeedingProtocolV2',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'CreateFeedingProtocolV2Handler',
    commandHandler: 'CreateFeedingProtocolV2Handler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'updateFeedingProtocolV2',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'UpdateFeedingProtocolV2Handler',
    commandHandler: 'UpdateFeedingProtocolV2Handler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'archiveFeedingProtocolV2',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'ArchiveFeedingProtocolV2Handler',
    commandHandler: 'ArchiveFeedingProtocolV2Handler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_ARCHIVE_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'assignProtocolToUnit',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'AssignProtocolToUnitHandler',
    commandHandler: 'AssignProtocolToUnitHandler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_ASSIGNMENT_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'assignProtocolToBatchUnits',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'AssignProtocolToBatchUnitsHandler',
    commandHandler: 'AssignProtocolToBatchUnitsHandler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_ASSIGNMENT_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'updateProtocolAssignment',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'UpdateProtocolAssignmentHandler',
    commandHandler: 'UpdateProtocolAssignmentHandler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_ASSIGNMENT_SINKS,
  }),
  graphqlEntry({
    provider: 'FeedingProtocolV2Resolver',
    method: 'unassignProtocolFromUnit',
    classification: 'configuration',
    lifecycle: 'active',
    admissionOwners: PROTOCOL_CONFIGURATION_ADMISSION,
    dispatchOwner: 'UnassignProtocolHandler',
    commandHandler: 'UnassignProtocolHandler',
    transaction: FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: [],
    durableSinks: PROTOCOL_ASSIGNMENT_SINKS,
  }),
  runtimeEntry({
    runtimeServiceId: 'farm-feeding-scheduler',
    ingress: {
      kind: 'cron',
      provider: 'FeedingScheduleIngressService',
      method: 'reconcileCatalogSchedule',
      trigger: FEEDING_SCHEDULER_TRIGGER.name,
    },
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: [
      'FeedingScheduleIngressService.reconcileCatalogSchedule',
      'FeedingOperationTargetCompilerService.compileCut',
      'farm.enqueue_feeding_schedule_dispatch',
    ],
    dispatchOwner: 'FeedingScheduleDispatchPort.enqueue',
    commandHandler: null,
    transaction: FEEDING_SCHEDULE_DISPATCH_TRANSACTION_AUTHORITY_V1,
    operationJobIds: FEEDING_SCHEDULED_JOB_IDS,
    durableSinks: SCHEDULE_DISPATCH_SINKS,
  }),
  runtimeEntry({
    runtimeServiceId: 'farm-service',
    ingress: {
      kind: 'interval',
      provider: 'FeedingScheduleDispatchConsumerService',
      method: 'drainDueDispatches',
      trigger: FEEDING_DISPATCH_CONSUMER_TRIGGER.name,
    },
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: [
      'farm.claim_feeding_schedule_dispatch',
      'FeedingOperationCoordinatorService.executeOperation',
      'farm.claim_feeding_job',
    ],
    dispatchOwner: 'FeedingOperationCommandPort.reconcileScheduled',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: FEEDING_SCHEDULED_JOB_IDS,
    durableSinks: [...SCHEDULED_OPERATION_SINKS, ...SCHEDULE_DISPATCH_SINKS],
  }),
  runtimeEntry({
    runtimeServiceId: 'farm-service',
    ingress: {
      kind: 'event_subscription',
      provider: FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY.provider,
      method: FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY.handlerMethod,
      subscriptionMethod: FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY.subscriptionMethod,
      eventTypes: FEEDING_FORECAST_REFRESH_EVENT_AUTHORITY.eventTypes,
    },
    classification: 'operation',
    lifecycle: 'active',
    admissionOwners: [
      'ForecastRefreshListener.shouldRefresh',
      'FeedingOperationCoordinatorService.executeOperation',
      'farm.claim_feeding_job',
    ],
    dispatchOwner: 'FeedingOperationCommandPort.refreshForecast',
    commandHandler: null,
    transaction: FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1,
    operationJobIds: ['v2.forecast.refresh'],
    durableSinks: FORECAST_OPERATION_SINKS,
  }),
];

function assertCatalogAuthority(catalog: FeedingMutationAuthorityCatalogV1): void {
  const ids = new Set<string>();
  const ingressCoordinates = new Set<string>();
  const durableCoordinateWriters = new Map<string, string>();
  const usedDurableCoordinates = new Set<string>();
  const governedJobIds = new Set<FeedingJobId>(FEEDING_JOB_CATALOG.map((job) => job.id));
  const operationKernelCoordinates = new Set(FEEDING_OPERATION_KERNEL_COORDINATES);

  for (const mutation of catalog) {
    if (ids.has(mutation.id))
      throw new Error(`Duplicate feeding mutation identity: ${mutation.id}`);
    ids.add(mutation.id);

    const ingressCoordinate = `${mutation.ingress.kind}:${mutation.ingress.provider}.${mutation.ingress.method}`;
    if (mutation.id !== ingressCoordinate) {
      throw new Error(`Feeding mutation identity differs from ingress: ${mutation.id}`);
    }
    if (ingressCoordinates.has(ingressCoordinate)) {
      throw new Error(`Duplicate feeding mutation ingress: ${ingressCoordinate}`);
    }
    ingressCoordinates.add(ingressCoordinate);

    if (mutation.lifecycle === 'retired' && mutation.classification !== 'retired') {
      throw new Error(`Retired feeding mutation lacks retired classification: ${mutation.id}`);
    }
    if (mutation.lifecycle !== 'retired' && mutation.classification === 'retired') {
      throw new Error(`Live feeding mutation is classified retired: ${mutation.id}`);
    }
    if (mutation.classification === 'operation' && mutation.operationJobIds.length === 0) {
      throw new Error(`Operation mutation has no governed job identity: ${mutation.id}`);
    }
    if (mutation.classification !== 'operation' && mutation.operationJobIds.length !== 0) {
      throw new Error(`Non-operation mutation claims a job identity: ${mutation.id}`);
    }
    if (mutation.admissionOwners.length === 0 || mutation.durableSinks.length === 0) {
      throw new Error(
        `Feeding mutation is missing admission or durable sink ownership: ${mutation.id}`,
      );
    }
    if (
      mutation.transaction.provider.length === 0 ||
      mutation.transaction.method.length === 0 ||
      mutation.transaction.schema !== 'farm' ||
      !FEEDING_MUTATION_TRANSACTION_BOUNDARIES_V1.includes(mutation.transaction.boundary)
    ) {
      throw new Error(`Feeding mutation has an invalid transaction authority: ${mutation.id}`);
    }
    if (
      mutation.classification === 'configuration' &&
      (mutation.transaction.boundary !== 'tenant_transaction' ||
        mutation.transaction.provider !== FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1.provider ||
        mutation.transaction.method !== FEEDING_CONFIGURATION_TRANSACTION_AUTHORITY_V1.method)
    ) {
      throw new Error(
        `Feeding configuration mutation bypasses its tenant transaction authority: ${mutation.id}`,
      );
    }
    for (const jobId of mutation.operationJobIds) {
      if (!governedJobIds.has(jobId)) {
        throw new Error(`Feeding mutation references unknown job ${jobId}: ${mutation.id}`);
      }
    }
    const sinkCoordinates = new Set<string>();
    for (const sink of mutation.durableSinks) {
      const expectedWriter = Reflect.get(
        FEEDING_DURABLE_MUTATION_AUTHORITY_BY_COORDINATE,
        sink.coordinate,
      );
      if (typeof expectedWriter !== 'string' || sink.writer !== expectedWriter) {
        throw new Error(`Unknown or mismatched durable mutation authority: ${sink.coordinate}`);
      }
      const currentWriter = durableCoordinateWriters.get(sink.coordinate);
      if (currentWriter !== undefined && currentWriter !== sink.writer) {
        throw new Error(`Duplicate mutation authority for durable coordinate: ${sink.coordinate}`);
      }
      durableCoordinateWriters.set(sink.coordinate, sink.writer);
      usedDurableCoordinates.add(sink.coordinate);
      const sinkCoordinate = `${sink.coordinate}:${sink.writer}`;
      if (sinkCoordinates.has(sinkCoordinate)) {
        throw new Error(
          `Duplicate durable sink in feeding mutation ${mutation.id}: ${sinkCoordinate}`,
        );
      }
      sinkCoordinates.add(sinkCoordinate);
    }
    if (
      mutation.transaction.provider === FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1.provider &&
      mutation.transaction.method === FEEDING_OPERATION_TRANSACTION_AUTHORITY_V1.method &&
      [...operationKernelCoordinates].some(
        (coordinate) =>
          !sinkCoordinates.has(
            `${coordinate}:${FEEDING_DURABLE_MUTATION_AUTHORITY_BY_COORDINATE[coordinate]}`,
          ),
      )
    ) {
      throw new Error(`Coordinator operation omits its durable journal: ${mutation.id}`);
    }
  }

  const governedCoordinates = FEEDING_MUTATION_SINK_RELATIONS.map(
    (relation) => relation.coordinate,
  );
  if (
    governedCoordinates.length !== usedDurableCoordinates.size ||
    governedCoordinates.some((coordinate) => !usedDurableCoordinates.has(coordinate))
  ) {
    throw new Error('Feeding durable mutation authority registry is not set-equal to catalog use');
  }

  const catalogEventIngresses = catalog
    .filter(
      (
        mutation,
      ): mutation is FeedingMutationAuthorityV1 & {
        readonly ingress: FeedingEventMutationIngress;
      } => mutation.ingress.kind === 'event_subscription',
    )
    .map((mutation) => ({
      runtimeServiceId: mutation.runtimeServiceId,
      provider: mutation.ingress.provider,
      subscriptionMethod: mutation.ingress.subscriptionMethod,
      handlerMethod: mutation.ingress.method,
      eventTypes: [...mutation.ingress.eventTypes],
    }));
  const eventAuthorities = FEEDING_EVENT_SUBSCRIPTION_AUTHORITIES_V1.map((authority) => ({
    runtimeServiceId: authority.runtimeServiceId,
    provider: authority.provider,
    subscriptionMethod: authority.subscriptionMethod,
    handlerMethod: authority.handlerMethod,
    eventTypes: [...authority.eventTypes],
  }));
  if (
    canonicalJsonStringify(createCanonicalJsonDocumentV1(catalogEventIngresses)) !==
    canonicalJsonStringify(createCanonicalJsonDocumentV1(eventAuthorities))
  ) {
    throw new Error('Feeding event ingress catalog is not set-equal to subscription authority');
  }
}

assertCatalogAuthority(FEEDING_MUTATION_AUTHORITY_CATALOG_SOURCE_V1);

export const FEEDING_MUTATION_AUTHORITY_CATALOG_V1: FeedingMutationAuthorityCatalogV1 =
  freezeAuthorityGraphV1(FEEDING_MUTATION_AUTHORITY_CATALOG_SOURCE_V1);

const FEEDING_MUTATION_AUTHORITY_BY_ID_V1 = new Map(
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1.map((authority) => [authority.id, authority]),
);

export function feedingMutationAuthorityV1(id: string): FeedingMutationAuthorityV1 {
  const authority = FEEDING_MUTATION_AUTHORITY_BY_ID_V1.get(id);
  if (!authority) throw new Error(`Unknown feeding mutation authority: ${id}`);
  return authority;
}

export interface FeedingMutationRuntimeProviderAuthorityV1 {
  readonly runtimeServiceId: FeedingMutationAuthorityV1['runtimeServiceId'];
  readonly provider: string;
  readonly methods: readonly string[];
}

function compileRuntimeProviderAuthoritiesV1(
  catalog: FeedingMutationAuthorityCatalogV1,
): readonly FeedingMutationRuntimeProviderAuthorityV1[] {
  const providers = new Map<
    string,
    {
      readonly runtimeServiceId: FeedingMutationAuthorityV1['runtimeServiceId'];
      readonly provider: string;
      readonly methods: Set<string>;
    }
  >();
  for (const mutation of catalog) {
    const key = `${mutation.runtimeServiceId}:${mutation.ingress.provider}`;
    const authority = providers.get(key) ?? {
      runtimeServiceId: mutation.runtimeServiceId,
      provider: mutation.ingress.provider,
      methods: new Set<string>(),
    };
    if (authority.methods.has(mutation.ingress.method)) {
      throw new Error(`Duplicate feeding mutation runtime method coordinate: ${mutation.id}`);
    }
    authority.methods.add(mutation.ingress.method);
    providers.set(key, authority);
  }
  return freezeAuthorityGraphV1(
    [...providers.values()]
      .map(({ runtimeServiceId, provider, methods }) => ({
        runtimeServiceId,
        provider,
        methods: [...methods].sort(),
      }))
      .sort((left, right) => {
        const leftCoordinate = `${left.runtimeServiceId}:${left.provider}`;
        const rightCoordinate = `${right.runtimeServiceId}:${right.provider}`;
        return leftCoordinate < rightCoordinate ? -1 : leftCoordinate > rightCoordinate ? 1 : 0;
      }),
  );
}

/** One provider row with an exact method set, compiled from mutation coordinates. */
export const FEEDING_MUTATION_RUNTIME_PROVIDER_AUTHORITIES_V1 = compileRuntimeProviderAuthoritiesV1(
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1,
);

export const FEEDING_TENANT_TRANSACTION_MUTATION_IDS_V1: readonly string[] = Object.freeze(
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
    (authority) => authority.transaction.boundary === 'tenant_transaction',
  )
    .map((authority) => authority.id)
    .sort(),
);

const FEEDING_MUTATION_AUTHORITY_CATALOG_DOCUMENT_V1 = createCanonicalJsonDocumentV1({
  revision: FEEDING_MUTATION_AUTHORITY_CATALOG_REVISION_V1,
  mutations: FEEDING_MUTATION_AUTHORITY_CATALOG_V1,
});
export const FEEDING_MUTATION_AUTHORITY_CATALOG_CANONICAL_JSON_V1 = canonicalJsonStringify(
  FEEDING_MUTATION_AUTHORITY_CATALOG_DOCUMENT_V1,
);

export const FEEDING_MUTATION_AUTHORITY_CATALOG_DIGEST_V1 = canonicalJsonSha256(
  {
    domain: 'aquaculture.feeding-mutation-authority-catalog',
    schemaVersion: FEEDING_MUTATION_AUTHORITY_CATALOG_REVISION_V1,
  },
  FEEDING_MUTATION_AUTHORITY_CATALOG_DOCUMENT_V1,
);
