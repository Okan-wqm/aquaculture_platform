import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  applyTenantRlsToSchema,
  removeTenantRlsFromSchema,
} from '@aquaculture/backend-common/database';

/**
 * AddTrainingSessions — creates the per-tenant `training_sessions` source table.
 *
 * Shape mirrors the TypeORM-generated DDL the CLI emits from
 * apps/hr-service/src/training/entities/training-session.entity.ts (the worktree
 * has no DB to run `migration:generate` against; the deterministic generated form
 * is reproduced here, identical to the sibling training_* tables in Baseline).
 *
 * Blue-green safe: a brand-new table starts empty, so the NOT NULL columns and
 * the in-chunk `CREATE INDEX` (initial-schema exemption — table created in the
 * same migration) carry no live-table lock/backfill hazard. The table is cloned
 * into each `tenant_<uuid>` schema by SchemaManager because it is declared in
 * MODULE_SCHEMAS['hr'].tables; RLS is (re)applied across the hr schema so the
 * canonical tenant predicate covers the new table.
 */
export class AddTrainingSessions1801500000000 implements MigrationInterface {
  name = 'AddTrainingSessions1801500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "hr"."training_sessions_status_enum" AS ENUM('scheduled', 'in_progress', 'completed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    // IF NOT EXISTS keeps the CREATE replay-safe on a partial-state DB (R6).
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "hr"."training_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "trainingCourseId" uuid NOT NULL, "sessionDate" date NOT NULL, "startTime" TIME NOT NULL, "endTime" TIME NOT NULL, "location" character varying(200), "instructor" character varying(200), "maxParticipants" integer, "status" "hr"."training_sessions_status_enum" NOT NULL DEFAULT 'scheduled', "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "createdBy" character varying, "updatedBy" character varying, "version" integer NOT NULL, "isDeleted" boolean NOT NULL DEFAULT false, "deletedAt" TIMESTAMP, "deletedBy" character varying, CONSTRAINT "PK_8f3c9b21d4e6a7c5b0f2d1e3a4b" PRIMARY KEY ("id"))`,
    );
    // Initial-schema CREATE INDEX: the table is created in this same chunk and is
    // empty, so the ACCESS EXCLUSIVE lock is free; IF NOT EXISTS keeps replay clean.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ts_tenant" ON "hr"."training_sessions" ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ts_tenant_session_date" ON "hr"."training_sessions" ("tenantId", "sessionDate") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ts_tenant_course" ON "hr"."training_sessions" ("tenantId", "trainingCourseId") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ts_tenant_status" ON "hr"."training_sessions" ("tenantId", "status") `,
    );
    // ADD CONSTRAINT has no IF NOT EXISTS form — guard with a duplicate_object
    // catch so a partial-replay does not crash with 42710 (R11).
    await queryRunner.query(
      `DO $$ BEGIN ALTER TABLE "hr"."training_sessions" ADD CONSTRAINT "FK_ts_training_course" FOREIGN KEY ("trainingCourseId") REFERENCES "hr"."training_courses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    // Re-apply the canonical tenant RLS predicate so it now covers training_sessions.
    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      excludeTables: [],
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove RLS first to avoid policy-on-missing-table errors during teardown.
    await removeTenantRlsFromSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      excludeTables: [],
    });
    await queryRunner.query(
      `ALTER TABLE "hr"."training_sessions" DROP CONSTRAINT IF EXISTS "FK_ts_training_course"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."IDX_ts_tenant_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."IDX_ts_tenant_course"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."IDX_ts_tenant_session_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."IDX_ts_tenant"`);
    // DESTRUCTIVE: down()-only rollback of AddTrainingSessions1801500000000 — drops
    // the training_sessions table this same migration created (no production data
    // depends on it pre-merge; it is the migration's own inverse).
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."training_sessions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "hr"."training_sessions_status_enum"`);

    // Restore RLS over the remaining tables (mirrors the up()'s re-apply).
    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      excludeTables: [],
    });
  }
}
