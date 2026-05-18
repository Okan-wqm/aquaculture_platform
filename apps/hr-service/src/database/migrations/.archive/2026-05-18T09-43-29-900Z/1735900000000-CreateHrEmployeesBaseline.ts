import { MigrationInterface, QueryRunner } from 'typeorm';
import { pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * CreateHrEmployeesBaseline1735900000000
 * ============================================================================
 *
 * Restores the `hr.employees` table creation step that was lost when the
 * legacy `synchronize: true` boot path was removed in W4-A2. The historical
 * shape was:
 *
 *   1. boot → TypeORM `synchronize` materialises `public.employees`
 *   2. `1786000400000-MoveEmployeesToHr` relocates `public.employees` →
 *      `hr.employees` via `ALTER TABLE … SET SCHEMA hr`.
 *
 * With the synchronize path removed, step (1) no longer happens on
 * fresh-volume bootstraps. Step (2) becomes a guarded no-op (its
 * `IF EXISTS public.employees` check fails on a clean DB), and the next
 * migration in the chain — `1736000000000-CreateHRModuleSchema` — fails on
 * its first FK to `employees(id)` (lines 575, 624, 738, 788, 874, 964,
 * 1005, 1056, 1097) with `relation "employees" does not exist`.
 *
 * # Scope
 *
 *   1. Create the four `hr.*` ENUM types the entity declares idempotently:
 *        employees_status_enum (active | on_leave | terminated | suspended)
 *        employees_employmenttype_enum
 *          (full_time | part_time | contract | seasonal)
 *        employees_department_enum
 *          (operations | maintenance | feeding | quality_control |
 *           administration | management | logistics | security)
 *        employees_personnelcategory_enum (offshore | onshore | hybrid)
 *
 *   2. Create `hr.employees` idempotently with every column declared by
 *      `apps/hr-service/src/hr/entities/employee.entity.ts` — including
 *      audit columns (`createdAt`/`updatedAt`/`version`), soft-delete
 *      columns (`deletedAt`/`isDeleted`), and aquaculture-specific columns
 *      (`personnelCategory`, `assignedWorkAreas`, `seaWorthy`,
 *      `currentRotationId`, `timezone`).
 *
 *   3. Create the ten composite + single-column indexes the entity declares
 *      via `@Index(...)` on the class.
 *
 * # Why timestamp columns are `timestamptz` from birth
 *
 * The platform-wide invariant standardises on `timestamptz` for every
 * cross-process timestamp. The auth/farm baselines emit `timestamptz`
 * directly so that subsequent timestamp-conversion migrations (e.g.
 * `1781100000000-ConvertTimestampToTimestamptz`) become per-table no-ops on
 * fresh DBs via their `information_schema.columns` pre-checks. This
 * baseline follows the same pattern.
 *
 * # Why `tenantId` is `uuid` from birth
 *
 * The 2026-04-07 split-brain incident root cause was implicit `varchar(255)`
 * for trust-critical UUID columns. The data-expert UUID invariant requires
 * `uuid` for `tenantId` on every tenant-schema entity. Emitting `uuid`
 * directly in this baseline aligns with the auth/farm baselines and means
 * any future tenantId-converge migration sees the column already-uuid and
 * skips cleanly.
 *
 * # Why `nationalId`/`bankDetails` are `text`
 *
 * Both columns carry an application-layer `createEncryptedColumnTransformer`
 * (AES-256-GCM, optional JSON-pre-stringify). Encryption is transparent to
 * the database — the column stores ciphertext as `text`. The DB column
 * type stays `text` regardless of whether the application reads
 * `string` or `BankDetails`.
 *
 * # Why `simple-array` columns are `text`, not `text[]`
 *
 * `@Column('simple-array', …)` instructs TypeORM to serialise the array as
 * a comma-separated `text` value at the column boundary (the application
 * splits/joins on read/write). It is NOT a Postgres array. The auth
 * baseline's `webauthn_credentials.transports` column documents the same
 * `simple-array` → `text` mapping. Using `text[]` here would cause a
 * boot-time SchemaDriftValidator mismatch.
 *
 * # Schema qualification
 *
 * Every object name is qualified with `hr.` rather than relying on
 * search_path. The MigrationRunnerService pins `search_path = hr, public`
 * before each migration AND `pinSearchPath()` re-asserts the pin at the
 * top of `up()`, but explicit qualification is the Tier-1 defence-in-depth
 * floor against any future search_path leak — and matches the pattern
 * already used by `apps/auth-service/src/migrations/1700000000000-
 * CreateInitialSchema.ts` and `apps/farm-service/src/database/migrations/
 * 1700000000000-CreateInitialSchema.ts`.
 *
 * # Idempotency
 *
 * Every DDL uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
 * EXISTS`, and `DO $$ … EXCEPTION WHEN duplicate_object` for ENUM types.
 * A re-run is a no-op. This is required because the migration runner
 * replays pending migrations on every cold start until the ledger logs
 * success — partial first-run failures must not corner the next attempt.
 *
 * # Why this is NOT a `synchronize: true` resurrection
 *
 * The architectural anti-pattern that caused the original drift was
 * letting TypeORM's runtime DDL emitter create `public.employees` on the
 * fly during application boot — DDL outside the migration ledger, no
 * audit trail, schema-tied to whatever the live entity happened to declare
 * at that boot. This baseline migration codifies the canonical shape
 * inside the migration ledger, in the correct schema, before the FK
 * dependency chain (1736000000000+) needs it. SchemaDriftValidator's
 * entity-vs-DB reconciliation later in `1786800000000-SyncHrEntitiesToDb`
 * remains the source of truth for downstream column drift.
 *
 * # Relationship to MoveEmployeesToHr1786000400000
 *
 * That migration is preserved unchanged. On a fresh DB it observes
 * `hr.employees` already present (created by THIS migration) and skips
 * the move via its `IF EXISTS public.employees AND NOT EXISTS hr.employees`
 * gate. On legacy droplets where `public.employees` survives, that
 * migration still performs the move; this baseline's
 * `CREATE TABLE IF NOT EXISTS hr.employees` runs first and the move is
 * skipped. Both bootstrap paths converge on the canonical end state.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class CreateHrEmployeesBaseline1735900000000
  implements MigrationInterface
{
  name = 'CreateHrEmployeesBaseline1735900000000';

  public async up(qr: QueryRunner): Promise<void> {
    // Re-assert the search_path pin set by MigrationRunnerService. This
    // also defends the migration when invoked via `npm run typeorm --
    // migration:run` (developer CLI) or hand-applied SQL — paths where the
    // runner's pin is absent. `pinSearchPath` validates the schema name
    // and verifies via `current_schema()` that the pin took effect.
    await pinSearchPath(qr, 'hr');

    // Defensive — `infrastructure/docker/init-scripts` create the schema,
    // but this baseline must self-heal on bare CLI bootstrap.
    await qr.query(`CREATE SCHEMA IF NOT EXISTS hr`);

    await this.createEnumTypes(qr);
    await this.createEmployeesTable(qr);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Reverse order: drop the table first (cascades any dependent
    // constraints from later migrations), then drop the enum types.
    // CASCADE on the enum drops is required because subsequent migrations
    // may have added columns that reference these types — without CASCADE
    // the DROP TYPE would fail with `42P0A` cannot drop type because
    // other objects depend on it.
    await qr.query(`DROP TABLE IF EXISTS hr.employees CASCADE`);

    const enumTypes: readonly string[] = [
      'employees_personnelcategory_enum',
      'employees_department_enum',
      'employees_employmenttype_enum',
      'employees_status_enum',
    ];
    for (const enumName of enumTypes) {
      await qr.query(`DROP TYPE IF EXISTS hr."${enumName}" CASCADE`);
    }
  }

  /**
   * Create the four enum types the Employee entity declares. Names follow
   * TypeORM's `{table}_{column}_enum` lower-cased auto-generation
   * convention (matches `SchemaDriftValidator.resolveEnumTypeName`).
   *
   * `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL` is the canonical
   * idempotency idiom — Postgres has no `IF NOT EXISTS` for `CREATE TYPE`.
   * The narrow `duplicate_object` class avoids R5 (overbroad-exception-
   * catch) lint failures.
   */
  private async createEnumTypes(qr: QueryRunner): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      {
        name: 'employees_status_enum',
        values: ['active', 'on_leave', 'terminated', 'suspended'],
      },
      {
        name: 'employees_employmenttype_enum',
        values: ['full_time', 'part_time', 'contract', 'seasonal'],
      },
      {
        name: 'employees_department_enum',
        values: [
          'operations',
          'maintenance',
          'feeding',
          'quality_control',
          'administration',
          'management',
          'logistics',
          'security',
        ],
      },
      {
        name: 'employees_personnelcategory_enum',
        values: ['offshore', 'onshore', 'hybrid'],
      },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await qr.query(`
        DO $$ BEGIN
          CREATE TYPE hr."${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  /**
   * Create `hr.employees` plus its ten declared indexes in a single
   * `qr.query()` chunk so migration-sql-lint R3 recognises the
   * just-created-table exemption (the table is empty at index-creation
   * time and the chunk replays cleanly under `IF NOT EXISTS`).
   *
   * Column shapes derive directly from the entity:
   *   - `@PrimaryGeneratedColumn('uuid')` → `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   *   - `@Column()` on a `string` → `varchar` (TypeORM default)
   *   - `@Column('jsonb')` → `jsonb`
   *   - `@Column({ type: 'date' })` → `date`
   *   - `@Column({ type: 'enum', enum: …, default: … })` → `hr.<enum>`
   *   - `@Column({ type: 'decimal', precision: …, scale: … })` →
   *     `decimal(p, s)` (DecimalTransformer is application-layer; DB
   *     stores arbitrary-precision decimal as documented)
   *   - `@Column('simple-array', …)` → `text` (comma-separated)
   *   - `@CreateDateColumn` / `@UpdateDateColumn` → `timestamptz NOT NULL DEFAULT NOW()`
   *   - `@VersionColumn` → `integer NOT NULL DEFAULT 1`
   *
   * Indexes follow the entity's `@Index(...)` decorators verbatim.
   * Composite indexes that start with `tenantId` deliberately serve
   * single-column `tenantId` lookups via leftmost-prefix matching —
   * mirroring the DB-MEDIUM-002 redundancy decision encoded in the entity.
   */
  private async createEmployeesTable(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS hr.employees (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "employeeNumber" varchar NOT NULL,
        "firstName" varchar NOT NULL,
        "lastName" varchar NOT NULL,
        "email" varchar NOT NULL,
        "contactInfo" jsonb NOT NULL,
        "address" jsonb NOT NULL,
        "dateOfBirth" date NOT NULL,
        "nationalId" text NOT NULL,
        "status" hr.employees_status_enum NOT NULL DEFAULT 'active',
        "employmentType" hr.employees_employmenttype_enum NOT NULL,
        "department" hr.employees_department_enum NOT NULL,
        "position" varchar NOT NULL,
        "hireDate" date NOT NULL,
        "terminationDate" date,
        "baseSalary" decimal(12, 2) NOT NULL,
        "currency" varchar NOT NULL DEFAULT 'USD',
        "bankDetails" text,
        "farmId" varchar,
        "supervisorId" varchar,
        "userId" varchar,
        "certifications" text,
        "skills" text,
        "personnelCategory" hr.employees_personnelcategory_enum,
        "assignedWorkAreas" text,
        "seaWorthy" boolean NOT NULL DEFAULT false,
        "positionId" varchar,
        "departmentHrId" varchar,
        "emergencyInfo" jsonb,
        "currentRotationId" uuid,
        "timezone" varchar(50) DEFAULT 'UTC',
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" varchar,
        "updatedBy" varchar,
        "version" integer NOT NULL DEFAULT 1,
        "deletedAt" timestamptz,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "isFarmWorker" boolean NOT NULL DEFAULT false
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_employee_email_tenant"
        ON hr.employees ("tenantId", "email");
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_employee_number_tenant"
        ON hr.employees ("employeeNumber", "tenantId");
      CREATE INDEX IF NOT EXISTS "idx_employee_email"
        ON hr.employees ("email");
      CREATE INDEX IF NOT EXISTS "idx_employee_department"
        ON hr.employees ("departmentHrId");
      CREATE INDEX IF NOT EXISTS "idx_employee_status_tenant"
        ON hr.employees ("status", "tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_employees_tenantId_department"
        ON hr.employees ("tenantId", "department");
      CREATE INDEX IF NOT EXISTS "IDX_employees_tenantId_departmentHrId"
        ON hr.employees ("tenantId", "departmentHrId");
      CREATE INDEX IF NOT EXISTS "IDX_employees_tenantId_farmId"
        ON hr.employees ("tenantId", "farmId");
      CREATE INDEX IF NOT EXISTS "IDX_employees_tenantId_personnelCategory"
        ON hr.employees ("tenantId", "personnelCategory");
      CREATE INDEX IF NOT EXISTS "IDX_employees_tenantId_seaWorthy"
        ON hr.employees ("tenantId", "seaWorthy");
    `);
  }
}
