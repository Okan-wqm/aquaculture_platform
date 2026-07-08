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
 * The provisioner "forward path" for a newly provisioned tenant: apply the
 * complete messaging-partition privilege recipe (re-own the partitioned
 * relations to `messaging_schema_owner` for partition DDL AND grant the runtime
 * `messaging_service` role DML — the two MUST travel together, see below).
 *
 * The recipe itself lives in ONE place — the bootstrap-owned SQL function
 * `platform.grant_messaging_partition_authority(text)` (Stage 010) — which both
 * this forward path AND the Stage 010 idempotent backfill loop call. Collapsing
 * the recipe into a single function (rather than hand-mirroring it in TS and
 * SQL) is deliberate: the bug it closed (DATA-HIGH-006 / "permission denied for
 * table messages") existed because the runtime-DML grant lived in neither copy
 * of a mirrored recipe. A single SSoT makes that drift structurally impossible,
 * mirroring how `platform.create_messaging_partition` centralises partition DDL.
 *
 * The function is SECURITY INVOKER, so it runs with this caller's privileges
 * (the db-migrate control connection) — identical to the inline SQL it
 * replaced. It returns the relations it re-owned + granted.
 *
 * `assertTenantSchema` is kept as a fail-fast client-side guard (the function
 * also validates server-side) so a bad schema name is rejected before any DB
 * round-trip.
 */
export async function grantTenantMessagingPartitionAuthority(
  executor: MessagingPartitionAuthorityQueryExecutor,
  options: MessagingPartitionAuthorityOptions,
): Promise<MessagingPartitionAuthorityGrant> {
  assertTenantSchema(options.tenantSchema);

  const rows = (await executor.query(
    `SELECT platform.grant_messaging_partition_authority($1) AS relations`,
    [options.tenantSchema],
  )) as Array<{ relations: string[] | null }>;
  const relations = rows[0]?.relations ?? [];

  return {
    tenantSchema: options.tenantSchema,
    ownerRole: MESSAGING_PARTITION_OWNER_ROLE,
    runtimeRole: MESSAGING_RUNTIME_ROLE,
    reownedRelations: relations,
    runtimeGrantedRelations: relations,
  };
}
