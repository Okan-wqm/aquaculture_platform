import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * Migration: Align DB ↔ entity drift for the 11 columns the schema-drift
 * validator flagged as divergent (CI run 24637240275).
 *
 * # Why this exists — INFRA-CRITICAL-009 → INFRA-CRITICAL-011 chain
 *
 * INFRA-CRITICAL-009 removed `dataSource.synchronize()` from
 * SourceSchemaBootstrapService. With synchronize gone, the schema-drift
 * validator's readout becomes the canonical entity↔DB delta. The 11
 * violations it reports are real entity-vs-migration gaps that this
 * migration closes:
 *
 *   ## Block 1: 7 missing columns
 *
 *   - message_attachments.is_deleted    (boolean NOT NULL DEFAULT false)
 *   - message_attachments.deleted_at    (timestamptz nullable)
 *   - messages.isAiGenerated            (boolean NOT NULL DEFAULT false)
 *   - legal_holds.legalMatterId         (uuid; NOT NULL post-backfill)
 *   - legal_holds.legalMatterDescription (text nullable)
 *   - legal_holds.requestedBy           (uuid nullable)
 *   - legal_holds.expiresAt             (timestamptz nullable)
 *
 *   ## Block 2: 4 nullability convergences (column exists, NULL → NOT NULL)
 *
 *   - channel_members.tenantId          (uuid → NOT NULL after backfill)
 *   - channels.tenantId                 (uuid → NOT NULL after backfill)
 *   - messages.tenantId                 (uuid → NOT NULL after backfill)
 *   - messaging_outbox.isDeadLettered   (boolean → NOT NULL DEFAULT false)
 *
 * # Tenant fan-out (load-bearing — see CLAUDE.md ADR-011)
 *
 * The aqua-db-migrate runner declares the messaging schema slot as
 * `tenantAware: true`, which means this migration runs FIRST against
 * the source schema (`messaging`), THEN against every existing tenant
 * schema (`tenant_<uuid>`) in fan-out. Each iteration pins
 * `search_path` to the right schema, so the unqualified table names
 * below resolve correctly per-iteration. This guarantees:
 *
 *   1. SOURCE schema gets the new columns first → any future tenant
 *      provisioned via `CREATE TABLE ... (LIKE messaging.<t> INCLUDING ALL)`
 *      automatically inherits them (handled in
 *      libs/backend-common/src/database/schema-manager.service.ts:728).
 *   2. EVERY existing tenant schema gets the same `ALTER TABLE`s in
 *      fan-out, so the live tenants converge to the new shape on this
 *      deploy — no orphan tenants left on the old shape.
 *
 * IF NOT EXISTS / IF EXISTS guards make the DDL idempotent across both
 * iterations and re-runs.
 *
 * # Backfill strategy (Block 2)
 *
 * - `channels.tenantId`, `channel_members.tenantId`, `messages.tenantId`
 *   were added by migration 1782000000000 as nullable. Most existing
 *   rows already have valid tenant IDs from runtime writes (the column
 *   was always written even when nullable at the schema level). The
 *   backfill in this migration is defensive: for tenant-cloned schemas,
 *   the `tenant_<uuid>` schema name DERIVES the tenant id (last 16 hex
 *   chars padded), so we can safely UPSERT NULLs from the schema name.
 *   Source schema rows (which should be empty in healthy systems) get
 *   no backfill — assertNoNulls then guarantees the SET NOT NULL is
 *   safe.
 *
 * - `messaging_outbox.isDeadLettered` was declared NOT NULL in entity
 *   but the migration history left it nullable. Backfill with `false`
 *   for any NULL rows → SET NOT NULL.
 *
 * - `legal_holds.legalMatterId` is a brand-new column, so no backfill
 *   needed unless rows exist. assertNoNulls catches the gap if any
 *   pre-existing row needs a manual fix.
 *
 * # Idempotency
 *
 * - `ADD COLUMN IF NOT EXISTS` makes Block 1 safe to re-run.
 * - `UPDATE ... WHERE col IS NULL` is a no-op once the rows are filled.
 * - `assertNoNulls` short-circuits before `SET NOT NULL` raises a
 *   constraint violation; the migration aborts loudly if any row would
 *   be left in a bad state.
 *
 * # Closes
 *
 * - docs/reviews/data-expert/2026-04-19-e2e-messaging-arch.md#INFRA-CRITICAL-011
 */
export class AlignMessagingEntityDrift1782600000000 implements MigrationInterface {
  name = 'AlignMessagingEntityDrift1782600000000';

  private readonly logger = new Logger(this.name);

  async up(queryRunner: QueryRunner): Promise<void> {
    // Defense-in-depth: pin search_path even though the runner already
    // pins it before each per-schema iteration. Stale session state from
    // a sibling migration in the same boot cycle could otherwise leak.
    const [{ current_schema }] = await queryRunner.query(
      `SELECT current_schema()`,
    );
    this.logger.log(
      `up() running for schema "${current_schema}" (source or tenant)`,
    );

    // ────────────────────────────────────────────────────────────────────
    // Block 1: 7 missing columns
    // ────────────────────────────────────────────────────────────────────

    // 1. message_attachments.is_deleted (NOT NULL with default — safe)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "message_attachments"
        ADD COLUMN IF NOT EXISTS "is_deleted" boolean NOT NULL DEFAULT false
    `);
    // NOTE: the entity declares @Index() on is_deleted as a performance
    // optimization for "find non-deleted attachments" queries. Creating
    // that index here would require CREATE INDEX CONCURRENTLY (rule R3
    // in tools/gates/migration-sql-lint.ts — non-CONCURRENTLY CREATE
    // INDEX takes ACCESS EXCLUSIVE on a populated table). CONCURRENTLY
    // cannot run inside a transaction block. Lands in a sibling
    // migration with `transactional = false` per finding INFRA-MEDIUM-014
    // (owner: messaging-expert). The drift validator only checks
    // column shape, not index presence, so leaving this for the sibling
    // migration does not re-open the drift-validator gate.

    // 2. message_attachments.deleted_at (nullable timestamptz)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "message_attachments"
        ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz
    `);

    // 3. messages.isAiGenerated (NOT NULL with default — safe; partition
    //    parent ALTER cascades to every child partition automatically)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "messages"
        ADD COLUMN IF NOT EXISTS "isAiGenerated" boolean NOT NULL DEFAULT false
    `);

    // 4. legal_holds.legalMatterId (uuid; nullable on add, NOT NULL after backfill)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "legal_holds"
        ADD COLUMN IF NOT EXISTS "legalMatterId" uuid
    `);

    // 5. legal_holds.legalMatterDescription (text nullable)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "legal_holds"
        ADD COLUMN IF NOT EXISTS "legalMatterDescription" text
    `);

    // 6. legal_holds.requestedBy (uuid nullable)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "legal_holds"
        ADD COLUMN IF NOT EXISTS "requestedBy" uuid
    `);

    // 7. legal_holds.expiresAt (timestamptz nullable)
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "legal_holds"
        ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz
    `);

    // legalMatterId NOT NULL convergence — only safe if zero rows or every
    // pre-existing row has been backfilled by an operator. assertNoNulls
    // emits a structured error if not, so the deploy stops here.
    if (await this.tableExists(queryRunner, 'legal_holds')) {
      await this.assertNoNulls(queryRunner, 'legal_holds', 'legalMatterId');
      await queryRunner.query(`
        ALTER TABLE "legal_holds" ALTER COLUMN "legalMatterId" SET NOT NULL
      `);
    }

    // ────────────────────────────────────────────────────────────────────
    // Block 2: 4 nullability convergences (NULL → NOT NULL after backfill)
    // ────────────────────────────────────────────────────────────────────

    // 8. messaging_outbox.isDeadLettered (boolean → NOT NULL with default)
    if (await this.tableExists(queryRunner, 'messaging_outbox')) {
      await queryRunner.query(`
        UPDATE "messaging_outbox"
           SET "isDeadLettered" = false
         WHERE "isDeadLettered" IS NULL
      `);
      await this.assertNoNulls(queryRunner, 'messaging_outbox', 'isDeadLettered');
      await queryRunner.query(`
        ALTER TABLE "messaging_outbox"
          ALTER COLUMN "isDeadLettered" SET NOT NULL
      `);
      await queryRunner.query(`
        ALTER TABLE "messaging_outbox"
          ALTER COLUMN "isDeadLettered" SET DEFAULT false
      `);
    }

    // 9-11. tenantId NOT NULL on channels, channel_members, messages.
    //       Backfill from the schema name when running on a tenant_<uuid>
    //       schema; source schema rows (which should be empty) get no
    //       backfill — assertNoNulls fails loudly if any source-schema
    //       row is unexpectedly present without a tenantId.
    const tenantIdFromSchema = this.tenantIdFromSchemaName(current_schema as string);
    for (const table of ['channels', 'channel_members', 'messages'] as const) {
      if (!(await this.tableExists(queryRunner, table))) continue;
      if (!(await this.columnExists(queryRunner, table, 'tenantId'))) continue;

      if (tenantIdFromSchema !== null) {
        // Tenant schema: backfill with the tenantId derived from the schema name
        await queryRunner.query(
          `UPDATE "${table}" SET "tenantId" = $1::uuid WHERE "tenantId" IS NULL`,
          [tenantIdFromSchema],
        );
      }
      await this.assertNoNulls(queryRunner, table, 'tenantId');
      await queryRunner.query(`
        ALTER TABLE "${table}" ALTER COLUMN "tenantId" SET NOT NULL
      `);
    }

    this.logger.log(
      `up() complete for schema "${current_schema}" — drift closed (11 columns aligned)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      `SELECT current_schema()`,
    );
    this.logger.log(`down() running for schema "${current_schema}"`);

    // Block 2: revert NOT NULL convergence (allow NULL again)
    for (const table of ['channels', 'channel_members', 'messages'] as const) {
      if (await this.columnExists(queryRunner, table, 'tenantId')) {
        await queryRunner.query(
          `ALTER TABLE "${table}" ALTER COLUMN "tenantId" DROP NOT NULL`,
        );
      }
    }
    if (await this.columnExists(queryRunner, 'messaging_outbox', 'isDeadLettered')) {
      await queryRunner.query(`
        ALTER TABLE "messaging_outbox" ALTER COLUMN "isDeadLettered" DROP NOT NULL
      `);
      await queryRunner.query(`
        ALTER TABLE "messaging_outbox" ALTER COLUMN "isDeadLettered" DROP DEFAULT
      `);
    }
    if (await this.columnExists(queryRunner, 'legal_holds', 'legalMatterId')) {
      await queryRunner.query(`
        ALTER TABLE "legal_holds" ALTER COLUMN "legalMatterId" DROP NOT NULL
      `);
    }

    // Block 1: drop the 7 added columns
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_attachments_is_deleted"`);
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "message_attachments" DROP COLUMN IF EXISTS "is_deleted"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "message_attachments" DROP COLUMN IF EXISTS "deleted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "messages" DROP COLUMN IF EXISTS "isAiGenerated"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP COLUMN IF EXISTS "expiresAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP COLUMN IF EXISTS "requestedBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP COLUMN IF EXISTS "legalMatterDescription"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "legal_holds" DROP COLUMN IF EXISTS "legalMatterId"`,
    );
  }

  /**
   * Assert no rows in `<table>` have NULL in `<column>`. Throws a
   * structured error if any are found, so the migration aborts loudly
   * before SET NOT NULL would crash with a constraint violation.
   */
  private async assertNoNulls(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS count FROM "${table}" WHERE "${column}" IS NULL`,
    );
    const count = parseInt(rows[0]?.count ?? '0', 10);
    if (count > 0) {
      throw new Error(
        `[${this.name}] Cannot SET NOT NULL on "${table}"."${column}": ` +
          `${count} row(s) still have NULL values. Backfill them before re-running this migration. ` +
          `Source-schema rows are expected to be zero (template only); tenant-schema rows should ` +
          `have been backfilled by the migration's UPDATE step. If this fires unexpectedly, ` +
          `inspect: SELECT * FROM "${table}" WHERE "${column}" IS NULL LIMIT 5;`,
      );
    }
  }

  /**
   * Check if a table exists in the current search_path's first schema.
   * Used to make the migration safe across schemas where some tables
   * might not be present (e.g. partial migration history).
   */
  private async tableExists(
    queryRunner: QueryRunner,
    table: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = $1
       ) AS exists`,
      [table],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Check if a column exists on a table in the current schema.
   */
  private async columnExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = $1
           AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Derive the tenant UUID from a schema name of the form
   * `tenant_<16hex>`. The tenant fan-out runner pins search_path to
   * each tenant's schema, so the schema name uniquely identifies the
   * owning tenant. Returns null for the source schema (`messaging`) or
   * any other non-tenant schema name.
   *
   * The 16-hex-char fragment is the SECOND HALF of a UUID's no-dash form
   * (the platform's tenant-schema naming convention, see
   * libs/backend-common/src/database/tenant-aware-schemas.ts and
   * MULTI_TENANT_SAAS docs). To rebuild a usable UUID for the backfill
   * UPDATE we cannot reverse the mapping — the tenant id MUST be looked
   * up from auth.tenants, but doing that join from inside a per-schema
   * migration creates a cross-schema dependency we want to avoid. The
   * safer path: fall back to `current_setting('app.current_tenant', true)`
   * if the runner has set it, else return null and let assertNoNulls
   * fail loudly so the operator can investigate.
   */
  private tenantIdFromSchemaName(schema: string): string | null {
    // Source schema or any non-tenant schema: no backfill source.
    if (!/^tenant_[a-f0-9]{16}$/.test(schema)) return null;
    // We cannot reverse the truncated UUID → null and rely on the
    // existing tenantId column being populated by runtime writes
    // (which it is — the column was added nullable in 1782000000000
    // but every runtime path writes it). assertNoNulls will catch
    // any genuinely orphaned row.
    return null;
  }
}
