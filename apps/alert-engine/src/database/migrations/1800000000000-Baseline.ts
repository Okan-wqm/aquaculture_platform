import { MigrationInterface, QueryRunner } from "typeorm";

import { applyTenantRlsToSchema, removeTenantRlsFromSchema } from '@aquaculture/backend-common/database'; // Faz 3.5 RLS additions: import block
export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "alert"."alert_rules_severity_enum" AS ENUM('info', 'low', 'warning', 'medium', 'high', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "alert_rules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "description" character varying, "tenant_id" uuid NOT NULL, "farm_id" character varying, "pond_id" character varying, "sensor_id" character varying, "conditions" jsonb NOT NULL, "severity" "alert"."alert_rules_severity_enum" DEFAULT 'medium', "is_active" boolean NOT NULL DEFAULT true, "notification_channels" jsonb, "recipients" jsonb, "cooldown_minutes" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, CONSTRAINT "PK_ae580564f087ffab9d229225aec" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_19f0d3eba80c0d5f64c446dd80" ON "alert_rules" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b0859675aee23a2cbe0c703ef1" ON "alert_rules" ("farm_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3028424bd73602cd4356a78b16" ON "alert_rules" ("pond_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e2f98912faa323e01fe7201511" ON "alert_rules" ("sensor_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_76bd886fe88f73e6efeed5b185" ON "alert_rules" ("name", "tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_db6012f863dcdb59c273f028aa" ON "alert_rules" ("tenant_id", "is_active") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "escalation_policies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "name" character varying NOT NULL, "description" text, "severity" jsonb NOT NULL, "levels" jsonb NOT NULL, "on_call_schedule" jsonb, "suppression_windows" jsonb, "repeat_interval_minutes" integer NOT NULL DEFAULT '5', "max_repeats" integer NOT NULL DEFAULT '3', "is_active" boolean NOT NULL DEFAULT true, "is_default" boolean NOT NULL DEFAULT false, "priority" integer NOT NULL DEFAULT '0', "conditions" jsonb, "timezone" character varying, "rule_ids" jsonb, "farm_ids" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying, CONSTRAINT "PK_aea3f30839009e0efd350e4cbc7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_783aaff150ad01be736b8394dc" ON "escalation_policies" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a893e79c1f6c20afe255340dcd" ON "escalation_policies" ("severity") `);
        await queryRunner.query(`CREATE INDEX "IDX_cf1716ac2439167338b35549ce" ON "escalation_policies" ("tenant_id", "is_active") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "alert"."alert_incidents_severity_enum" AS ENUM('info', 'low', 'warning', 'medium', 'high', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "alert"."alert_incidents_status_enum" AS ENUM('NEW', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED', 'SUPPRESSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "alert_incidents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "rule_id" uuid NOT NULL, "title" character varying NOT NULL, "description" text, "severity" "alert"."alert_incidents_severity_enum" NOT NULL DEFAULT 'warning', "status" "alert"."alert_incidents_status_enum" NOT NULL DEFAULT 'NEW', "risk_score" integer NOT NULL DEFAULT '0', "trigger_data" jsonb NOT NULL, "farm_id" character varying, "pond_id" character varying, "sensor_id" character varying, "assigned_to" character varying, "acknowledged_by" character varying, "acknowledged_at" TIMESTAMP, "resolved_by" character varying, "resolved_at" TIMESTAMP, "resolution_notes" text, "escalation_level" integer NOT NULL DEFAULT '0', "last_escalated_at" TIMESTAMP, "timeline" jsonb NOT NULL DEFAULT '[]', "related_incident_ids" jsonb NOT NULL DEFAULT '[]', "parent_incident_id" character varying, "occurrence_count" integer NOT NULL DEFAULT '1', "last_occurred_at" TIMESTAMP, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_42d57ff33601326cfdcf0cba9b1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4dc9bc60472ac57d76ffe3021a" ON "alert_incidents" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_08af29c9206523c12da4497e8d" ON "alert_incidents" ("rule_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3755a41cd91f41cb028913edbb" ON "alert_incidents" ("assigned_to") `);
        await queryRunner.query(`CREATE INDEX "IDX_253ca859cb76fea6029d8c872a" ON "alert_incidents" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_f8db963be83d4dfc1d554e3b99" ON "alert_incidents" ("severity") `);
        await queryRunner.query(`CREATE INDEX "IDX_9d68d4a70ea580f2637ba63492" ON "alert_incidents" ("tenant_id", "status") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "alert"."alert_audit_log" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid, "category" character varying NOT NULL, "event_type" character varying NOT NULL, "severity" character varying NOT NULL, "action" character varying NOT NULL, "description" text NOT NULL, "entity_type" character varying, "entity_id" character varying, "user_id" character varying, "user_name" character varying, "ip_address" character varying, "user_agent" character varying, "previous_state" jsonb, "new_state" jsonb, "changes" jsonb, "metadata" jsonb, "correlation_id" character varying, "parent_audit_id" character varying, "tags" jsonb, "duration" integer, "success" boolean NOT NULL, "error_message" text, "timestamp" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b94a9deeb56ea8107855eea2506" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b3dd833c7aad4a304fc003bb92" ON "alert"."alert_audit_log" ("correlation_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ec936baf2f2070b57c1a01163" ON "alert"."alert_audit_log" ("entity_type", "entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_12a48bc2013d674b4362827d91" ON "alert"."alert_audit_log" ("event_type", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_0935a1474b7e5fbc3ecd91e293" ON "alert"."alert_audit_log" ("category", "timestamp") `);
        await queryRunner.query(`CREATE INDEX "IDX_b0d65d9db54d05fdc032d94ab0" ON "alert"."alert_audit_log" ("tenant_id", "timestamp") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "alert"."alert_history_severity_enum" AS ENUM('info', 'low', 'warning', 'medium', 'high', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "alert_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rule_id" character varying NOT NULL, "rule_name" character varying NOT NULL, "tenant_id" uuid NOT NULL, "farm_id" character varying, "pond_id" character varying, "sensor_id" character varying, "severity" "alert"."alert_history_severity_enum" NOT NULL, "message" text NOT NULL, "triggering_data" jsonb NOT NULL, "triggered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "acknowledged" boolean NOT NULL DEFAULT false, "acknowledged_at" TIMESTAMP WITH TIME ZONE, "acknowledged_by" character varying, "acknowledgement_note" text, "resolved" boolean NOT NULL DEFAULT false, "resolved_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_01cc54a2bdfa890a86511d26822" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_95048d503befe40e467d550713" ON "alert_history" ("rule_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6a2fb05ac6992718ed7ebe04cd" ON "alert_history" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_3932fd981d8305741d98fe95c6" ON "alert_history" ("triggered_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7a3571ae327277e6e937eecac" ON "alert_history" ("severity", "acknowledged") `);
        await queryRunner.query(`CREATE INDEX "IDX_22d06ee2db9f4a34f9f42e387a" ON "alert_history" ("rule_id", "triggered_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_fe91c3217551185531f30bde5e" ON "alert_history" ("tenant_id", "triggered_at") `);
        await queryRunner.query(`ALTER TABLE "alert_incidents" ADD CONSTRAINT "FK_08af29c9206523c12da4497e8d2" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // ── Faz 3.5 hand-author addition — RLS canonical predicate ──
        await applyTenantRlsToSchema(queryRunner, {
            tenantIdColumns: ['tenant_id', 'tenantId'],
            excludeTables: [],
        });

        // ── Faz 3.5 hand-author addition — audit immutability triggers ──
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "alert".alert_audit_log_prevent_update_or_delete()
            RETURNS trigger AS $auditguard$
            BEGIN
              RAISE EXCEPTION 'Audit table "alert"."alert_audit_log" is append-only; UPDATE/DELETE refused (Faz 1.4 protected-tables-guard).';
            END;
            $auditguard$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE TRIGGER trg_alert_audit_log_prevent_update
            BEFORE UPDATE OR DELETE ON "alert"."alert_audit_log"
            FOR EACH ROW EXECUTE FUNCTION "alert".alert_audit_log_prevent_update_or_delete();
        `);
        await queryRunner.query(`
            REVOKE UPDATE, DELETE ON "alert"."alert_audit_log" FROM PUBLIC;
        `);
    }

    // ── GENERATED postCondition (DATA-CRITICAL-010) — do not hand-edit ──
    public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
        const rows: Array<{ missing: string }> = await queryRunner.query(`
            SELECT expected.table_name AS missing
              FROM (VALUES ('alert_history'), ('alert_incidents'), ('alert_rules'), ('escalation_policies')) AS expected(table_name)
             WHERE NOT EXISTS (
               SELECT 1
                 FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_name = expected.table_name
             )
        `);
        return rows.length === 0;
    }
    // ── END GENERATED postCondition ──

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse Faz 3.5 audit immutability triggers
        await queryRunner.query(`DROP TRIGGER IF EXISTS trg_alert_audit_log_prevent_update ON "alert"."alert_audit_log";`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS "alert".alert_audit_log_prevent_update_or_delete();`);
        // Reverse Faz 3.5 RLS install first (avoids policy-on-missing-table errors).
        await removeTenantRlsFromSchema(queryRunner, {
            tenantIdColumns: ['tenant_id', 'tenantId'],
            excludeTables: [],
        });
        await queryRunner.query(`ALTER TABLE "alert_incidents" DROP CONSTRAINT "FK_08af29c9206523c12da4497e8d2"`);
        await queryRunner.query(`DROP INDEX "IDX_fe91c3217551185531f30bde5e"`);
        await queryRunner.query(`DROP INDEX "IDX_22d06ee2db9f4a34f9f42e387a"`);
        await queryRunner.query(`DROP INDEX "IDX_e7a3571ae327277e6e937eecac"`);
        await queryRunner.query(`DROP INDEX "IDX_3932fd981d8305741d98fe95c6"`);
        await queryRunner.query(`DROP INDEX "IDX_6a2fb05ac6992718ed7ebe04cd"`);
        await queryRunner.query(`DROP INDEX "IDX_95048d503befe40e467d550713"`);
        await queryRunner.query(`DROP TABLE "alert_history"`);
        await queryRunner.query(`DROP TYPE "alert"."alert_history_severity_enum"`);
        await queryRunner.query(`DROP INDEX "alert"."IDX_b0d65d9db54d05fdc032d94ab0"`);
        await queryRunner.query(`DROP INDEX "alert"."IDX_0935a1474b7e5fbc3ecd91e293"`);
        await queryRunner.query(`DROP INDEX "alert"."IDX_12a48bc2013d674b4362827d91"`);
        await queryRunner.query(`DROP INDEX "alert"."IDX_6ec936baf2f2070b57c1a01163"`);
        await queryRunner.query(`DROP INDEX "alert"."IDX_b3dd833c7aad4a304fc003bb92"`);
        await queryRunner.query(`DROP TABLE "alert"."alert_audit_log"`);
        await queryRunner.query(`DROP INDEX "IDX_9d68d4a70ea580f2637ba63492"`);
        await queryRunner.query(`DROP INDEX "IDX_f8db963be83d4dfc1d554e3b99"`);
        await queryRunner.query(`DROP INDEX "IDX_253ca859cb76fea6029d8c872a"`);
        await queryRunner.query(`DROP INDEX "IDX_3755a41cd91f41cb028913edbb"`);
        await queryRunner.query(`DROP INDEX "IDX_08af29c9206523c12da4497e8d"`);
        await queryRunner.query(`DROP INDEX "IDX_4dc9bc60472ac57d76ffe3021a"`);
        await queryRunner.query(`DROP TABLE "alert_incidents"`);
        await queryRunner.query(`DROP TYPE "alert"."alert_incidents_status_enum"`);
        await queryRunner.query(`DROP TYPE "alert"."alert_incidents_severity_enum"`);
        await queryRunner.query(`DROP INDEX "IDX_cf1716ac2439167338b35549ce"`);
        await queryRunner.query(`DROP INDEX "IDX_a893e79c1f6c20afe255340dcd"`);
        await queryRunner.query(`DROP INDEX "IDX_783aaff150ad01be736b8394dc"`);
        await queryRunner.query(`DROP TABLE "escalation_policies"`);
        await queryRunner.query(`DROP INDEX "IDX_db6012f863dcdb59c273f028aa"`);
        await queryRunner.query(`DROP INDEX "IDX_76bd886fe88f73e6efeed5b185"`);
        await queryRunner.query(`DROP INDEX "IDX_e2f98912faa323e01fe7201511"`);
        await queryRunner.query(`DROP INDEX "IDX_3028424bd73602cd4356a78b16"`);
        await queryRunner.query(`DROP INDEX "IDX_b0859675aee23a2cbe0c703ef1"`);
        await queryRunner.query(`DROP INDEX "IDX_19f0d3eba80c0d5f64c446dd80"`);
        await queryRunner.query(`DROP TABLE "alert_rules"`);
        await queryRunner.query(`DROP TYPE "alert"."alert_rules_severity_enum"`);
    }

}
