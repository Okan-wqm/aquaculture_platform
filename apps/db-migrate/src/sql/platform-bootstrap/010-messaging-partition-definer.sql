-- ============================================================================
-- Platform Bootstrap — Stage 10: Messaging Partition DDL Authority
-- (DATA-HIGH-006 closure; dissolves the DATA-HIGH-005 carve-out)
--
-- WHY THIS EXISTS
-- ---------------
-- PartitionManagerService (messaging-service) ensures monthly RANGE
-- partitions for messages/message_receipts in the `messaging` source schema
-- AND in every tenant_<uuid> clone. Stage 008 reduces runtime roles to
-- USAGE+DML, and two pg16 behaviours were proven EMPIRICALLY on the pinned
-- production image (2026-06-11 probe, recorded in
-- docs/reviews/data-expert/2026-06-11-messaging-partition-definer.md):
--
--   1. `CREATE TABLE IF NOT EXISTS ... PARTITION OF` checks schema CREATE
--      BEFORE the existence short-circuit (the 2026-06-11 boot crash class).
--   2. Actually CREATING a new partition requires OWNERSHIP of the parent
--      table — schema CREATE alone fails with "must be owner of table".
--      The DATA-HIGH-005 schema-CREATE carve-out therefore only unblocked
--      the no-op path; the first genuinely new partition (monthly cron)
--      would have crashed again.
--
-- THE AUTHORITY MODEL
-- -------------------
-- All partition DDL moves into ONE SECURITY DEFINER function owned by
-- `messaging_schema_owner` — the role that already owns every
-- messaging-domain parent table in the source schema (Stage 008 three-pass
-- loop). Ownership is the binding requirement (probe #2), so a thinner
-- dedicated role was rejected: it would need messaging_schema_owner
-- membership anyway, dissolving any least-privilege gain. Tenant-schema
-- messaging-domain relations are normalized to the same owner below, which
-- is ADR-011-consistent: per-tenant clones of a service's tables remain
-- that service's domain objects.
--
-- The runtime role (`messaging_service`) holds EXECUTE on the function and
-- NOTHING else — raw runtime DDL becomes structurally impossible
-- (Tier-1 make-impossible).
--
-- New tenant schemas get the same owner+grant treatment at provisioning
-- time (tenant-schema-provisioner APPLYING_GRANTS stage); the loop below is
-- the idempotent backfill for schemas that already exist.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SSoT: the COMPLETE messaging-partition privilege recipe for ONE tenant
-- schema. Both provisioning paths call this ONE function, so the recipe can
-- never drift between "new tenant" (the TS provisioner forward path,
-- grantTenantMessagingPartitionAuthority) and "existing tenant" (the backfill
-- loop below) — and, critically, the runtime-DML grant travels with the
-- re-own BY CONSTRUCTION. Tenant messaging broke precisely because that grant
-- lived in NEITHER copy of a hand-mirrored recipe; collapsing to one function
-- (mirroring how platform.create_messaging_partition centralises the partition
-- DDL) makes that class of drift structurally impossible.
--
-- The recipe:
--   * messaging_schema_owner gets USAGE+CREATE so the SECURITY DEFINER
--     partition function can place new monthly children (pg16 needs schema
--     CREATE + parent OWNERSHIP for PARTITION OF).
--   * messaging-domain parents AND their existing children move to
--     messaging_schema_owner (ALTER on the parent does NOT cascade to existing
--     children — both relkinds are enumerated).
--   * The runtime role (messaging_service) regains DML: an explicit GRANT on
--     the parents + existing children, PLUS ALTER DEFAULT PRIVILEGES keyed to
--     the definer role so every FUTURE monthly child is auto-granted (no
--     per-partition ceremony, no blind spot). Same GRANT + ALTER DEFAULT
--     PRIVILEGES idiom Stage 008 uses for source schemas; the runtime role
--     keeps EXECUTE-only DDL (raw DDL stays structurally impossible).
--
-- SECURITY INVOKER (the default): runs with the CALLER's privileges — identical
-- to the inline SQL it replaces. Both callers (the bootstrap superuser here and
-- the db-migrate control connection in the TS provisioner) already hold the
-- GRANT / ALTER OWNER / ALTER DEFAULT PRIVILEGES rights. Returns the relations
-- it re-owned + granted so the TS caller keeps its structured result.
-- Idempotent: GRANT is a set operation; ALTER ... OWNER / ALTER DEFAULT
-- PRIVILEGES no-op when already applied.
CREATE OR REPLACE FUNCTION platform.grant_messaging_partition_authority(
  p_tenant_schema text
) RETURNS text[]
LANGUAGE plpgsql
AS $grant_messaging_partition_authority$
DECLARE
  rel record;
  reowned text[] := ARRAY[]::text[];
BEGIN
  IF p_tenant_schema !~ '^tenant_[a-f0-9]{16}$' THEN
    RAISE EXCEPTION
      'grant_messaging_partition_authority: "%" is not a tenant schema', p_tenant_schema;
  END IF;

  EXECUTE format(
    'GRANT USAGE, CREATE ON SCHEMA %I TO messaging_schema_owner',
    p_tenant_schema
  );

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE messaging_schema_owner IN SCHEMA %I '
    || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO messaging_service',
    p_tenant_schema
  );

  FOR rel IN
    SELECT c.oid::regclass::text AS qualified_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = p_tenant_schema
       AND c.relkind IN ('r', 'p')
       AND c.relname ~ '^(messages|message_receipts)(_[0-9]{4}_[0-9]{2})?$'
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO messaging_schema_owner', rel.qualified_name);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO messaging_service',
      rel.qualified_name
    );
    reowned := array_append(reowned, rel.qualified_name);
  END LOOP;

  RETURN reowned;
END
$grant_messaging_partition_authority$;

-- Idempotent backfill for schemas that already exist (new tenants take the SAME
-- function via the TS provisioner forward path). One call per tenant — the
-- recipe lives ONLY in the function above, never inline.
DO $messaging_partition_authority_backfill$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_catalog.pg_namespace
     WHERE nspname ~ '^tenant_[a-f0-9]{16}$'
  LOOP
    PERFORM platform.grant_messaging_partition_authority(tenant_schema);
  END LOOP;
END
$messaging_partition_authority_backfill$;

-- The single central partition-DDL primitive. SECURITY DEFINER + pinned
-- search_path + hard allowlists; identifiers via %I, literals via %L.
-- Lives in `platform` (bootstrap-owned, survives any service-schema
-- rebuild; precedent: platform.request_tenant_schema_provisioning).
CREATE OR REPLACE FUNCTION platform.create_messaging_partition(
  p_schema text,
  p_table  text,
  p_year   integer,
  p_month  integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_messaging_partition$
DECLARE
  v_from date;
  v_partition text;
BEGIN
  -- Hard allowlists: this function must never become a generic DDL
  -- primitive. Tables are the two partition-managed messaging relations;
  -- schemas are the messaging source schema or a tenant clone.
  IF p_table NOT IN ('messages', 'message_receipts') THEN
    RAISE EXCEPTION 'create_messaging_partition: table "%" is not partition-managed', p_table;
  END IF;
  IF p_schema !~ '^(messaging|tenant_[a-f0-9]{16})$' THEN
    RAISE EXCEPTION 'create_messaging_partition: schema "%" is not in the allowlist', p_schema;
  END IF;
  IF p_month < 1 OR p_month > 12 OR p_year < 2020 OR p_year > 2100 THEN
    RAISE EXCEPTION 'create_messaging_partition: out-of-band period %-%', p_year, p_month;
  END IF;

  -- Month boundaries computed server-side (make_date + interval handles
  -- year rollover); the caller cannot pass mismatched range bounds.
  v_from := make_date(p_year, p_month, 1);
  -- Partition naming preserves the pre-existing convention
  -- (<table>_<year>_<zero-padded-month>) so partitions created before this
  -- function are indistinguishable from ones created by it.
  v_partition := format('%s_%s_%s', p_table, p_year, lpad(p_month::text, 2, '0'));

  -- IF NOT EXISTS is sound here: the definer (owner role) holds both the
  -- schema CREATE and the parent ownership, so the pg16
  -- privilege-before-existence check passes and an existing partition
  -- no-ops. Deliberately NO DEFAULT partition — a missing partition must
  -- fail loudly (see PartitionManagerService docblock).
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
    p_schema, v_partition, p_schema, p_table, v_from, v_from + interval '1 month'
  );
END
$create_messaging_partition$;

-- CREATE OR REPLACE preserves a pre-existing owner; on first creation the
-- owner is the bootstrap superuser — the explicit ALTER is what makes
-- SECURITY DEFINER execute as messaging_schema_owner. Signature changes are
-- a deliberate two-statement migration (DROP old signature + CREATE new);
-- never rely on OR REPLACE across signatures (pg keys functions by
-- name+argtypes and would leave the stale overload callable).
ALTER FUNCTION platform.create_messaging_partition(text, text, integer, integer)
  OWNER TO messaging_schema_owner;

-- SECURITY DEFINER functions default to PUBLIC EXECUTE — revoke first,
-- then grant to exactly the one legitimate caller.
REVOKE ALL ON FUNCTION platform.create_messaging_partition(text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.create_messaging_partition(text, text, integer, integer) TO messaging_service;
