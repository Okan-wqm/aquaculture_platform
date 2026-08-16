import {
  CONFIGURATION_CATALOG_DIGEST,
  CONFIGURATION_DEFINITIONS,
  ConfigurationKeyId,
} from '@aquaculture/configuration-contracts';
import { RLS_TENANT_GUC } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { SYSTEM_TENANT_ID } from '../../configuration/configuration.constants';
import { CONFIGURATION_SEED_ROWS } from '../generated/configuration-seed.generated';

const SEED_ACTOR = 'seed:configuration-catalog-v1';

/**
 * Establishes catalog IDs as the only persisted configuration vocabulary and
 * adds the durable scope/CAS/idempotency journals used by the batch authority.
 * This migration is intentionally forward-only: restoring arbitrary-key APIs
 * would reintroduce a second semantic authority.
 */
export class EstablishConfigurationCatalogAuthority1807600000000 implements MigrationInterface {
  name = 'EstablishConfigurationCatalogAuthority1807600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    await queryRunner.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
    await queryRunner.query(`
      LOCK TABLE
        "config"."configurations",
        "config"."configuration_history"
      IN ACCESS EXCLUSIVE MODE
    `);

    await queryRunner.query(`
      CREATE TABLE "config"."configuration_catalog_revisions" (
        "digest" char(64) PRIMARY KEY,
        "schema_version" integer NOT NULL CHECK ("schema_version" = 1),
        "activated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "config"."configuration_definitions" (
        "catalog_id" varchar(64) PRIMARY KEY,
        "catalog_digest" char(64) NOT NULL REFERENCES "config"."configuration_catalog_revisions"("digest")
      )
    `);
    await queryRunner.query(
      `INSERT INTO "config"."configuration_catalog_revisions" ("digest", "schema_version") VALUES ($1, 1)`,
      [CONFIGURATION_CATALOG_DIGEST],
    );
    for (const definition of CONFIGURATION_DEFINITIONS) {
      await queryRunner.query(
        `INSERT INTO "config"."configuration_definitions" ("catalog_id", "catalog_digest") VALUES ($1, $2)`,
        [definition.id, CONFIGURATION_CATALOG_DIGEST],
      );
    }

    await queryRunner.query(`
      ALTER TABLE "config"."configurations"
        ADD COLUMN "catalog_id" varchar(64),
        ADD CONSTRAINT "FK_configurations_catalog_id"
          FOREIGN KEY ("catalog_id") REFERENCES "config"."configuration_definitions"("catalog_id")
    `);
    for (const definition of CONFIGURATION_DEFINITIONS) {
      await queryRunner.query(
        `UPDATE "config"."configurations" SET "catalog_id" = $1 WHERE "service" = $2 AND "key" = $3`,
        [definition.id, definition.service, definition.key],
      );
    }
    await queryRunner.query(`
      DO $$
      DECLARE unknown_coordinates text;
      BEGIN
        SELECT string_agg(DISTINCT "service" || '/' || "key", ', ' ORDER BY "service" || '/' || "key")
          INTO unknown_coordinates
          FROM "config"."configurations"
         WHERE "catalog_id" IS NULL;
        IF unknown_coordinates IS NOT NULL THEN
          RAISE EXCEPTION
            'configuration catalog cutover refused unknown coordinates: %',
            unknown_coordinates;
        END IF;
      END
      $$
    `);

    // Seed only catalog-owned defaults. Existing operator values win.
    await queryRunner.query(`SELECT set_config($1, $2, true)`, [RLS_TENANT_GUC, SYSTEM_TENANT_ID]);
    for (const row of CONFIGURATION_SEED_ROWS) {
      await queryRunner.query(
        `INSERT INTO "config"."configurations" (
          "tenant_id", "service", "key", "catalog_id", "value", "value_type", "environment",
          "description", "is_secret", "is_active", "category", "created_by", "updated_by", "version"
        ) VALUES (
          $1, $2, $3, $4, $5, $6::"config"."configurations_value_type_enum",
          'all'::"config"."configurations_environment_enum", $7, false, true, $8, $9, $9, 1
        )
        ON CONFLICT ("tenant_id", "service", "key", "environment")
        DO UPDATE SET "catalog_id" = EXCLUDED."catalog_id"`,
        [
          SYSTEM_TENANT_ID,
          row.service,
          row.key,
          row.catalogId,
          row.value,
          row.valueType,
          row.description,
          row.category,
          SEED_ACTOR,
        ],
      );
    }

    await queryRunner.query(`
      ALTER TABLE "config"."configuration_history"
        ADD COLUMN "catalog_id" varchar(64),
        ADD COLUMN "operation_id" uuid
    `);
    await queryRunner.query(`
      UPDATE "config"."configuration_history" AS history
         SET "catalog_id" = configuration."catalog_id",
             "operation_id" = uuid_generate_v4()
        FROM "config"."configurations" AS configuration
       WHERE configuration."id" = history."configuration_id"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "config"."configuration_history"
           WHERE "catalog_id" IS NULL OR "operation_id" IS NULL
        ) THEN
          RAISE EXCEPTION 'configuration catalog cutover refused orphan history rows';
        END IF;
      END
      $$
    `);

    // Historical empty placeholders represented invented values. Catalog keys
    // without defaults now use MISSING_REQUIRED or OPTIONAL_ABSENT snapshot state.
    // History was attributed above before the placeholder rows are removed.
    const settingsWithoutDefaults = CONFIGURATION_DEFINITIONS.filter(
      (definition) => !Object.prototype.hasOwnProperty.call(definition, 'default'),
    ).map((definition) => definition.id);
    await queryRunner.query(
      `DELETE FROM "config"."configurations" WHERE "catalog_id" = ANY($1::varchar[]) AND "value" = ''`,
      [settingsWithoutDefaults],
    );

    await queryRunner.query(`
      DO $$
      DECLARE constraint_name text;
      BEGIN
        FOR constraint_name IN
          SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = 'config'
             AND rel.relname = 'configurations'
             AND con.contype = 'u'
        LOOP
          EXECUTE format('ALTER TABLE config.configurations DROP CONSTRAINT %I', constraint_name);
        END LOOP;
      END
      $$
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "config"."IDX_6815959c70427c326a013ae02b"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "config"."IDX_9aa7726d3b5716e81dd5227ed8"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "config"."IDX_a1cc7151ac8c21b680dfdf0d67"`);
    await queryRunner.query(`
      ALTER TABLE "config"."configurations"
        ALTER COLUMN "catalog_id" SET NOT NULL,
        DROP COLUMN "service",
        DROP COLUMN "key",
        DROP COLUMN "value_type",
        DROP COLUMN "description",
        DROP COLUMN "is_secret",
        DROP COLUMN "default_value",
        DROP COLUMN "validation_rules",
        DROP COLUMN "category",
        DROP COLUMN "tags",
        ADD CONSTRAINT "UQ_configurations_scope_catalog_environment"
          UNIQUE ("tenant_id", "catalog_id", "environment")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_configurations_tenant_environment"
        ON "config"."configurations" ("tenant_id", "environment")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_configurations_catalog_id"
        ON "config"."configurations" ("catalog_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "config"."configuration_history"
        ALTER COLUMN "catalog_id" SET NOT NULL,
        ALTER COLUMN "operation_id" SET NOT NULL,
        DROP COLUMN "service",
        DROP COLUMN "key",
        ADD CONSTRAINT "FK_configuration_history_catalog_id"
          FOREIGN KEY ("catalog_id") REFERENCES "config"."configuration_definitions"("catalog_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "config"."configuration_scopes" (
        "tenant_id" uuid NOT NULL,
        "environment" "config"."configurations_environment_enum" NOT NULL,
        "revision" bigint NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_configuration_scopes" PRIMARY KEY ("tenant_id", "environment")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "config"."configuration_scopes" ("tenant_id", "environment")
      SELECT DISTINCT "tenant_id", "environment" FROM "config"."configurations"
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(
      `INSERT INTO "config"."configuration_scopes" ("tenant_id", "environment") VALUES ($1, 'all') ON CONFLICT DO NOTHING`,
      [SYSTEM_TENANT_ID],
    );

    await queryRunner.query(`
      CREATE TABLE "config"."configuration_operation_receipts" (
        "operation_id" uuid PRIMARY KEY,
        "tenant_id" uuid NOT NULL,
        "environment" "config"."configurations_environment_enum" NOT NULL,
        "request_digest" char(64) NOT NULL CHECK ("request_digest" ~ '^[0-9a-f]{64}$'),
        "catalog_digest" char(64) NOT NULL REFERENCES "config"."configuration_catalog_revisions"("digest"),
        "previous_snapshot_token" char(64) NOT NULL CHECK ("previous_snapshot_token" ~ '^[0-9a-f]{64}$'),
        "resulting_snapshot_token" char(64) NOT NULL CHECK ("resulting_snapshot_token" ~ '^[0-9a-f]{64}$'),
        "resulting_scope_revision" bigint NOT NULL CHECK ("resulting_scope_revision" >= 0),
        "actor_id" varchar(100) NOT NULL,
        "reason" varchar(255) NOT NULL,
        "receipt_payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_configuration_receipts_tenant_created"
        ON "config"."configuration_operation_receipts" ("tenant_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE TABLE "config"."configuration_change_journal" (
        "sequence" bigserial PRIMARY KEY,
        "operation_id" uuid NOT NULL REFERENCES "config"."configuration_operation_receipts"("operation_id") DEFERRABLE INITIALLY DEFERRED,
        "tenant_id" uuid NOT NULL,
        "catalog_id" varchar(64) NOT NULL REFERENCES "config"."configuration_definitions"("catalog_id"),
        "intent" varchar(32) NOT NULL CHECK ("intent" IN ('SET', 'CLEAR_OVERRIDE', 'SUPPRESS_FALLBACK')),
        "previous_state" varchar(32) NOT NULL,
        "new_state" varchar(32) NOT NULL,
        "previous_value_digest" char(64),
        "new_value_digest" char(64),
        "previous_version" integer,
        "new_version" integer,
        "actor_id" varchar(100) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_configuration_journal_operation_sequence"
        ON "config"."configuration_change_journal" ("operation_id", "sequence")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_configuration_journal_tenant_catalog_sequence"
        ON "config"."configuration_change_journal" ("tenant_id", "catalog_id", "sequence")
    `);

    for (const table of [
      'configuration_scopes',
      'configuration_operation_receipts',
      'configuration_change_journal',
    ]) {
      await queryRunner.query(`ALTER TABLE "config"."${table}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "config"."${table}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY "tenant_isolation_${table}" ON "config"."${table}"
        USING (
          current_setting('app.bypass_rls', true) = 'on'
          OR "tenant_id" = NULLIF(current_setting('${RLS_TENANT_GUC}', true), '')::uuid
        )
        WITH CHECK (
          current_setting('app.bypass_rls', true) = 'on'
          OR "tenant_id" = NULLIF(current_setting('${RLS_TENANT_GUC}', true), '')::uuid
        )
      `);
    }

    await queryRunner.query(`
      DO $$
      DECLARE table_name text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'config_service') THEN
          RAISE EXCEPTION 'config_service role missing during catalog authority cutover';
        END IF;
        FOREACH table_name IN ARRAY ARRAY[
          'configuration_catalog_revisions',
          'configuration_definitions',
          'configuration_scopes',
          'configuration_operation_receipts',
          'configuration_change_journal'
        ]
        LOOP
          EXECUTE format('ALTER TABLE config.%I OWNER TO config_service', table_name);
        END LOOP;
        GRANT SELECT ON "config"."configuration_catalog_revisions" TO config_service;
        GRANT SELECT ON "config"."configuration_definitions" TO config_service;
        GRANT SELECT, INSERT, UPDATE, DELETE ON "config"."configuration_scopes" TO config_service;
        GRANT SELECT, INSERT ON "config"."configuration_operation_receipts" TO config_service;
        GRANT SELECT, INSERT ON "config"."configuration_change_journal" TO config_service;
        GRANT USAGE, SELECT ON SEQUENCE "config"."configuration_change_journal_sequence_seq" TO config_service;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF (SELECT count(*) FROM "config"."configuration_definitions") <> ${CONFIGURATION_DEFINITIONS.length}
           OR EXISTS (
             SELECT 1 FROM "config"."configuration_definitions"
              WHERE "catalog_digest" <> '${CONFIGURATION_CATALOG_DIGEST}'
           )
           OR EXISTS (SELECT 1 FROM "config"."configurations" WHERE "catalog_id" IS NULL)
        THEN
          RAISE EXCEPTION 'configuration catalog authority postcondition failed';
        END IF;
      END
      $$
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    throw new Error(
      'configuration catalog authority is forward-only; arbitrary key/value configuration cannot be restored',
    );
  }
}

export const CONFIGURATION_CATALOG_IDS_IN_MIGRATION: readonly ConfigurationKeyId[] =
  CONFIGURATION_DEFINITIONS.map((definition) => definition.id);
