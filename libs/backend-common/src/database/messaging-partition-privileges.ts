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
  reownedRelations: string[];
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
 * Grant `messaging_schema_owner` the authority the partition definer
 * function needs inside one tenant schema: USAGE+CREATE on the schema and
 * ownership of the messaging-domain partitioned relations.
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
  for (const relation of relations) {
    await executor.query(
      `ALTER TABLE ${relation.qualified_name} ` +
        `OWNER TO "${MESSAGING_PARTITION_OWNER_ROLE}"`,
    );
    reowned.push(relation.qualified_name);
  }

  return {
    tenantSchema: options.tenantSchema,
    ownerRole: MESSAGING_PARTITION_OWNER_ROLE,
    reownedRelations: reowned,
  };
}
