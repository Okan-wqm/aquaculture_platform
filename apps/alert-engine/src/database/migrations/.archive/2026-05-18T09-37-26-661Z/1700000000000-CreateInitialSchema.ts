import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000
 * ============================================================================
 *
 * Restores the alert-engine migration baseline that was lost when the original
 * `CREATE TABLE` migrations were squashed out of source. On a fresh-volume
 * bootstrap (no init scripts seeding alert.* tables) the rest of the
 * migration chain fails because subsequent migrations assume the tables
 * already exist:
 *
 *   - 1786400000000-ConvergeTenantIdToUuid ALTERs
 *     `alert.alert_incidents.tenant_id` and `alert.alert_audit_log.tenant_id`
 *     from varchar to uuid. Both ALTERs no-op on a fresh DB because the
 *     tables don't exist — but the missing tables are also needed by every
 *     repository in the running service.
 *   - 1786700000000-PropagateTenantIdUuidToAllSchemas iterates over
 *     `information_schema.tables` and is a documented no-op when the source
 *     `alert.alert_incidents` is absent (see migration log message line
 *     119-124 of that file).
 *
 * # Scope
 *
 * Create 5 missing `alert.*` tables idempotently, in topological order:
 *
 *   1. alert.alert_rules               — rule definitions (no FKs)
 *   2. alert.escalation_policies       — escalation routing (no FKs)
 *   3. alert.alert_incidents           — triggered incidents (FK rule_id -> alert_rules)
 *   4. alert.alert_history             — append-only audit trail (no FKs; rule_id is logical)
 *   5. alert.alert_audit_log           — internal audit (no FKs)
 *
 * # tenant_id type per table — exact alignment with entity declarations
 *
 * The platform's canonical tenant identifier is uuid, but only the two
 * entities that explicitly declare `type: 'uuid'` use uuid columns today.
 * The rest still ride the varchar path that 1786700000000 will eventually
 * propagate-and-convert. Mismatching the column type with the entity
 * surfaces in `SchemaDriftValidator` at boot, so this baseline matches
 * each entity verbatim:
 *
 *   alert_rules.tenant_id          varchar(255)  — entity has no `type:`
 *   escalation_policies.tenant_id  varchar(255)  — entity has no `type:`
 *   alert_incidents.tenant_id      uuid          — entity declares `type: 'uuid'`
 *   alert_history.tenant_id        varchar(255)  — entity has no `type:`
 *   alert_audit_log.tenant_id      uuid NULL     — entity declares `type: 'uuid', nullable: true`
 *
 * The 1786400000000 migration guards on `data_type = 'character varying'`
 * before ALTERing alert_incidents / alert_audit_log to uuid, so creating
 * those columns as uuid here makes its ALTER a documented no-op (the
 * second-run idempotency path that already exists in that migration).
 *
 * # Schema-per-tenant boundary
 *
 * `alert` is a schema-per-tenant service per CLAUDE.md / ADR-011. This
 * baseline creates the SOURCE schema tables only. `tenant_<uuid>` schema
 * replicas are cloned at tenant onboarding by TenantSchemaSyncService via
 * `CREATE TABLE LIKE INCLUDING ALL`; they are NOT created here. RLS
 * policies are installed by later migrations that depend on these tables
 * existing first.
 *
 * # Idempotency
 *
 * Every DDL statement uses `IF NOT EXISTS` (tables, columns, indexes) and
 * `DO $$ ... EXCEPTION WHEN duplicate_object` for enum types and FK
 * constraints. A second run is a no-op.
 *
 * # CREATE INDEX bundling (migration-sql-lint R3)
 *
 * Each `CREATE TABLE` and its sibling `CREATE INDEX` statements are
 * bundled into a single `queryRunner.query(...)` call. The lint rule R3
 * (`create-index-not-concurrent`) scans each query call as one chunk and
 * looks for a `CREATE TABLE` in the same chunk to apply the
 * just-created-table exemption (CONCURRENTLY would fail inside an
 * implicit transaction that contains the creation).
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateInitialSchema1700000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1700000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log('Creating baseline alert.* tables (5)');

    // The alert schema itself is created by infrastructure/docker/init-scripts
    // / SchemaManagerService. Defensive guard for direct CLI runs against a
    // bare database — no-op when the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS alert`);

    await this.createEnumTypes(queryRunner);
    await this.createAlertRulesTable(queryRunner);
    await this.createEscalationPoliciesTable(queryRunner);
    await this.createAlertIncidentsTable(queryRunner);
    await this.createAlertHistoryTable(queryRunner);
    await this.createAlertAuditLogTable(queryRunner);

    this.logger.log('Baseline alert schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting baseline alert.* tables. Destructive; intended for ' +
        'ephemeral test environments only.',
    );

    // Reverse FK order — child (alert_incidents references alert_rules)
    // before parent. The rest are independent.
    const tablesInDropOrder = [
      'alert_audit_log',
      'alert_history',
      'alert_incidents',
      'escalation_policies',
      'alert_rules',
    ];
    for (const table of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS alert."${table}" CASCADE`);
    }

    // Drop enum types last; CASCADE is safe because the table drops above
    // already removed dependent columns.
    const enumTypes = [
      'alert_rules_severity_enum',
      'alert_incidents_severity_enum',
      'alert_incidents_status_enum',
      'alert_history_severity_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(
        `DROP TYPE IF EXISTS alert."${enumType}" CASCADE`,
      );
    }
  }

  /**
   * Create Postgres enum types. Names follow TypeORM's
   * `{table}_{column}_enum` auto-generation convention so
   * `SchemaDriftValidator.resolveEnumTypeName` finds these types when it
   * introspects pg_enum.
   *
   * `DO $$ ... EXCEPTION WHEN duplicate_object` makes each block
   * idempotent without depending on `CREATE TYPE IF NOT EXISTS` (Postgres
   * does not support that variant).
   *
   * The escalation_policies entity declares its `severity` column as
   * `type: 'jsonb'` (an array of severities), so no enum type is created
   * for it — the column stores raw jsonb.
   */
  private async createEnumTypes(queryRunner: QueryRunner): Promise<void> {
    // AlertSeverity values from alert-rule.entity.ts (info, low, warning,
    // medium, high, critical). Used by alert_rules.severity,
    // alert_incidents.severity, and alert_history.severity.
    const severityValues = ['info', 'low', 'warning', 'medium', 'high', 'critical'];

    // IncidentStatus values from alert-incident.entity.ts.
    const incidentStatusValues = [
      'NEW',
      'ACKNOWLEDGED',
      'INVESTIGATING',
      'RESOLVED',
      'CLOSED',
      'SUPPRESSED',
    ];

    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      { name: 'alert_rules_severity_enum', values: severityValues },
      { name: 'alert_incidents_severity_enum', values: severityValues },
      { name: 'alert_incidents_status_enum', values: incidentStatusValues },
      { name: 'alert_history_severity_enum', values: severityValues },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE alert."${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  /**
   * alert.alert_rules — database/entities/alert-rule.entity.ts
   *
   * tenant_id is varchar(255) — the entity declares no explicit type, so
   * TypeORM defaults to varchar. Migration 1786400000000 does NOT touch
   * this column (only alert_incidents and alert_audit_log are in scope).
   *
   * Indexes mirror the entity decorators verbatim:
   *   @Index(['tenantId', 'isActive'])
   *   @Index(['name', 'tenantId'], { unique: true })
   *   plus single-column indexes on tenant_id, farm_id, pond_id, sensor_id.
   */
  private async createAlertRulesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert.alert_rules (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "description" varchar,
        "tenant_id" varchar(255) NOT NULL,
        "farm_id" varchar,
        "pond_id" varchar,
        "sensor_id" varchar,
        "conditions" jsonb NOT NULL,
        "severity" alert.alert_rules_severity_enum DEFAULT 'medium',
        "is_active" boolean NOT NULL DEFAULT true,
        "notification_channels" jsonb,
        "recipients" jsonb,
        "cooldown_minutes" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT NOW(),
        "updated_at" timestamptz NOT NULL DEFAULT NOW(),
        "created_by" varchar
      );
      CREATE INDEX IF NOT EXISTS "IDX_alert_rules_tenant_active"
        ON alert.alert_rules ("tenant_id", "is_active");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_alert_rules_name_tenant"
        ON alert.alert_rules ("name", "tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_rules_tenant_id"
        ON alert.alert_rules ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_rules_farm_id"
        ON alert.alert_rules ("farm_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_rules_pond_id"
        ON alert.alert_rules ("pond_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_rules_sensor_id"
        ON alert.alert_rules ("sensor_id");
    `);
  }

  /**
   * alert.escalation_policies — database/entities/escalation-policy.entity.ts
   *
   * tenant_id is varchar(255) — entity declares no explicit type. The
   * `severity` column stores a jsonb ARRAY of severities (the entity
   * decorator is `type: 'jsonb'`, not the enum), so no enum type is
   * created here for it; the @Index(['severity']) decorator from the
   * entity translates to a GIN-friendly index but TypeORM emits a
   * default btree by default — we match that for SchemaDriftValidator
   * parity.
   */
  private async createEscalationPoliciesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert.escalation_policies (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" varchar(255) NOT NULL,
        "name" varchar NOT NULL,
        "description" text,
        "severity" jsonb NOT NULL,
        "levels" jsonb NOT NULL,
        "on_call_schedule" jsonb,
        "suppression_windows" jsonb,
        "repeat_interval_minutes" integer NOT NULL DEFAULT 5,
        "max_repeats" integer NOT NULL DEFAULT 3,
        "is_active" boolean NOT NULL DEFAULT true,
        "is_default" boolean NOT NULL DEFAULT false,
        "priority" integer NOT NULL DEFAULT 0,
        "conditions" jsonb,
        "timezone" varchar,
        "rule_ids" jsonb,
        "farm_ids" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT NOW(),
        "updated_at" timestamptz NOT NULL DEFAULT NOW(),
        "created_by" varchar
      );
      CREATE INDEX IF NOT EXISTS "IDX_escalation_policies_tenant_active"
        ON alert.escalation_policies ("tenant_id", "is_active");
      CREATE INDEX IF NOT EXISTS "IDX_escalation_policies_severity"
        ON alert.escalation_policies ("severity");
      CREATE INDEX IF NOT EXISTS "IDX_escalation_policies_tenant_id"
        ON alert.escalation_policies ("tenant_id");
    `);
  }

  /**
   * alert.alert_incidents — database/entities/alert-incident.entity.ts
   *
   * tenant_id is uuid (entity declares `type: 'uuid'` explicitly). This
   * matches the FINAL state after migration 1786400000000-ConvergeTenantIdToUuid;
   * that migration's guard `data_type = 'character varying'` skips the
   * ALTER when the column is already uuid (idempotent re-run path —
   * verified by reading lines 60-72 of that migration file).
   *
   * FK rule_id -> alert_rules(id) ON DELETE SET NULL matches the
   * `@ManyToOne(..., { onDelete: 'SET NULL' })` decorator on the entity.
   */
  private async createAlertIncidentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert.alert_incidents (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "rule_id" uuid,
        "title" varchar NOT NULL,
        "description" text,
        "severity" alert.alert_incidents_severity_enum NOT NULL DEFAULT 'warning',
        "status" alert.alert_incidents_status_enum NOT NULL DEFAULT 'NEW',
        "risk_score" integer NOT NULL DEFAULT 0,
        "trigger_data" jsonb NOT NULL,
        "farm_id" varchar,
        "pond_id" varchar,
        "sensor_id" varchar,
        "assigned_to" varchar,
        "acknowledged_by" varchar,
        "acknowledged_at" timestamptz,
        "resolved_by" varchar,
        "resolved_at" timestamptz,
        "resolution_notes" text,
        "escalation_level" integer NOT NULL DEFAULT 0,
        "last_escalated_at" timestamptz,
        "timeline" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "related_incident_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "parent_incident_id" varchar,
        "occurrence_count" integer NOT NULL DEFAULT 1,
        "last_occurred_at" timestamptz,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT NOW(),
        "updated_at" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_tenant_status"
        ON alert.alert_incidents ("tenant_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_severity"
        ON alert.alert_incidents ("severity");
      CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_created_at"
        ON alert.alert_incidents ("created_at");
      CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_tenant_id"
        ON alert.alert_incidents ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_rule_id"
        ON alert.alert_incidents ("rule_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_assigned_to"
        ON alert.alert_incidents ("assigned_to");
    `);

    // FK to alert_rules (SET NULL on entity).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE alert.alert_incidents
          ADD CONSTRAINT "FK_alert_incidents_rule"
          FOREIGN KEY ("rule_id") REFERENCES alert.alert_rules("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * alert.alert_history — alert/entities/alert-history.entity.ts
   *
   * Append-only audit trail of triggered alerts. tenant_id and rule_id are
   * varchar (no `type:` on entity) — kept as varchar by 1786400000000
   * (out-of-scope per its docblock §"Tables NOT in scope") and by
   * 1786700000000 (target list is alert_incidents + alert_audit_log
   * only). Future hardening pass will migrate these to uuid in tandem
   * with entity decorator updates.
   *
   * No FK on rule_id — alert history must survive deletion of the rule
   * that produced it (audit-trail durability beats referential elegance).
   */
  private async createAlertHistoryTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert.alert_history (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "rule_id" varchar NOT NULL,
        "rule_name" varchar NOT NULL,
        "tenant_id" varchar(255) NOT NULL,
        "farm_id" varchar,
        "pond_id" varchar,
        "sensor_id" varchar,
        "severity" alert.alert_history_severity_enum NOT NULL,
        "message" text NOT NULL,
        "triggering_data" jsonb NOT NULL,
        "triggered_at" timestamptz NOT NULL,
        "acknowledged" boolean NOT NULL DEFAULT false,
        "acknowledged_at" timestamptz,
        "acknowledged_by" varchar,
        "acknowledgement_note" text,
        "resolved" boolean NOT NULL DEFAULT false,
        "resolved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_alert_history_tenant_triggered"
        ON alert.alert_history ("tenant_id", "triggered_at");
      CREATE INDEX IF NOT EXISTS "IDX_alert_history_rule_triggered"
        ON alert.alert_history ("rule_id", "triggered_at");
      CREATE INDEX IF NOT EXISTS "IDX_alert_history_severity_acknowledged"
        ON alert.alert_history ("severity", "acknowledged");
      CREATE INDEX IF NOT EXISTS "IDX_alert_history_rule_id"
        ON alert.alert_history ("rule_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_history_tenant_id"
        ON alert.alert_history ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_history_triggered_at"
        ON alert.alert_history ("triggered_at");
    `);
  }

  /**
   * alert.alert_audit_log — audit/entities/audit-entry.entity.ts
   *
   * Internal service audit trail. tenant_id is uuid (entity declares
   * `type: 'uuid', nullable: true`). This matches the FINAL state after
   * migration 1786400000000 — that migration's varchar guard skips the
   * ALTER when already uuid.
   *
   * Standalone (no FKs) — a deleted entity's audit trail is exactly the
   * case audit logs exist for; cascading the deletion would defeat the
   * audit-log purpose.
   */
  private async createAlertAuditLogTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert.alert_audit_log (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid,
        "category" varchar NOT NULL,
        "event_type" varchar NOT NULL,
        "severity" varchar NOT NULL,
        "action" varchar NOT NULL,
        "description" text NOT NULL,
        "entity_type" varchar,
        "entity_id" varchar,
        "user_id" varchar,
        "user_name" varchar,
        "ip_address" varchar,
        "user_agent" varchar,
        "previous_state" jsonb,
        "new_state" jsonb,
        "changes" jsonb,
        "metadata" jsonb,
        "correlation_id" varchar,
        "parent_audit_id" varchar,
        "tags" jsonb,
        "duration" integer,
        "success" boolean NOT NULL,
        "error_message" text,
        "timestamp" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_alert_audit_log_tenant_timestamp"
        ON alert.alert_audit_log ("tenant_id", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_alert_audit_log_category_timestamp"
        ON alert.alert_audit_log ("category", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_alert_audit_log_event_timestamp"
        ON alert.alert_audit_log ("event_type", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_alert_audit_log_entity"
        ON alert.alert_audit_log ("entity_type", "entity_id");
      CREATE INDEX IF NOT EXISTS "IDX_alert_audit_log_correlation"
        ON alert.alert_audit_log ("correlation_id");
    `);
  }
}
