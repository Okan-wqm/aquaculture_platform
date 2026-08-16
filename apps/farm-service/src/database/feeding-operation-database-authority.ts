import { FARM_FEEDING_SCHEDULER_DATABASE_ROLE } from '@platform/service-catalog';
import { FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES } from '@aquaculture/feeding-contracts';

/**
 * Exact database ownership/ACL inventory for the feeding control plane.
 *
 * Migrations and executable invariants consume this one list; relation and
 * function identities must never be rediscovered with wildcard grants.
 */
export const FEEDING_DATABASE_OWNER_ROLE = 'farm_schema_owner' as const;
export const FEEDING_RUNTIME_ROLE = 'farm_service' as const;
export const FEEDING_SCHEDULER_ROLE = FARM_FEEDING_SCHEDULER_DATABASE_ROLE;
export const FEEDING_MIGRATION_ROLE = 'db_migrate' as const;

export const FEEDING_CONTROL_PLANE_RELATIONS = Object.freeze(
  FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES.map((relation) => ({
    kind: relation.relationKind === 'view' ? ('VIEW' as const) : ('TABLE' as const),
    name: relation.coordinate,
  })),
);

export const FEEDING_CONTROL_PLANE_SEQUENCES = Object.freeze([
  'farm.feeding_schedule_dispatch_transitions_id_seq',
  'farm.feeding_job_run_transitions_id_seq',
] as const);

export const FEEDING_CONTROL_PLANE_HELPER_FUNCTIONS = Object.freeze([
  'farm.jsonb_has_exact_keys(jsonb,text[])',
  'farm.is_valid_feeding_catalog_job(jsonb)',
  'farm.canonical_feeding_json(jsonb)',
  'farm.is_valid_feeding_result_payload(jsonb)',
  'farm.feeding_result_hash_preimage(varchar,text)',
  'farm.feeding_result_digest(varchar,text)',
  'farm.reject_feeding_append_only_mutation()',
  'farm.validate_feeding_catalog_entry_insert()',
] as const);

export const FEEDING_CONTROL_PLANE_KERNEL_FUNCTIONS = Object.freeze([
  'farm.admit_feeding_catalog(bigint,varchar,varchar,varchar,jsonb)',
  'farm.transition_feeding_writer_authority(uuid,bigint,varchar,varchar,varchar,varchar,varchar,jsonb)',
  'farm.claim_feeding_job(uuid,varchar,varchar,date,varchar,varchar,varchar,varchar,uuid,varchar,varchar,varchar,bigint,bigint,varchar,jsonb)',
  'farm.complete_feeding_job(uuid,uuid,varchar,varchar,varchar,text,varchar,jsonb)',
  'farm.fail_feeding_job(uuid,uuid,varchar,varchar,jsonb)',
  'farm.compile_feeding_job_targets(varchar,varchar,varchar,timestamptz)',
  'farm.compile_feeding_scheduler_cut(varchar,varchar,timestamptz)',
  'farm.feeding_schedule_occurrence_matches(jsonb,timestamptz,varchar,varchar,timestamptz,date,boolean,boolean)',
  'farm.is_current_feeding_schedule_dispatch(uuid)',
  'farm.feeding_schedule_dispatch_claimability(uuid,timestamptz)',
  'farm.enqueue_feeding_schedule_dispatch(jsonb)',
  'farm.claim_feeding_schedule_dispatch(varchar)',
  'farm.complete_feeding_schedule_dispatch(uuid,uuid,uuid)',
  'farm.release_feeding_schedule_dispatch(uuid,uuid,varchar,varchar)',
  'farm.record_feeding_scheduler_sweep(jsonb)',
  'farm.read_feeding_scheduler_health(timestamptz)',
] as const);

export const FEEDING_TENANT_RUNTIME_KERNEL_FUNCTIONS = Object.freeze([
  'farm.claim_feeding_job(uuid,varchar,varchar,date,varchar,varchar,varchar,varchar,uuid,varchar,varchar,varchar,bigint,bigint,varchar,jsonb)',
  'farm.complete_feeding_job(uuid,uuid,varchar,varchar,varchar,text,varchar,jsonb)',
  'farm.fail_feeding_job(uuid,uuid,varchar,varchar,jsonb)',
  'farm.claim_feeding_schedule_dispatch(varchar)',
  'farm.complete_feeding_schedule_dispatch(uuid,uuid,uuid)',
  'farm.release_feeding_schedule_dispatch(uuid,uuid,varchar,varchar)',
] as const);

export const FEEDING_SCHEDULER_KERNEL_FUNCTIONS = Object.freeze([
  'farm.compile_feeding_job_targets(varchar,varchar,varchar,timestamptz)',
  'farm.compile_feeding_scheduler_cut(varchar,varchar,timestamptz)',
  'farm.enqueue_feeding_schedule_dispatch(jsonb)',
  'farm.record_feeding_scheduler_sweep(jsonb)',
  'farm.read_feeding_scheduler_health(timestamptz)',
] as const);

export const FEEDING_MIGRATION_KERNEL_FUNCTIONS = Object.freeze([
  'farm.admit_feeding_catalog(bigint,varchar,varchar,varchar,jsonb)',
  'farm.transition_feeding_writer_authority(uuid,bigint,varchar,varchar,varchar,varchar,varchar,jsonb)',
] as const);

export const FEEDING_MIGRATION_RELATION_PRIVILEGES = Object.freeze([
  { name: 'farm.feeding_catalog_revisions', privileges: 'SELECT, INSERT' },
  { name: 'farm.feeding_job_catalog_entries', privileges: 'SELECT, INSERT' },
  { name: 'farm.feeding_catalog_admission', privileges: 'SELECT' },
  { name: 'farm.feeding_catalog_admission_history', privileges: 'SELECT' },
  { name: 'farm.feeding_writer_authority', privileges: 'SELECT' },
  { name: 'farm.feeding_writer_authority_history', privileges: 'SELECT' },
] as const);
