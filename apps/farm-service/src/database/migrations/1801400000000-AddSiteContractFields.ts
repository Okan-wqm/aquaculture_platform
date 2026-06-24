import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the missing runtime fields behind the GraphQL Site contract.
 *
 * The migration is intentionally current_schema-relative. db-migrate fans farm
 * migrations out with search_path pinned to `farm` and each `tenant_<uuid>`
 * schema, so unqualified `sites` is the only correct target.
 */
export class AddSiteContractFields1801400000000 implements MigrationInterface {
  name = 'AddSiteContractFields1801400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "sites"
        ADD COLUMN IF NOT EXISTS "region" character varying(100),
        ADD COLUMN IF NOT EXISTS "siteManager" character varying(255)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sites_region"
        ON "sites" ("region")
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        constraint_name text;
      BEGIN
        SELECT tc.constraint_name
          INTO constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_schema = tc.constraint_schema
           AND kcu.constraint_name = tc.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_schema = tc.constraint_schema
           AND ccu.constraint_name = tc.constraint_name
         WHERE tc.constraint_schema = current_schema()
           AND tc.table_name = 'departments'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND kcu.column_name = 'siteId'
           AND ccu.table_name = 'sites'
           AND ccu.column_name = 'id'
         LIMIT 1;

        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE "departments" DROP CONSTRAINT %I', constraint_name);
        END IF;

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'FK_departments_siteId_sites_id'
             AND conrelid = format('%I.%I', current_schema(), 'departments')::regclass
        ) THEN
          ALTER TABLE "departments"
            ADD CONSTRAINT "FK_departments_siteId_sites_id"
            FOREIGN KEY ("siteId") REFERENCES "sites"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP INDEX IF EXISTS "IDX_sites_region"');
    await queryRunner.query(`
      ALTER TABLE "departments" DROP CONSTRAINT IF EXISTS "FK_departments_siteId_sites_id"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'FK_cabc0ac7aa33c078cc7d0c92293'
             AND conrelid = format('%I.%I', current_schema(), 'departments')::regclass
        ) THEN
          ALTER TABLE "departments"
            ADD CONSTRAINT "FK_cabc0ac7aa33c078cc7d0c92293"
            FOREIGN KEY ("siteId") REFERENCES "sites"("id")
            ON DELETE RESTRICT ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "sites"
        DROP COLUMN IF EXISTS "siteManager",
        DROP COLUMN IF EXISTS "region"
    `);
  }
}
