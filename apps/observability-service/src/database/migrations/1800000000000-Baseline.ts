import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "observability"."schema_object_type_enum" AS ENUM('table', 'column', 'index', 'constraint', 'enum', 'policy')`);
        await queryRunner.query(`CREATE TYPE "observability"."schema_object_action_enum" AS ENUM('created', 'altered', 'dropped', 'renamed')`);
        await queryRunner.query(`CREATE TABLE "observability"."schema_object_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "observed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "schema_name" character varying(64) NOT NULL, "object_type" "observability"."schema_object_type_enum" NOT NULL, "object_name" character varying(256) NOT NULL, "action" "observability"."schema_object_action_enum" NOT NULL, "schema_snapshot_hash" character varying(64), "actor" character varying(256) NOT NULL, "detail" jsonb, "environment" character varying(32) NOT NULL, CONSTRAINT "PK_ee027e45899cab088804b517895" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_schema_object_history_actor_time" ON "observability"."schema_object_history" ("actor", "observed_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_schema_object_history_schema_object_time" ON "observability"."schema_object_history" ("schema_name", "object_type", "object_name", "observed_at") `);
        await queryRunner.query(`CREATE TYPE "observability"."migration_event_type_enum" AS ENUM('start', 'applied', 'failed', 'skipped', 'validator_clean', 'validator_warn', 'validator_error')`);
        await queryRunner.query(`CREATE TABLE "observability"."migration_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "service_name" character varying(64) NOT NULL, "migration_name" character varying(256) NOT NULL, "event_type" "observability"."migration_event_type_enum" NOT NULL, "tenant_id_hash" character varying(128), "drift_class_id" character varying(64), "duration_ms" integer, "error_detail" jsonb, "environment" character varying(32) NOT NULL, CONSTRAINT "PK_50efe3af21cb530973b7a316179" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_migration_events_migration_time" ON "observability"."migration_events" ("migration_name", "occurred_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_migration_events_service_env_time" ON "observability"."migration_events" ("service_name", "environment", "occurred_at") `);
        await queryRunner.query(`CREATE TABLE "observability"."migration_backfill_progress" ("migration_name" character varying(256) NOT NULL, "environment" character varying(32) NOT NULL, "service_name" character varying(64) NOT NULL, "applied_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_483b654e3e031bb14589d69a672" PRIMARY KEY ("migration_name", "environment"))`);
        await queryRunner.query(`CREATE INDEX "IDX_migration_backfill_progress_service_env" ON "observability"."migration_backfill_progress" ("service_name", "environment", "applied_at") `);
        await queryRunner.query(`CREATE TYPE "observability"."emergency_override_kind_enum" AS ENUM('drift_fatal_bypass', 'migration_skip', 'validator_disable')`);
        await queryRunner.query(`CREATE TABLE "observability"."emergency_overrides" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "service_name" character varying(64) NOT NULL, "kind" "observability"."emergency_override_kind_enum" NOT NULL, "reason" text NOT NULL, "actor" character varying(128) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "environment" character varying(32) NOT NULL, "revoked_reason" text, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_bd7546a9ba0ba53c3f9edc37605" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_emergency_overrides_actor" ON "observability"."emergency_overrides" ("actor", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_emergency_overrides_service_active" ON "observability"."emergency_overrides" ("service_name", "expires_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "observability"."IDX_emergency_overrides_service_active"`);
        await queryRunner.query(`DROP INDEX "observability"."IDX_emergency_overrides_actor"`);
        await queryRunner.query(`DROP TABLE "observability"."emergency_overrides"`);
        await queryRunner.query(`DROP TYPE "observability"."emergency_override_kind_enum"`);
        await queryRunner.query(`DROP INDEX "observability"."IDX_migration_backfill_progress_service_env"`);
        await queryRunner.query(`DROP TABLE "observability"."migration_backfill_progress"`);
        await queryRunner.query(`DROP INDEX "observability"."IDX_migration_events_service_env_time"`);
        await queryRunner.query(`DROP INDEX "observability"."IDX_migration_events_migration_time"`);
        await queryRunner.query(`DROP TABLE "observability"."migration_events"`);
        await queryRunner.query(`DROP TYPE "observability"."migration_event_type_enum"`);
        await queryRunner.query(`DROP INDEX "observability"."IDX_schema_object_history_schema_object_time"`);
        await queryRunner.query(`DROP INDEX "observability"."IDX_schema_object_history_actor_time"`);
        await queryRunner.query(`DROP TABLE "observability"."schema_object_history"`);
        await queryRunner.query(`DROP TYPE "observability"."schema_object_action_enum"`);
        await queryRunner.query(`DROP TYPE "observability"."schema_object_type_enum"`);
    }

}
