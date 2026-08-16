import {
  FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1,
  type FarmDurableMutationAuthorityIdV1,
} from '@aquaculture/shared-contracts';

import { freezeAuthorityGraphV1 } from './authority-immutability';
import { assertExactAuthoritySetV1 } from './authority-exact-set';

export const FEEDING_DURABLE_RELATION_AUTHORITY_REVISION = 'feeding-durable-relation-authority/v1';

export const FEEDING_DURABLE_RELATION_FAMILIES = Object.freeze([
  'feeding_domain',
  'feeding_control_plane',
  'supporting_domain',
] as const);

export type FeedingDurableRelationFamily = (typeof FEEDING_DURABLE_RELATION_FAMILIES)[number];

export type FeedingPhysicalRelation =
  | {
      /** The physical schema is the tenant schema selected by TenantMutationSession. */
      readonly scope: 'tenant_schema';
      readonly schema: null;
      readonly relation: string;
    }
  | {
      /** A fixed shared schema whose rows retain explicit tenant identity. */
      readonly scope: 'fixed_schema';
      readonly schema: 'farm';
      readonly relation: string;
    };

export interface FeedingEntityProjectionV1 {
  readonly symbol: string;
  /** null means an unqualified @Entity projected through tenant search_path. */
  readonly decoratorSchema: 'farm' | null;
}

export interface FeedingDurableRelationAuthorityV1 {
  readonly coordinate: `farm.${string}`;
  readonly family: FeedingDurableRelationFamily;
  readonly relationKind: 'table' | 'view';
  readonly physical: FeedingPhysicalRelation;
  readonly entity: FeedingEntityProjectionV1 | null;
  /** Views have no mutation writer; every durable table has exactly one. */
  readonly writer: FarmDurableMutationAuthorityIdV1 | null;
  readonly catalogRole: 'mutation_sink' | 'authority_state' | 'read_projection';
}

export interface FeedingMutationSinkRelationAuthorityV1 extends FeedingDurableRelationAuthorityV1 {
  readonly relationKind: 'table';
  readonly writer: FarmDurableMutationAuthorityIdV1;
  readonly catalogRole: 'mutation_sink';
}

export type FeedingTenantSchemaRelationAuthorityV1 = FeedingDurableRelationAuthorityV1 & {
  readonly physical: Extract<FeedingPhysicalRelation, { readonly scope: 'tenant_schema' }>;
};

export type FeedingFixedSchemaRelationAuthorityV1 = FeedingDurableRelationAuthorityV1 & {
  readonly physical: Extract<FeedingPhysicalRelation, { readonly scope: 'fixed_schema' }>;
};

export type FeedingTenantSchemaControlPlaneRelationAuthorityV1 =
  FeedingTenantSchemaRelationAuthorityV1 & {
    readonly family: 'feeding_control_plane';
  };

export type FeedingFixedSchemaControlPlaneRelationAuthorityV1 =
  FeedingFixedSchemaRelationAuthorityV1 & {
    readonly family: 'feeding_control_plane';
  };

const IDS = FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1;

const FEEDING_DURABLE_RELATION_AUTHORITY_SOURCE = [
  {
    coordinate: 'farm.batches_v2',
    family: 'supporting_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'batches_v2' },
    entity: { symbol: 'Batch', decoratorSchema: null },
    writer: IDS.BATCH_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_day_plans',
    family: 'feeding_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'feeding_day_plans' },
    entity: { symbol: 'FeedingDayPlan', decoratorSchema: null },
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_forecast_snapshots',
    family: 'feeding_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'feeding_forecast_snapshots' },
    entity: { symbol: 'FeedingForecastSnapshot', decoratorSchema: null },
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_forecast_generations',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'feeding_forecast_generations' },
    entity: null,
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_forecast_active_generation',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_forecast_active_generation',
    },
    entity: null,
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_forecast_legacy_quarantine',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_forecast_legacy_quarantine',
    },
    entity: null,
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_forecast_active_snapshots_v1',
    family: 'feeding_control_plane',
    relationKind: 'view',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_forecast_active_snapshots_v1',
    },
    entity: null,
    writer: null,
    catalogRole: 'read_projection',
  },
  {
    coordinate: 'farm.feeding_meals',
    family: 'feeding_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'feeding_meals' },
    entity: { symbol: 'FeedingMeal', decoratorSchema: null },
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.farm_mobile_command_receipts',
    family: 'supporting_domain',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'farm_mobile_command_receipts',
    },
    entity: { symbol: 'FarmMobileCommandReceipt', decoratorSchema: null },
    writer: IDS.MOBILE_COMMAND_RECEIPT,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_protocol_assignments',
    family: 'feeding_domain',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_protocol_assignments',
    },
    entity: { symbol: 'ProtocolAssignment', decoratorSchema: null },
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_protocols_v2',
    family: 'feeding_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'feeding_protocols_v2' },
    entity: { symbol: 'FeedingProtocolV2', decoratorSchema: null },
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_records',
    family: 'feeding_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'feeding_records' },
    entity: { symbol: 'FeedingRecord', decoratorSchema: null },
    writer: IDS.FEEDING_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_record_write_provenance',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_record_write_provenance',
    },
    entity: null,
    writer: IDS.FEEDING_PROVENANCE_KERNEL,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_record_backfill_rollback_journal',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_record_backfill_rollback_journal',
    },
    entity: null,
    writer: IDS.FEEDING_PROVENANCE_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_record_write_provenance_quarantine_v1',
    family: 'feeding_control_plane',
    relationKind: 'view',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_record_write_provenance_quarantine_v1',
    },
    entity: null,
    writer: null,
    catalogRole: 'read_projection',
  },
  {
    coordinate: 'farm.feeding_historical_provenance_events',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_historical_provenance_events',
    },
    entity: null,
    writer: IDS.FEEDING_PROVENANCE_KERNEL,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_historical_record_attribution_v1',
    family: 'feeding_control_plane',
    relationKind: 'view',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_historical_record_attribution_v1',
    },
    entity: null,
    writer: null,
    catalogRole: 'read_projection',
  },
  {
    coordinate: 'farm.feeding_historical_qualified_records_v1',
    family: 'feeding_control_plane',
    relationKind: 'view',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_historical_qualified_records_v1',
    },
    entity: null,
    writer: null,
    catalogRole: 'read_projection',
  },
  {
    coordinate: 'farm.feeding_historical_day_plan_growth_v1',
    family: 'feeding_control_plane',
    relationKind: 'view',
    physical: {
      scope: 'tenant_schema',
      schema: null,
      relation: 'feeding_historical_day_plan_growth_v1',
    },
    entity: null,
    writer: null,
    catalogRole: 'read_projection',
  },
  {
    coordinate: 'farm.tank_batches',
    family: 'supporting_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'tank_batches' },
    entity: { symbol: 'TankBatch', decoratorSchema: null },
    writer: IDS.BATCH_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.tanks',
    family: 'supporting_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'tanks' },
    entity: { symbol: 'Tank', decoratorSchema: null },
    writer: IDS.BATCH_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.stock_movements',
    family: 'supporting_domain',
    relationKind: 'table',
    physical: { scope: 'tenant_schema', schema: null, relation: 'stock_movements' },
    entity: { symbol: 'StockMovement', decoratorSchema: null },
    writer: IDS.STORAGE_AGGREGATE,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.outbox_events',
    family: 'supporting_domain',
    relationKind: 'table',
    physical: { scope: 'fixed_schema', schema: 'farm', relation: 'outbox_events' },
    entity: { symbol: 'FarmOutbox', decoratorSchema: 'farm' },
    writer: IDS.OUTBOX_EVENT,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_catalog_revisions',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: { scope: 'fixed_schema', schema: 'farm', relation: 'feeding_catalog_revisions' },
    entity: null,
    writer: IDS.FEEDING_CATALOG_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_job_catalog_entries',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_job_catalog_entries',
    },
    entity: null,
    writer: IDS.FEEDING_CATALOG_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_catalog_admission',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: { scope: 'fixed_schema', schema: 'farm', relation: 'feeding_catalog_admission' },
    entity: null,
    writer: IDS.FEEDING_CATALOG_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_catalog_admission_history',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_catalog_admission_history',
    },
    entity: null,
    writer: IDS.FEEDING_CATALOG_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_writer_authority',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: { scope: 'fixed_schema', schema: 'farm', relation: 'feeding_writer_authority' },
    entity: null,
    writer: IDS.FEEDING_CATALOG_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_writer_authority_history',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_writer_authority_history',
    },
    entity: null,
    writer: IDS.FEEDING_CATALOG_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_schedule_dispatches',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_schedule_dispatches',
    },
    entity: null,
    writer: IDS.FEEDING_SCHEDULE_DISPATCH_KERNEL,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_schedule_dispatch_transitions',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_schedule_dispatch_transitions',
    },
    entity: null,
    writer: IDS.FEEDING_SCHEDULE_DISPATCH_KERNEL,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_job_runs',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: { scope: 'fixed_schema', schema: 'farm', relation: 'feeding_job_runs' },
    entity: null,
    writer: IDS.FEEDING_OPERATION_KERNEL,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_job_run_transitions',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_job_run_transitions',
    },
    entity: null,
    writer: IDS.FEEDING_OPERATION_KERNEL,
    catalogRole: 'mutation_sink',
  },
  {
    coordinate: 'farm.feeding_scheduler_heartbeat',
    family: 'feeding_control_plane',
    relationKind: 'table',
    physical: {
      scope: 'fixed_schema',
      schema: 'farm',
      relation: 'feeding_scheduler_heartbeat',
    },
    entity: null,
    writer: IDS.FEEDING_SCHEDULE_DISPATCH_KERNEL,
    catalogRole: 'authority_state',
  },
  {
    coordinate: 'farm.feeding_job_run_projection',
    family: 'feeding_control_plane',
    relationKind: 'view',
    physical: { scope: 'fixed_schema', schema: 'farm', relation: 'feeding_job_run_projection' },
    entity: null,
    writer: null,
    catalogRole: 'read_projection',
  },
] as const satisfies readonly FeedingDurableRelationAuthorityV1[];

function assertAuthority(
  source: readonly FeedingDurableRelationAuthorityV1[],
): asserts source is readonly FeedingDurableRelationAuthorityV1[] {
  const coordinates = new Set<string>();
  const physical = new Set<string>();
  const entities = new Set<string>();
  for (const relation of source) {
    if (coordinates.has(relation.coordinate)) {
      throw new Error(`Duplicate feeding durable coordinate: ${relation.coordinate}`);
    }
    coordinates.add(relation.coordinate);
    const expectedCoordinate = `farm.${relation.physical.relation}`;
    if (relation.coordinate !== expectedCoordinate) {
      throw new Error(`Logical/physical feeding relation mismatch: ${relation.coordinate}`);
    }
    const physicalKey = `${relation.physical.scope}:${relation.physical.schema ?? '<tenant>'}.${relation.physical.relation}`;
    if (physical.has(physicalKey)) {
      throw new Error(`Duplicate feeding physical relation: ${physicalKey}`);
    }
    physical.add(physicalKey);
    if (relation.relationKind === 'view') {
      if (relation.writer !== null || relation.catalogRole !== 'read_projection') {
        throw new Error(`Feeding view claims mutation authority: ${relation.coordinate}`);
      }
    } else if (relation.writer === null || relation.catalogRole === 'read_projection') {
      throw new Error(`Feeding table lacks mutation authority: ${relation.coordinate}`);
    }
    if (relation.entity) {
      if (entities.has(relation.entity.symbol)) {
        throw new Error(`Duplicate feeding entity projection: ${relation.entity.symbol}`);
      }
      entities.add(relation.entity.symbol);
      const expectedSchema =
        relation.physical.scope === 'tenant_schema' ? null : relation.physical.schema;
      if (relation.entity.decoratorSchema !== expectedSchema) {
        throw new Error(`Entity schema differs from physical relation: ${relation.entity.symbol}`);
      }
    }
  }
}

assertAuthority(FEEDING_DURABLE_RELATION_AUTHORITY_SOURCE);

export const FEEDING_DURABLE_RELATION_AUTHORITY: readonly FeedingDurableRelationAuthorityV1[] =
  freezeAuthorityGraphV1(FEEDING_DURABLE_RELATION_AUTHORITY_SOURCE);

function isTenantSchemaRelation(
  relation: FeedingDurableRelationAuthorityV1,
): relation is FeedingTenantSchemaRelationAuthorityV1 {
  return relation.physical.scope === 'tenant_schema';
}

function isFixedSchemaRelation(
  relation: FeedingDurableRelationAuthorityV1,
): relation is FeedingFixedSchemaRelationAuthorityV1 {
  return relation.physical.scope === 'fixed_schema';
}

function isTenantSchemaControlPlaneRelation(
  relation: FeedingDurableRelationAuthorityV1,
): relation is FeedingTenantSchemaControlPlaneRelationAuthorityV1 {
  return relation.family === 'feeding_control_plane' && isTenantSchemaRelation(relation);
}

function isFixedSchemaControlPlaneRelation(
  relation: FeedingDurableRelationAuthorityV1,
): relation is FeedingFixedSchemaControlPlaneRelationAuthorityV1 {
  return relation.family === 'feeding_control_plane' && isFixedSchemaRelation(relation);
}

export const FEEDING_TENANT_SCHEMA_RELATION_AUTHORITIES: readonly FeedingTenantSchemaRelationAuthorityV1[] =
  Object.freeze(FEEDING_DURABLE_RELATION_AUTHORITY.filter(isTenantSchemaRelation));

export const FEEDING_FIXED_SCHEMA_RELATION_AUTHORITIES: readonly FeedingFixedSchemaRelationAuthorityV1[] =
  Object.freeze(FEEDING_DURABLE_RELATION_AUTHORITY.filter(isFixedSchemaRelation));

export const FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES: readonly FeedingTenantSchemaControlPlaneRelationAuthorityV1[] =
  Object.freeze(FEEDING_DURABLE_RELATION_AUTHORITY.filter(isTenantSchemaControlPlaneRelation));

export const FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES: readonly FeedingFixedSchemaControlPlaneRelationAuthorityV1[] =
  Object.freeze(FEEDING_DURABLE_RELATION_AUTHORITY.filter(isFixedSchemaControlPlaneRelation));

assertExactAuthoritySetV1(
  [...FEEDING_TENANT_SCHEMA_RELATION_AUTHORITIES, ...FEEDING_FIXED_SCHEMA_RELATION_AUTHORITIES].map(
    (relation) => relation.coordinate,
  ),
  FEEDING_DURABLE_RELATION_AUTHORITY.map((relation) => relation.coordinate),
  'feeding durable physical-scope projection',
);

function isMutationSinkRelation(
  relation: FeedingDurableRelationAuthorityV1,
): relation is FeedingMutationSinkRelationAuthorityV1 {
  return (
    relation.relationKind === 'table' &&
    relation.catalogRole === 'mutation_sink' &&
    relation.writer !== null
  );
}

export const FEEDING_MUTATION_SINK_RELATIONS: readonly FeedingMutationSinkRelationAuthorityV1[] =
  Object.freeze(FEEDING_DURABLE_RELATION_AUTHORITY.filter(isMutationSinkRelation));

export type FeedingDurableMutationCoordinate =
  (typeof FEEDING_DURABLE_RELATION_AUTHORITY_SOURCE)[number] extends infer Relation
    ? Relation extends { readonly catalogRole: 'mutation_sink'; readonly coordinate: infer C }
      ? C
      : never
    : never;

export const FEEDING_DURABLE_MUTATION_AUTHORITY_BY_COORDINATE = Object.freeze(
  Object.fromEntries(
    FEEDING_MUTATION_SINK_RELATIONS.map((relation) => [relation.coordinate, relation.writer]),
  ) as Readonly<Record<FeedingDurableMutationCoordinate, FarmDurableMutationAuthorityIdV1>>,
);

export function feedingMutationCoordinatesForWriter(
  writer: FarmDurableMutationAuthorityIdV1,
): readonly FeedingDurableMutationCoordinate[] {
  return Object.freeze(
    FEEDING_MUTATION_SINK_RELATIONS.filter((relation) => relation.writer === writer)
      .map((relation) => relation.coordinate as FeedingDurableMutationCoordinate)
      .sort(),
  );
}

export const FEEDING_CONTROL_PLANE_RELATION_AUTHORITIES = Object.freeze(
  FEEDING_DURABLE_RELATION_AUTHORITY.filter(
    (relation) => relation.family === 'feeding_control_plane',
  ),
);

assertExactAuthoritySetV1(
  [
    ...FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES,
    ...FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES,
  ].map((relation) => relation.coordinate),
  FEEDING_CONTROL_PLANE_RELATION_AUTHORITIES.map((relation) => relation.coordinate),
  'feeding control-plane physical-scope projection',
);
