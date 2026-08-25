import { MigrationInterface, QueryRunner } from 'typeorm';

export class TelemetryCapacityAdmission1808200000001 implements MigrationInterface {
  name = 'TelemetryCapacityAdmission1808200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "admin"."telemetry_capacity_envelopes" (
                "id" uuid NOT NULL,
                "version" integer NOT NULL,
                "state" character varying(16) NOT NULL,
                "sustained_ingress_messages_per_second" double precision NOT NULL,
                "sustained_metric_rows_per_minute" double precision NOT NULL,
                "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "created_by" character varying(255) NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_cdfa02b5f51bd20aa88a4b117fc" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_telemetry_capacity_envelopes_state_effective" ON "admin"."telemetry_capacity_envelopes" ("state", "effective_at")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_telemetry_capacity_envelopes_version" ON "admin"."telemetry_capacity_envelopes" ("version")
        `);
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "admin"."telemetry_capacity_entitlements" (
                "entitlement_id" uuid NOT NULL,
                "reservation_id" uuid NOT NULL,
                "operation_id" uuid NOT NULL,
                "tenant_id" uuid NOT NULL,
                "entitlement_version" integer NOT NULL,
                "capacity_envelope_id" uuid NOT NULL,
                "capacity_envelope_version" integer NOT NULL,
                "sustained_ingress_messages_per_second" double precision NOT NULL,
                "sustained_metric_rows_per_minute" double precision NOT NULL,
                "reserved_ingress_delta" double precision NOT NULL,
                "reserved_metric_rows_delta" double precision NOT NULL,
                "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "retention_approval_state" character varying(16) NOT NULL DEFAULT 'UNAPPROVED',
                "archive_tier" character varying(64),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_f5b3a557307038c4566ff22bee9" PRIMARY KEY ("entitlement_id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_telemetry_capacity_entitlements_tenant_version" ON "admin"."telemetry_capacity_entitlements" ("tenant_id", "entitlement_version")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_telemetry_capacity_entitlements_reservation" ON "admin"."telemetry_capacity_entitlements" ("reservation_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_telemetry_capacity_entitlements_operation" ON "admin"."telemetry_capacity_entitlements" ("operation_id")
        `);
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "admin"."telemetry_capacity_activation_events" (
                "id" uuid NOT NULL,
                "entitlement_id" uuid NOT NULL,
                "activation_state" character varying(32) NOT NULL,
                "capacity_envelope_version" integer NOT NULL,
                "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_89a9e80e97cf966b784a52826bb" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_telemetry_capacity_activation_entitlement_created" ON "admin"."telemetry_capacity_activation_events" ("entitlement_id", "created_at")
        `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Telemetry capacity admission is forward-only; dropping its ledger would destroy entitlement history',
    );
  }
}
