import { MigrationInterface, QueryRunner } from 'typeorm';

type PgColumnRow = { column_name: string };
type PgSchemaRow = { schema_name: string };

/**
 * AlignCodeSequencesSchema1786900000000
 * ============================================================================
 *
 * 2026-04-29 root fix: `CodeGeneratorService` now relies on one atomic
 * tenant-local UPSERT against `"tenantId"`, `"entityType"`, `"year"` and
 * `"lastSequence"`. Older bootstrap SQL created `code_sequences` with
 * snake_case columns, while the TypeORM entity uses camelCase. A runtime
 * service must not guess around that drift; the database schema itself is
 * converted to the canonical entity shape in every farm-owned schema.
 *
 * Why this is migration-level, not handler-level:
 * - first-use sequence creation must be atomic under concurrency;
 * - existing tenants must be repaired before traffic reaches handlers;
 * - source `farm` and every `tenant_*` clone must have the same DDL.
 */
export class AlignCodeSequencesSchema1786900000000
  implements MigrationInterface
{
  name = 'AlignCodeSequencesSchema1786900000000';
  /**
   * 2026-05-02: This migration creates and drops indexes on pre-existing
   * tenant-local `code_sequences` tables with CONCURRENTLY.
   * WHY: the atomic code generator requires a unique tenant/entity/year index,
   * but live tenant schemas must not take ACCESS EXCLUSIVE writer stalls.
   */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureFarmTableExists(queryRunner);

    const schemas = await this.listFarmOwnedSchemas(queryRunner);
    for (const schema of schemas) {
      this.assertSafeSchema(schema);
      await this.ensureTenantTableExists(queryRunner, schema);
      await this.alignSchema(queryRunner, schema);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schemas = await this.listFarmOwnedSchemas(queryRunner);
    for (const schema of schemas) {
      this.assertSafeSchema(schema);
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."IDX_code_sequences_tenant_entity"`);
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."UQ_code_sequences_tenant_entity_year"`);
    }
  }

  private async ensureFarmTableExists(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "farm"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "farm"."code_sequences" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "entityType" varchar(50) NOT NULL,
        "prefix" varchar(10) NOT NULL,
        "year" integer NOT NULL,
        "lastSequence" integer NOT NULL DEFAULT 0,
        "lastGeneratedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  private async ensureTenantTableExists(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<void> {
    if (schema === 'farm') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."code_sequences"
      (LIKE "farm"."code_sequences" INCLUDING ALL)
    `);
  }

  private async alignSchema(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<void> {
    this.assertSafeSchema(schema);
    const columns = await this.getColumns(queryRunner, schema);

    await this.renameIfNeeded(queryRunner, schema, columns, 'tenant_id', 'tenantId');
    await this.renameIfNeeded(queryRunner, schema, columns, 'entity_type', 'entityType');
    await this.renameIfNeeded(queryRunner, schema, columns, 'last_sequence', 'lastSequence');
    await this.renameIfNeeded(queryRunner, schema, columns, 'last_generated_at', 'lastGeneratedAt');
    await this.renameIfNeeded(queryRunner, schema, columns, 'created_at', 'createdAt');
    await this.renameIfNeeded(queryRunner, schema, columns, 'updated_at', 'updatedAt');

    await queryRunner.query(`
      ALTER TABLE "${schema}"."code_sequences"
        ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT uuid_generate_v4(),
        ADD COLUMN IF NOT EXISTS "tenantId" uuid,
        ADD COLUMN IF NOT EXISTS "entityType" varchar(50),
        ADD COLUMN IF NOT EXISTS "prefix" varchar(10),
        ADD COLUMN IF NOT EXISTS "year" integer,
        ADD COLUMN IF NOT EXISTS "lastSequence" integer DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "lastGeneratedAt" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "createdAt" timestamptz DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz DEFAULT now()
    `);

    await queryRunner.query(`
      UPDATE "${schema}"."code_sequences"
      SET
        "lastSequence" = COALESCE("lastSequence", 0),
        "createdAt" = COALESCE("createdAt", now()),
        "updatedAt" = COALESCE("updatedAt", now())
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."code_sequences"
        ALTER COLUMN "lastGeneratedAt" TYPE timestamptz USING "lastGeneratedAt"::timestamptz,
        ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt"::timestamptz,
        ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt"::timestamptz
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."code_sequences"
        ALTER COLUMN "id" SET DEFAULT uuid_generate_v4(),
        ALTER COLUMN "tenantId" SET NOT NULL,
        ALTER COLUMN "entityType" SET NOT NULL,
        ALTER COLUMN "prefix" SET NOT NULL,
        ALTER COLUMN "year" SET NOT NULL,
        ALTER COLUMN "lastSequence" SET DEFAULT 0,
        ALTER COLUMN "lastSequence" SET NOT NULL,
        ALTER COLUMN "createdAt" SET DEFAULT now(),
        ALTER COLUMN "createdAt" SET NOT NULL,
        ALTER COLUMN "updatedAt" SET DEFAULT now(),
        ALTER COLUMN "updatedAt" SET NOT NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = '${schema}'
            AND t.relname = 'code_sequences'
            AND c.contype = 'p'
        ) THEN
          ALTER TABLE "${schema}"."code_sequences"
          ADD CONSTRAINT "PK_code_sequences_id" PRIMARY KEY ("id");
        END IF;
      END $$;
    `);

    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."idx_code_sequences_tenant_entity"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."idx_code_sequences_unique"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."IDX_code_sequences_tenantId"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_code_sequences_tenant_entity_year"
      ON "${schema}"."code_sequences" ("tenantId", "entityType", "year")
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_code_sequences_tenant_entity"
      ON "${schema}"."code_sequences" ("tenantId", "entityType")
    `);
  }

  private async renameIfNeeded(
    queryRunner: QueryRunner,
    schema: string,
    columns: Set<string>,
    from: string,
    to: string,
  ): Promise<void> {
    if (!columns.has(from) || columns.has(to)) return;

    await queryRunner.query(`
      ALTER TABLE "${schema}"."code_sequences"
      RENAME COLUMN "${from}" TO "${to}"
    `);
    columns.delete(from);
    columns.add(to);
  }

  private async getColumns(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<Set<string>> {
    const rows: PgColumnRow[] = await queryRunner.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'code_sequences'
      `,
      [schema],
    );
    return new Set(rows.map((row) => row.column_name));
  }

  private async listFarmOwnedSchemas(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows: PgSchemaRow[] = await queryRunner.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = 'farm'
         OR schema_name ~ '^tenant_[a-f0-9]{16}$'
      ORDER BY CASE WHEN schema_name = 'farm' THEN 0 ELSE 1 END, schema_name
    `);
    return rows.map((row) => row.schema_name);
  }

  private assertSafeSchema(schema: string): void {
    if (schema === 'farm' || /^tenant_[a-f0-9]{16}$/.test(schema)) return;
    throw new Error(`Unsafe schema name for code_sequences alignment: ${schema}`);
  }
}
