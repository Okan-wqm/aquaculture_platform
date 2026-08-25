import { MigrationInterface, QueryRunner } from 'typeorm';

export class TelemetryCapacityEntitlementProjection1801900000001 implements MigrationInterface {
  name = 'TelemetryCapacityEntitlementProjection1801900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "billing"."telemetry_capacity_entitlements" (
                "entitlement_id" uuid NOT NULL,
                "operation_id" uuid NOT NULL,
                "reservation_id" uuid NOT NULL,
                "tenant_id" uuid NOT NULL,
                "entitlement_version" integer NOT NULL,
                "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "capacity_envelope_version" integer NOT NULL,
                "sustained_ingress_messages_per_second" double precision NOT NULL,
                "sustained_metric_rows_per_minute" double precision NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_f5b3a557307038c4566ff22bee9" PRIMARY KEY ("entitlement_id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_telemetry_capacity_tenant_version" ON "billing"."telemetry_capacity_entitlements" ("tenant_id", "entitlement_version")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_telemetry_capacity_operation" ON "billing"."telemetry_capacity_entitlements" ("operation_id")
        `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Telemetry capacity billing snapshots are forward-only; dropping them would destroy approved entitlement history',
    );
  }
}
