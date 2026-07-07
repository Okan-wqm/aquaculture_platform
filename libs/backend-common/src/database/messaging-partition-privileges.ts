import { TENANT_SCHEMA_NAME_RE } from './tenant-aware-schemas';

/**
 * Messaging partition authority for tenant schemas (DATA-HIGH-006).
 *
 * WHY: monthly RANGE partitions for messages/message_receipts are created by
 * platform.create_messaging_partition — a SECURITY DEFINER function owned by
 * `messaging_schema_owner` (Stage 010). Two pg16 facts bind the shape of the
 * grants below (both proven empirically on the pinned production image,
 * 2026-06-11):
 *
 *   1. Creating a partition requires OWNERSHIP of the parent table — schema
 *      CREATE alone fails with "must be owner of table". The provisioner
 *      fan-out creates tenant clones under the bootstrap superuser, so the
 *      messaging-domain relations must be re-owned to
 *      `messaging_schema_owner` at provisioning time.
 *   2. Placing the new partition child needs CREATE on the tenant schema.
 *
 * Stage 010 backfills schemas that existed before this module; this helper
 * is the forward path every newly provisioned tenant takes (the
 * APPLYING_GRANTS stage of tenant-schema-provisioner). Together they are the
 * SSoT for the messaging-partition slice of the tenant privilege model
 * (ORPHAN-HIGH-088's messaging slice).
 */

const MESSAGING_PARTITION_OWNER_ROLE = 'messaging_schema_owner';

/**
 * The runtime role that serves messaging queries. It must retain DML on the
 * partitioned relations after they are re-owned to the definer role below —
 * Stage 010's EXECUTE-only lockdown removes raw DDL from this role by design,
 * NOT DML. `runtime_role` for the `messaging` schema in the Stage-008 role map.
 */
const MESSAGING_RUNTIME_ROLE = 'messaging_service';

/**
 * Parents and their partition children: `messages` / `message_receipts`
 * plus the `<table>_<year>_<month>` naming the partition function preserves.
 */
const MESSAGING_PARTITIONED_RELATION_RE =
  '^(messages|message_receipts)(_[0-9]{4}_[0-9]{2})?$';

export interface MessagingPartitionAuthorityQueryExecutor {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface MessagingPartitionAuthorityOptions {
  tenantSchema: string;
}

export interface MessagingPartitionAuthorityGrant {
  tenantSchema: string;
  ownerRole: string;
  /** The runtime role re-granted DML on the partitioned relations. */
  runtimeRole: string;
  reownedRelations: string[];
  /**
   * Relations (parents + existing children) explicitly re-granted DML to the
   * runtime role. Future children are covered by the ALTER DEFAULT PRIVILEGES
   * keyed to the owner role, so they never appear here.
   */
  runtimeGrantedRelations: string[];
}

function assertTenantSchema(value: string): void {
  if (!TENANT_SCHEMA_NAME_RE.test(value)) {
    throw new Error(
      `[messaging-partition-grants] Refusing non-tenant schema "${value}". ` +
        `Expected ${TENANT_SCHEMA_NAME_RE.toString()}.`,
    );
  }
}

/**
 * Grant the two authorities the messaging partition model needs inside one
 * tenant schema:
 *
 *   1. `messaging_schema_owner` — USAGE+CREATE on the schema and ownership of
 *      the messaging-domain partitioned relations, so the SECURITY DEFINER
 *      partition function can place new monthly children (pg16 requires
 *      parent OWNERSHIP for `PARTITION OF`).
 *   2. `messaging_service` (the runtime role) — DML on those same relations.
 *      Re-owning them to the definer role (1) moves them OUT of the reach the
 *      runtime role has on the aquaculture-owned messaging tables, so without
 *      this the app hits "permission denied for table messages" and the
 *      Messages surface cannot load. Restored the canonical Postgres way:
 *      ALTER DEFAULT PRIVILEGES keyed to the DEFINER role so every FUTURE
 *      monthly child the definer creates is auto-granted (no per-partition
 *      ceremony, no blind spot), plus an explicit GRANT on the parents and
 *      already-created children (default privileges are forward-only). This is
 *      the same GRANT + ALTER DEFAULT PRIVILEGES idiom Stage 008 uses for the
 *      source schemas — the runtime role keeps EXECUTE-only DDL (raw DDL stays
 *      structurally impossible) while regaining the DML it needs to serve rows.
 *
 * Idempotent: GRANT is a set operation and ALTER ... OWNER TO / ALTER DEFAULT
 * PRIVILEGES no-op when already applied — safe to re-run for backfill.
 */
export async function grantTenantMessagingPartitionAuthority(
  executor: MessagingPartitionAuthorityQueryExecutor,
  options: MessagingPartitionAuthorityOptions,
): Promise<MessagingPartitionAuthorityGrant> {
  assertTenantSchema(options.tenantSchema);

  await executor.query(
    `GRANT USAGE, CREATE ON SCHEMA "${options.tenantSchema}" ` +
      `TO "${MESSAGING_PARTITION_OWNER_ROLE}"`,
  );

  // Forward cover: any table the definer role creates in this schema (every
  // future monthly partition child) auto-grants the runtime role. Keyed FOR
  // ROLE the definer because the SECURITY DEFINER function creates children as
  // that role, not as the executing connection.
  await executor.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${MESSAGING_PARTITION_OWNER_ROLE}" ` +
      `IN SCHEMA "${options.tenantSchema}" ` +
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${MESSAGING_RUNTIME_ROLE}"`,
  );

  const relations = (await executor.query(
    `SELECT c.oid::regclass::text AS qualified_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND c.relname ~ $2`,
    [options.tenantSchema, MESSAGING_PARTITIONED_RELATION_RE],
  )) as Array<{ qualified_name: string }>;

  const reowned: string[] = [];
  const runtimeGranted: string[] = [];
  for (const relation of relations) {
    await executor.query(
      `ALTER TABLE ${relation.qualified_name} ` +
        `OWNER TO "${MESSAGING_PARTITION_OWNER_ROLE}"`,
    );
    reowned.push(relation.qualified_name);

    // Explicit backfill: default privileges only bind future objects, so the
    // parents and every already-created child are granted here.
    await executor.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${relation.qualified_name} ` +
        `TO "${MESSAGING_RUNTIME_ROLE}"`,
    );
    runtimeGranted.push(relation.qualified_name);
  }

  return {
    tenantSchema: options.tenantSchema,
    ownerRole: MESSAGING_PARTITION_OWNER_ROLE,
    runtimeRole: MESSAGING_RUNTIME_ROLE,
    reownedRelations: reowned,
    runtimeGrantedRelations: runtimeGranted,
  };
}
