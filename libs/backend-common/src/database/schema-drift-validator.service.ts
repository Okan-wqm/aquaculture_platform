import { Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BOOT_INVARIANT_SIGNALS,
  emitBootInvariantSignal,
} from '@platform/service-catalog/boot-signals';
import { DataSource, EntityMetadata } from 'typeorm';

import { isClassConstructor } from '../types/class-constructor';

import { lookupEmergencyOverride } from './emergency-override-check';
import {
  getEncryptedAtRestMetadata,
  type EncryptedAtRestMetadata,
} from './encrypted-at-rest.decorator';
import { DRIFT_CLASSES, type DriftClassId } from './schema-drift/drift-classes';
import {
  expectedEntityDbType,
  isUuidTypeDrift,
  normalizeInformationSchemaType,
} from './schema-drift/type-normalization';
import { TENANT_AWARE_SCHEMAS, TENANT_SCHEMA_NAME_RE } from './tenant-aware-schemas';
import { isTenantDeltaAllowed } from './tenant-fanout.decorator';

export const SCHEMA_DRIFT_CLEAN_SIGNAL = BOOT_INVARIANT_SIGNALS.schema_drift_clean.pattern;

/**
 * createSchemaDriftValidator
 * ============================================================================
 *
 * Factory that produces an OnApplicationBootstrap NestJS provider which
 * compares each entity's declared metadata against the live
 * information_schema and fails boot (configurable) on any of:
 *
 *   1. Entity declares `schema: X` but the table physically lives in a
 *      different schema.
 *   2. Entity declares `@Column({ type: 'uuid' })` but the DB column
 *      has a non-uuid type (text / character varying are the common
 *      failure modes — both of these broke RLS on 2026-04-14 with
 *      `operator does not exist: text = uuid`).
 *   3. Entity declares `nullable: false` on a column that is actually
 *      nullable in the DB (a silent-null risk — foreign keys + ORM
 *      enforcement diverge).
 *
 * # Why a factory
 *
 * Same rationale as createMigrationRunnerService (see docblock there).
 * Each service wires the validator with its own service name label for
 * log readability.
 *
 * # Configuration
 *
 *   SCHEMA_DRIFT_FATAL=true   → fail service boot on any drift
 *   SCHEMA_DRIFT_FATAL=false  → log CRITICAL but continue
 *                               (development only; production ignores it)
 *   SCHEMA_DRIFT_ENABLED=false → skip the validator entirely
 *                               (development only; production throws)
 *
 * Defaults: enabled=true. Fatal is always true in production-like
 * environments (NODE_ENV=production or AQUA_ENV=production|staging) and
 * defaults to false elsewhere. Production-like boot cannot silently run with
 * known schema drift:
 * either the validator emits SCHEMA_DRIFT_CLEAN_SIGNAL, or bootstrap fails
 * before the service can look healthy.
 *
 * # What it does NOT check
 *
 * - Index presence / shape (too noisy; TypeORM generates index names
 *   inconsistently across versions).
 * - Constraint definitions (CHECK, UNIQUE — same noise concern).
 * - Default values (sometimes declared on the app side, sometimes DB).
 *
 * These are fair game for future extension but intentionally out of
 * scope for the initial rollout: we want HIGH-signal checks that never
 * produce a false positive. The three checks above were the ones that
 * caused actual production incidents in 2026-04.
 *
 * @param serviceName Lowercase label for log prefix / override lookup
 *   (e.g. 'billing', 'alert-engine').
 * @param schemaName Physical source schema to validate when schema-less
 *   tenant-aware entities need source-schema resolution. Defaults to
 *   serviceName for backward compatibility.
 * @returns An OnApplicationBootstrap provider class.
 */
export function createSchemaDriftValidator(
  serviceName: string,
  schemaName = serviceName,
): Type<OnApplicationBootstrap> {
  const sourceSchemaName = schemaName;

  @Injectable()
  class SchemaDriftValidator implements OnApplicationBootstrap {
    private readonly logger = new Logger(`SchemaDriftValidator[${serviceName}]`);

    constructor(
      private readonly dataSource: DataSource,
      private readonly configService: ConfigService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      const isProductionLike = this.isProductionLike();
      const enabled = this.configService.get('SCHEMA_DRIFT_ENABLED', 'true') === 'true';
      if (!enabled) {
        const message = 'Schema drift validator disabled via SCHEMA_DRIFT_ENABLED=false';
        if (isProductionLike) {
          throw new Error(
            `${message}; refusing production-like startup because ` +
              `${SCHEMA_DRIFT_CLEAN_SIGNAL} cannot be emitted.`,
          );
        }
        this.logger.warn(message);
        return;
      }

      const fatal = this.resolveFatalDefault(isProductionLike);

      const tenantScanEnabled =
        this.configService.get('SCHEMA_DRIFT_TENANT_SCAN_ENABLED', 'false') === 'true';

      this.logger.log(
        `Scanning entity metadata for schema drift${tenantScanEnabled ? ' (+ per-tenant shape divergence)' : ''}...`,
      );
      // Severity-aware violations (plan v3 Phase 2 + Phase 8 Stage 1).
      // ERRORS block the schema_drift_clean boot signal; the
      // deploy asserter (scripts/deploy/assert-service-signals.ts)
      // fails the per-service signal window if the signal never emits.
      // WARNINGS surface operationally (logged as warn, visible in
      // Grafana drift dashboard) but do NOT block the signal. Phase 8
      // Stage 1+ may elevate specific warn classes to error after
      // per-service cleanup. See drift-classes.ts for the per-class
      // severity mapping (Class E orphan_column = warn; Class A-D = error).
      const errorViolations: string[] = [];
      const warningViolations: string[] = [];
      let skippedNotOwned = 0;

      for (const entity of this.dataSource.entityMetadatas) {
        // ── Skip entities that explicitly declare they do not own the table ──
        //
        // TypeORM's `synchronize: false` on @Entity is the canonical
        // "this entity is a read-view of another service's table; do
        // NOT generate DDL for it" marker. RdbmsSchemaBuilder itself
        // honours it (no CREATE/ALTER emitted for synchronize-false
        // entities). The drift validator must mirror that semantics:
        //
        //   1. The OWNER service has its own SchemaDriftValidator that
        //      catches drift on the OWNER's side. A consumer's read-only
        //      view of `billing.invoices` should not double-report drift
        //      that billing-service already reports correctly.
        //   2. Cross-schema consumers run as their OWN per-service DB
        //      role (e.g. admin-api as admin_service). PostgreSQL's
        //      information_schema.columns view filters by privilege —
        //      the consumer role typically has no SELECT on the foreign
        //      table, sees ZERO columns, and emits a false-positive
        //      drift block for every column in the entity. Granting
        //      cross-schema SELECT to mute that would violate the
        //      ADR-011 ownership boundary; skipping the entity is the
        //      architecturally correct alternative.
        //   3. Pre-2026-04-20 behaviour (validate every entity regardless
        //      of synchronize flag) was the root cause of admin-api's
        //      67 false positives on billing.invoices/subscriptions/
        //      usage_aggregations/tenant_usage_metrics — INFRA-CRITICAL-032.
        //
        // We log the count so operators can SEE what got skipped and
        // verify the inventory of cross-schema read views matches their
        // expectations.
        if (entity.synchronize === false) {
          skippedNotOwned++;
          continue;
        }
        await this.validateEntity(entity, errorViolations, warningViolations);
      }

      // Class I — per-tenant shape divergence (opt-in via
      // SCHEMA_DRIFT_TENANT_SCAN_ENABLED=true). Runs AFTER the source-
      // schema scan because the source is the reference shape; tenant
      // clones are compared against it.
      if (tenantScanEnabled) {
        await this.scanPerTenantShapeDivergence(
          this.dataSource.entityMetadatas,
          errorViolations,
          warningViolations,
        );
      }

      // Warnings: logged separately so operators see Class E/F/G drift
      // accumulation without the signal being blocked. Phase 0 Grafana
      // drift dashboard aggregates this via the `schema.drift.warn`
      // literal substring matcher.
      if (warningViolations.length > 0) {
        this.logger.warn(
          `schema.drift.warn service="${serviceName}" — ${warningViolations.length} warn-severity drift(s):\n  ${warningViolations.join('\n  ')}`,
        );
      }

      if (errorViolations.length === 0) {
        // Boot signal emits cleanly even when warnings exist. The deploy
        // asserter requires structured fields from the canonical signal
        // helper, not just the literal text.
        // operational signal for warn-level drift is separate.
        emitBootInvariantSignal(this.logger, 'schema_drift_clean', {
          serviceName,
          schemaName: sourceSchemaName,
          checkedOwnedEntities: this.dataSource.entityMetadatas.length - skippedNotOwned,
          skippedCrossSchemaReadViews: skippedNotOwned,
          warningViolations: warningViolations.length,
        });
        return;
      }

      // SECURITY-OPS: this is the alerting hook. The literal substring
      // "schema.drift.detected" should be matched in log dashboards /
      // alert rules so operators are paged when an entity drifts.
      this.logger.error(
        `schema.drift.detected service="${serviceName}" — ${errorViolations.length} violation(s):\n  ${errorViolations.join('\n  ')}`,
      );

      if (fatal) {
        // R16 emergency-override check — an operator-issued
        // drift_fatal_bypass for this service in this environment
        // suppresses the throw. Validator still logs the drift
        // (schema.drift.detected already emitted above) so the audit
        // trail is intact; the bypass only prevents the fatal exit.
        // Fail-safe: lookup errors never grant bypass.
        const environment =
          this.configService.get<string>('AQUA_ENV') ??
          this.configService.get<string>('NODE_ENV', 'development');
        const bypass = await lookupEmergencyOverride({
          dataSource: this.dataSource,
          serviceName,
          kind: 'drift_fatal_bypass',
          environment,
        });
        if (bypass.active && bypass.row !== undefined) {
          this.logger.warn(
            `schema.drift.bypassed service="${serviceName}" — ` +
              `drift_fatal_bypass override active (id=${bypass.row.id}, ` +
              `actor=${bypass.row.actor}, reason="${bypass.row.reason}", ` +
              `expiresAt=${bypass.row.expiresAt.toISOString()}). ` +
              `Continuing boot despite ${errorViolations.length} violation(s).`,
          );
          return;
        }
        throw new Error(
          `Schema drift detected in ${errorViolations.length} place(s). ` +
            `In non-production, set SCHEMA_DRIFT_FATAL=false to start the service anyway, but ` +
            `the drift must be fixed — either via a migration that aligns the ` +
            `DB to the entity, or by reverting the entity change if it was ` +
            `premature. First violation: ${errorViolations[0]}`,
        );
      }
    }

    private isProductionLike(): boolean {
      const nodeEnv =
        this.configService.get<string>('NODE_ENV') ?? process.env['NODE_ENV'] ?? 'development';
      const aquaEnv = this.configService.get<string>('AQUA_ENV') ?? process.env['AQUA_ENV'] ?? '';
      return nodeEnv === 'production' || aquaEnv === 'production' || aquaEnv === 'staging';
    }

    private resolveFatalDefault(isProductionLike: boolean): boolean {
      if (isProductionLike) return true;
      const configured = this.configService.get<string>('SCHEMA_DRIFT_FATAL');
      if (configured !== undefined && configured !== null && configured !== '') {
        return configured === 'true';
      }
      return false;
    }

    /**
     * Query information_schema for the entity's table, then cross-check
     * schema location + column types + nullability.
     */
    private async validateEntity(
      entity: EntityMetadata,
      errorViolations: string[],
      warningViolations: string[],
    ): Promise<void> {
      const schema = this.resolveEntitySchema(entity);
      const tableName = entity.tableName;

      // Existence + schema check.
      //
      // Filter out per-tenant schemas (`tenant_<uuid>`) — those are
      // CREATE TABLE LIKE replicas of source tables and would produce
      // false positives if `LIMIT 1` happened to land on one. Quoting
      // ADR-012: "schema-per-tenant services declare NO `schema:` option
      // on tenant entities; the validator queries the source schema, which
      // has the canonical table." A query against pg_tables without this
      // filter would arbitrarily return ANY schema's match.
      //
      // Replaced LIMIT 1 with explicit schema filtering: the entity's
      // declared schema is the only candidate we consider.
      const tableRows: Array<{ schemaname: string }> = await this.dataSource.query(
        `SELECT schemaname FROM pg_tables
           WHERE tablename = $1
             AND schemaname NOT LIKE 'tenant\\_%' ESCAPE '\\'
             AND schemaname NOT IN ('pg_catalog', 'information_schema')
           ORDER BY (schemaname = $2) DESC, schemaname
           LIMIT 1`,
        [tableName, schema],
      );
      const [firstRow] = tableRows;
      if (!firstRow) {
        // Entity owns this table (synchronize !== false) but the source
        // schema has no physical table. Treat as error-level drift so a
        // deploy cannot pass with a clean boot signal while the app would
        // crash on first query.
        this.route(
          'missing_column',
          `[${schema}.${tableName}] entity declares owned table but DB has no such table in any non-tenant schema`,
          errorViolations,
          warningViolations,
        );
        return;
      }
      if (firstRow.schemaname !== schema) {
        this.route(
          'schema_location',
          `[${tableName}] entity declares schema='${schema}' but table lives in '${firstRow.schemaname}'`,
          errorViolations,
          warningViolations,
        );
        return;
      }

      // Column type + nullability check.
      const columnRows: Array<{
        column_name: string;
        data_type: string;
        udt_name: string | null;
        is_nullable: string;
      }> = await this.dataSource.query(
        `SELECT column_name, data_type, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, tableName],
      );
      const columns = new Map(columnRows.map((r) => [r.column_name, r]));

      // Enum-column index for Class F batched lookup. Populated during
      // the per-column loop below and consumed after, so we issue one
      // pg_enum query per entity instead of N+1.
      const entityEnumColumns: Array<{
        dbName: string;
        typeName: string;
        declaredLabels: readonly string[];
      }> = [];

      // @EncryptedAtRest metadata for this entity (Class J contract).
      // Keyed by property name, not DB column name — columns[].propertyName
      // maps to EntityMetadata.columns[].propertyName so we resolve by
      // the TypeScript property.
      const encryptedProperties: ReadonlyMap<string, EncryptedAtRestMetadata> = isClassConstructor(
        entity.target,
      )
        ? getEncryptedAtRestMetadata(entity.target)
        : new Map();

      for (const column of entity.columns) {
        const dbName = column.databaseName;
        const dbColumn = columns.get(dbName);
        if (!dbColumn) {
          // Entity declares a column the DB lacks. Closes NEW-HIGH-D from
          // the round-2 review: previously the validator silently skipped
          // this case ("new entity column, not yet migrated"), which
          // hid the column-shape mismatch failure mode that broke
          // shared.audit_logs writes (NEW-CRITICAL-A). The skip was
          // wrong-by-construction — if the entity declares a column,
          // every INSERT/SELECT against that column crashes today, NOT
          // "after migration". Operators in a genuine mid-migration
          // window can suppress via SCHEMA_DRIFT_FATAL=false (default).
          this.route(
            'missing_column',
            `[${schema}.${tableName}.${dbName}] entity declares column but DB has no such column`,
            errorViolations,
            warningViolations,
          );
          continue;
        }

        // Declared-type check for the high-signal uuid case. TypeORM's
        // type field can be many things (string identifier, ctor, object)
        // so we pattern-match on the identifier form only.
        const entityType = typeof column.type === 'string' ? column.type : '';

        // Class J — encrypted_column_protection. If the property is
        // decorated with @EncryptedAtRest, the DB column MUST be bytea;
        // and Class B (uuid type) is SUPPRESSED because the entity's
        // declared type is the cipher's logical output, not the storage
        // shape (see ADR-023). The contract is refusal — Phase 3
        // primitives throw rather than attempt to align a decorated
        // column; remediation is the key-rotation runbook.
        const encMeta = encryptedProperties.get(column.propertyName);
        const isEncrypted = encMeta !== undefined;
        if (isEncrypted) {
          if (dbColumn.data_type !== 'bytea') {
            this.route(
              'encrypted_column_protection',
              `[${schema}.${tableName}.${dbName}] column is @EncryptedAtRest(keyId='${encMeta.keyId}', algorithm='${encMeta.algorithm}') but DB type is '${dbColumn.data_type}' — required: bytea. REFUSAL CLASS: do NOT write a migration to alter this column; see docs/runbooks/encrypted-column-key-rotation.md`,
              errorViolations,
              warningViolations,
            );
          }
          // Suppress Class B / F / etc. for the decorated column — the
          // entity's declared shape is a logical marker, not the storage
          // contract. Continuing past here skips Class B (uuid_type) +
          // enum collection. Class C (nullability) still applies — a
          // nullable vs NOT NULL change IS a schema-semantic change that
          // survives encryption.
        } else if (isUuidTypeDrift(column, dbColumn)) {
          const expected = expectedEntityDbType(column);
          const actual = normalizeInformationSchemaType(dbColumn);
          this.route(
            'uuid_type',
            `[${schema}.${tableName}.${dbName}] entity declares ${expected} but DB is ${actual}`,
            errorViolations,
            warningViolations,
          );
        }

        // Nullability — entity says NOT NULL but DB says YES → latent
        // null risk. The reverse (DB says NOT NULL, entity says nullable)
        // is safe (no runtime error possible), so skip that direction.
        if (!column.isNullable && dbColumn.is_nullable === 'YES') {
          this.route(
            'nullability',
            `[${schema}.${tableName}.${dbName}] entity declares NOT NULL but DB column is nullable`,
            errorViolations,
            warningViolations,
          );
        }

        // Class F — enum_labels: collect enum-typed entity columns for
        // batched pg_enum lookup below. TypeORM exposes `column.enum`
        // (array of declared labels) and `column.enumName` (explicit
        // type name). When `enumName` is absent TypeORM auto-derives
        // `{table}_{column}_enum` (see resolveEnumTypeName()).
        // Decorated columns are skipped here too (see Class J above).
        if (!isEncrypted && entityType === 'enum' && Array.isArray(column.enum)) {
          const declaredLabels = (column.enum as readonly unknown[]).filter(
            (x): x is string => typeof x === 'string',
          );
          if (declaredLabels.length > 0) {
            entityEnumColumns.push({
              dbName,
              typeName: this.resolveEnumTypeName(column.enumName, tableName, dbName),
              declaredLabels,
            });
          }
        }
      }

      // Class F — enum_labels: diff entity-declared labels against
      // pg_enum labels. Two drift directions surface here:
      //   1. Entity has a label DB lacks → INSERTs with the new value
      //      crash (operator-visible failure).
      //   2. DB has a label entity lacks → legacy values still queryable
      //      but a removal in the entity is not a silent rename; needs
      //      explicit remap via alignEnumLabels primitive.
      // Severity sourced from registry (see drift-classes.ts Class F).
      if (entityEnumColumns.length > 0) {
        await this.scanEnumLabelDrift(
          schema,
          tableName,
          entityEnumColumns,
          errorViolations,
          warningViolations,
        );
      }

      // Class G — check_constraint: diff entity-declared @Check() decorators
      // against pg_constraint contype='c'. Coarse count-based signal during
      // rollout: PG canonicalizes the predicate text (ARRAY ordering, type
      // casts, OR-branch reorder), so exact-string match produces false
      // positives until Phase 3 alignCheckConstraints ships a normalizer.
      // Counts-only drift is enough for the common failure modes:
      //   - entity adds a @Check but migration was skipped → count mismatch
      //   - DB has legacy CHECK the entity dropped → count mismatch
      await this.scanCheckConstraintDrift(
        schema,
        tableName,
        entity.checks ?? [],
        errorViolations,
        warningViolations,
      );

      // Class E — orphan_column: DB has a column the entity does not
      // declare. Severity WARN (not error) per drift-classes.ts — dropping
      // the column is a data-loss operation gated by an allowlist
      // (Phase 3 dropOrphanedColumns primitive). Routes via registry
      // severity, so operators see the drift surface WITHOUT blocking
      // the schema_drift_clean boot signal.
      //
      // Phase 8 Stage 2+ may elevate specific orphan columns to error
      // severity once every existing E violation is either allowlisted
      // or dropped via Phase 3's dropOrphanedColumns primitive.
      const entityColumnNames = new Set(entity.columns.map((c) => c.databaseName));
      for (const dbCol of columnRows) {
        if (!entityColumnNames.has(dbCol.column_name)) {
          this.route(
            'orphan_column',
            `[${schema}.${tableName}.${dbCol.column_name}] DB has column but entity does not declare it (orphan_column — see drift-classes.ts Class E)`,
            errorViolations,
            warningViolations,
          );
        }
      }

      // Class K — foreign_key_presence (Faz 1.8 of day-one baseline reset).
      //
      // Opt-in via SCHEMA_DRIFT_VALIDATE_FK=true during the Faz 1
      // rollout window. Default OFF because pre-baseline-reset
      // services carry known FK gaps (the 3-deploy sensor-service
      // AlignSensorEntitySurfaceFks chain landed FKs progressively;
      // toggling default-on before Faz 6 would mass-fail bootstrap).
      //
      // Post-Faz-6 baseline reset, every service's FKs ship in the
      // single Baseline migration and this flag defaults to ON
      // (handled by the matching update in resolveValidateForeignKeysDefault).
      const validateForeignKeys =
        this.configService.get('SCHEMA_DRIFT_VALIDATE_FK', 'false') === 'true';
      if (validateForeignKeys) {
        await this.scanForeignKeyDrift(
          schema,
          tableName,
          entity.foreignKeys ?? [],
          errorViolations,
          warningViolations,
        );
      }
    }

    /**
     * Resolve the schema the validator should use for a TypeORM entity.
     *
     * Tenant-aware services intentionally declare no `schema:` on tenant
     * business entities so TypeORM emits unqualified SQL and PostgreSQL
     * `search_path` routes each request to `tenant_<uuid>, <source>, public`.
     * For drift validation, the canonical physical table for those same
     * schema-less entities is the service source schema, not `public`.
     */
    private resolveEntitySchema(entity: EntityMetadata): string {
      if (entity.schema) {
        return entity.schema;
      }

      if (TENANT_AWARE_SCHEMAS.has(sourceSchemaName)) {
        return sourceSchemaName;
      }

      return 'public';
    }

    /**
     * Push a violation to the error or warning bucket based on
     * DRIFT_CLASSES[classId].severity. The registry is the SSoT —
     * no hard-coded class→bucket mapping lives in this file. Flipping
     * a class severity is a single-line edit in drift-classes.ts; both
     * the validator AND the harness pick up the change without code
     * edits elsewhere.
     */
    private route(
      classId: DriftClassId,
      message: string,
      errorViolations: string[],
      warningViolations: string[],
    ): void {
      const severity = DRIFT_CLASSES[classId].severity;
      if (severity === 'error') {
        errorViolations.push(message);
      } else {
        warningViolations.push(message);
      }
    }

    /**
     * Canonical pg_enum type name for an entity column. When the entity
     * explicitly sets `@Column({ enumName: 'foo' })` we use that;
     * otherwise TypeORM auto-generates `{table}_{column}_enum`
     * (lowercase, underscore-joined). Mirrors TypeORM's
     * `PostgresQueryRunner.buildEnumName()` naming convention so the
     * validator reads the same type identifier the schema-builder writes.
     */
    private resolveEnumTypeName(
      enumName: string | undefined,
      tableName: string,
      columnDbName: string,
    ): string {
      if (enumName && typeof enumName === 'string') return enumName;
      return `${tableName}_${columnDbName}_enum`;
    }

    /**
     * Batch-query pg_enum for every enum-typed column in one round-trip
     * per entity, then diff declared vs actual labels. Schema-qualified
     * via n.nspname so two schemas with the same enum type name don't
     * cross-contaminate (e.g. source hr schema + tenant_<uuid>
     * replicas; the validator only considers the entity's declared
     * schema).
     */
    private async scanEnumLabelDrift(
      schema: string,
      tableName: string,
      entityEnumColumns: ReadonlyArray<{
        dbName: string;
        typeName: string;
        declaredLabels: readonly string[];
      }>,
      errorViolations: string[],
      warningViolations: string[],
    ): Promise<void> {
      const typeNames = entityEnumColumns.map((c) => c.typeName);
      const rows: Array<{
        type_name: string;
        label: string;
        sort_order: number;
      }> = await this.dataSource.query(
        `SELECT t.typname AS type_name, e.enumlabel AS label, e.enumsortorder AS sort_order
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = $1
            AND t.typname = ANY($2::text[])
          ORDER BY t.typname, e.enumsortorder`,
        [schema, typeNames],
      );

      const dbLabelsByType = new Map<string, string[]>();
      for (const row of rows) {
        const list = dbLabelsByType.get(row.type_name) ?? [];
        list.push(row.label);
        dbLabelsByType.set(row.type_name, list);
      }

      for (const col of entityEnumColumns) {
        const dbLabels = dbLabelsByType.get(col.typeName);
        if (!dbLabels) {
          // Entity declares an enum column but the pg_enum TYPE itself
          // does not exist in the entity's declared schema. Usually a
          // missed migration — the @Column({enum:[...]}) decorator
          // alone does not create the DB type; TypeORM CREATE TYPE is
          // emitted by the schema-builder, which the runner owns.
          this.route(
            'enum_labels',
            `[${schema}.${tableName}.${col.dbName}] entity declares enum type '${col.typeName}' but no such pg_enum exists in schema '${schema}'`,
            errorViolations,
            warningViolations,
          );
          continue;
        }
        const dbSet = new Set(dbLabels);
        const declaredSet = new Set(col.declaredLabels);
        const missingInDb = col.declaredLabels.filter((l) => !dbSet.has(l));
        const missingInEntity = dbLabels.filter((l) => !declaredSet.has(l));
        if (missingInDb.length === 0 && missingInEntity.length === 0) continue;
        const parts: string[] = [];
        if (missingInDb.length > 0) {
          parts.push(`entity-only: [${missingInDb.join(', ')}]`);
        }
        if (missingInEntity.length > 0) {
          parts.push(`db-only: [${missingInEntity.join(', ')}]`);
        }
        this.route(
          'enum_labels',
          `[${schema}.${tableName}.${col.dbName}] enum '${col.typeName}' label drift — ${parts.join(' | ')}`,
          errorViolations,
          warningViolations,
        );
      }
    }

    /**
     * Class I — per-tenant shape divergence. For every entity whose
     * declared schema is in TENANT_AWARE_SCHEMAS, enumerate the
     * `tenant_<uuid16>` clones and diff each clone's (column_name,
     * data_type, is_nullable) shape against the source schema. Any
     * divergence ships as a single violation per (tenant, table).
     *
     * Design: opt-in via SCHEMA_DRIFT_TENANT_SCAN_ENABLED because the
     * O(tenants × entities) cost at boot is non-trivial on production
     * (35 schemas × N entities). When enabled the helper batches via
     * two queries (one for source, one UNION ALL across tenant schemas)
     * rather than N+1 per tenant.
     *
     * Severity is read from the registry (warn during rollout; Phase
     * 8 Stage 2 elevates to error once Phase 6 heal primitives ship).
     */
    private async scanPerTenantShapeDivergence(
      entities: readonly EntityMetadata[],
      errorViolations: string[],
      warningViolations: string[],
    ): Promise<void> {
      const tenantAwareEntities = entities.filter(
        (e) =>
          e.schema !== undefined && TENANT_AWARE_SCHEMAS.has(e.schema) && e.synchronize !== false,
      );
      if (tenantAwareEntities.length === 0) return;

      // Enumerate tenant schemas once — same set applies to every
      // tenant-aware entity.
      const tenantSchemaRows: Array<{ schema_name: string }> = await this.dataSource.query(
        `SELECT schema_name FROM information_schema.schemata
            WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
            ORDER BY schema_name`,
      );
      const tenantSchemas = tenantSchemaRows
        .map((r) => r.schema_name)
        .filter((s) => TENANT_SCHEMA_NAME_RE.test(s));
      if (tenantSchemas.length === 0) {
        this.logger.debug(
          'Tenant-scan enabled but no tenant_<uuid> schemas exist — skipping Class I',
        );
        return;
      }

      // Fetch all columns for every tenant_*.table + source.table in a
      // single query. Filter in Node afterwards — simpler than N dynamic
      // SQL queries, and information_schema.columns is bounded.
      const tableNames = Array.from(new Set(tenantAwareEntities.map((e) => e.tableName)));
      const sourceSchemas = Array.from(
        new Set(
          tenantAwareEntities
            .map((e) => e.schema)
            .filter((s): s is string => typeof s === 'string'),
        ),
      );
      const schemasToScan = [...sourceSchemas, ...tenantSchemas];

      const columnRows: Array<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        udt_name: string | null;
        is_nullable: string;
      }> = await this.dataSource.query(
        `SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = ANY($1::text[])
            AND table_name = ANY($2::text[])`,
        [schemasToScan, tableNames],
      );

      // Bucket by "schema.table" for diffing.
      const shapesBySchemaTable = new Map<string, Map<string, string>>();
      for (const row of columnRows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const shape = shapesBySchemaTable.get(key) ?? new Map<string, string>();
        shape.set(row.column_name, `${normalizeInformationSchemaType(row)}|${row.is_nullable}`);
        shapesBySchemaTable.set(key, shape);
      }

      for (const entity of tenantAwareEntities) {
        const sourceKey = `${entity.schema}.${entity.tableName}`;
        const sourceShape = shapesBySchemaTable.get(sourceKey);
        if (!sourceShape) continue; // source table missing — Class A territory, already reported.

        for (const tenant of tenantSchemas) {
          const tenantKey = `${tenant}.${entity.tableName}`;
          const tenantShape = shapesBySchemaTable.get(tenantKey);
          if (!tenantShape) {
            // Tenant schema exists but doesn't carry this table. Could
            // be mid-provisioning or a tenant opted-out of this module.
            // Flag as divergence so operators see the gap.
            this.route(
              'per_tenant_shape_divergence',
              `[${tenant}.${entity.tableName}] tenant schema missing table that source '${entity.schema}' declares`,
              errorViolations,
              warningViolations,
            );
            continue;
          }
          const diffs: string[] = [];
          for (const [col, sourceSig] of sourceShape) {
            const tenantSig = tenantShape.get(col);
            if (tenantSig === undefined) {
              diffs.push(`missing col '${col}'`);
            } else if (tenantSig !== sourceSig) {
              diffs.push(`col '${col}' source=${sourceSig} vs tenant=${tenantSig}`);
            }
          }
          // Extra-on-tenant columns — suppress those matching an
          // @AllowTenantDelta({columnPrefix}) on the entity class
          // (plan v3 R24). A tenant carrying enterprise-tier add-on
          // columns whose names match the declared prefix is an
          // AUTHORIZED delta, not a drift.
          const entityCtor = typeof entity.target === 'function' ? entity.target : undefined;
          for (const [col] of tenantShape) {
            if (!sourceShape.has(col)) {
              if (entityCtor !== undefined && isTenantDeltaAllowed(entityCtor, col)) {
                // Allowlisted — silently skip.
                continue;
              }
              diffs.push(`extra col '${col}'`);
            }
          }
          if (diffs.length > 0) {
            this.route(
              'per_tenant_shape_divergence',
              `[${tenant}.${entity.tableName}] shape diverges from source '${entity.schema}.${entity.tableName}' — ${diffs.slice(0, 5).join(' ; ')}${diffs.length > 5 ? ` (+${diffs.length - 5} more)` : ''}`,
              errorViolations,
              warningViolations,
            );
          }
        }
      }
    }

    /**
     * Count-based Class G detection. Queries pg_constraint for CHECK
     * (contype='c') constraints on the table, compares cardinality
     * against `entity.checks.length`. Coarse signal — flags net add/
     * remove drift without relying on predicate-text equality (PG
     * rewrites ARRAY literals, type casts, operator-class qualifiers
     * that the entity source code does not contain).
     *
     * Phase 3 alignCheckConstraints upgrades this to per-predicate
     * diffing with a normalizer that canonicalizes whitespace, ARRAY
     * order, and the `'x'::text::hr.my_enum` cast form.
     *
     * Excludes not-null constraints (PG treats them as contype='n').
     * Excludes constraints generated automatically by SERIAL / identity
     * (contype='c' but conname starts with '{table}_{col}_check' and
     * conbin matches the standard IS NOT NULL predicate); filtered by
     * conbin IS NOT NULL + explicit contype='c' only.
     */
    private async scanCheckConstraintDrift(
      schema: string,
      tableName: string,
      entityChecks: ReadonlyArray<{ name?: string; expression: string }>,
      errorViolations: string[],
      warningViolations: string[],
    ): Promise<void> {
      const rows: Array<{ conname: string; definition: string }> = await this.dataSource.query(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = $1
              AND t.relname = $2
              AND c.contype = 'c'`,
        [schema, tableName],
      );
      const dbCount = rows.length;
      const entityCount = entityChecks.length;
      if (dbCount === entityCount) return;
      const entityExprs = entityChecks.map((c) => c.expression.trim()).filter((e) => e.length > 0);
      const dbDefs = rows.map((r) => `${r.conname}: ${r.definition}`);
      if (entityCount > dbCount) {
        const delta = entityCount - dbCount;
        this.route(
          'check_constraint',
          `[${schema}.${tableName}] entity declares ${entityCount} @Check() but DB has ${dbCount} CHECK constraint(s) — ${delta} missing in DB (entity-side: ${entityExprs.join(' ; ')})`,
          errorViolations,
          warningViolations,
        );
      } else {
        const delta = dbCount - entityCount;
        this.route(
          'check_constraint',
          `[${schema}.${tableName}] DB has ${dbCount} CHECK constraint(s) but entity declares ${entityCount} @Check() — ${delta} orphaned in DB (db-side: ${dbDefs.join(' ; ')})`,
          errorViolations,
          warningViolations,
        );
      }
    }

    /**
     * Class K — foreign_key_presence (Faz 1.8 day-one baseline reset).
     *
     * Count-based detection: queries `pg_constraint` for foreign-key
     * constraints (contype='f') on the table, compares cardinality
     * against `entity.foreignKeys.length`. The same coarse-signal
     * pattern as Class G (check_constraint), chosen because PG canon-
     * icalizes FK definitions (referential actions, column ordering,
     * deferrable flag) in ways that defeat string-equality checks at
     * the validator boundary. Faz 6's baseline migration audit + the
     * entity-fingerprint manifest cover the per-FK precision case;
     * here we only need to detect "ledger applied but FK not created"
     * — the regression class the 3-deploy sensor-service
     * AlignSensorEntitySurfaceFks chain surfaced.
     *
     * Excludes FK constraints generated automatically by the
     * @JoinTable() many-to-many bridge — those live on the relation
     * table, not on the owning entity's row in entity.foreignKeys.
     */
    private async scanForeignKeyDrift(
      schema: string,
      tableName: string,
      entityForeignKeys: ReadonlyArray<{ name?: string }>,
      errorViolations: string[],
      warningViolations: string[],
    ): Promise<void> {
      const rows: Array<{ conname: string; definition: string }> = await this.dataSource.query(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = $1
              AND t.relname = $2
              AND c.contype = 'f'`,
        [schema, tableName],
      );
      const dbCount = rows.length;
      const entityCount = entityForeignKeys.length;
      if (dbCount === entityCount) return;

      const dbDefs = rows.map((r) => `${r.conname}: ${r.definition}`).join(' ; ');

      if (entityCount > dbCount) {
        const delta = entityCount - dbCount;
        this.route(
          'foreign_key_presence',
          `[${schema}.${tableName}] entity declares ${entityCount} FK(s) but DB has ${dbCount} foreign-key constraint(s) — ${delta} missing in DB. ` +
            `Likely cause: a CREATE-then-ALTER FK migration with the ALTER step swallowed (HR HealHrEnumTypeDrift class) or a FK addition not yet migrated. ` +
            `DB-side: ${dbDefs}`,
          errorViolations,
          warningViolations,
        );
      } else {
        const delta = dbCount - entityCount;
        this.route(
          'foreign_key_presence',
          `[${schema}.${tableName}] DB has ${dbCount} foreign-key constraint(s) but entity declares ${entityCount} FK(s) — ${delta} orphaned in DB. ` +
            `Likely cause: an FK was dropped from the entity model but the constraint not removed from DB. DB-side: ${dbDefs}`,
          errorViolations,
          warningViolations,
        );
      }
    }
  }

  return SchemaDriftValidator;
}
