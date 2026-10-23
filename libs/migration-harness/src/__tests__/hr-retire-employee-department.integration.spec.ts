/**
 * RetireEmployeeLegacyDepartment (hr-service 1802500000000) on a real PostgreSQL.
 * ============================================================================
 *
 * The migration moves data across tenants under a FORCEd row-level-security
 * policy with no tenant bound: a backfill written without the transaction-local
 * bypass sees zero rows and "succeeds". Mock-driven specs cannot tell that
 * from a working migration, so this one replays the REAL hr-service migration
 * chain (Baseline .. 1802500000000), in schema `hr`, as a non-superuser table
 * owner. A superuser would bypass RLS and hide exactly the failure this guards.
 * This spec, not `db-migration-check.yml` (which migrates a fresh database with
 * no legacy employees), is what verifies the backfill data.
 *
 * What it proves, in order (one container, one chain replay):
 *   1. every live, unplaced employee gets a department — an existing live
 *      department with the legacy code is reused, a soft-deleted one is revived,
 *      a missing one is inserted company-wide and marked for `down`;
 *   2. a department whose code differs from the legacy label only in letter case
 *      ('Maintenance', 'Quality_Control') is recognised, never duplicated, and its
 *      code is left as the tenant spelled it; a live case variant wins over a
 *      soft-deleted one, which is not revived;
 *   3. when several case variants match, ONE department is chosen by a total order
 *      (exact upper-case code, then oldest, then lowest id) and the same one is
 *      chosen again on every replay, whatever the physical row order;
 *   4. the attendance snapshot (`attendance_records."departmentId"`) of an employee
 *      the migration placed is filled where it was NULL; a snapshot already set, and
 *      the records of employees it did not place, are untouched;
 *   5. an admin's placement, a soft-deleted employee and other tenants are
 *      untouched (a department is never shared across tenants);
 *   6. the retired column accepts a NULL afterwards and its index is gone;
 *   7. replaying `up` changes nothing;
 *   8. `down` re-imposes NOT NULL, rebuilds the index and removes exactly the
 *      departments `up` inserted that nothing references, attendance included.
 *
 * The migration directory is read from the repository by path, so a CI run only
 * reaches this spec when the harness is affected — keep it in step with the
 * migration when either changes.
 */
import { readdirSync } from 'fs';
import { join } from 'path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

import { bootPostgresContainer, shutdownHarness, type HarnessContext } from '../setup';

import { expectHarnessContext, queryRequiredRow, queryRows } from './test-helpers';

const MIGRATIONS_DIR = join(__dirname, '../../../../apps/hr-service/src/database/migrations');
const TARGET_FILE = '1802500000000-RetireEmployeeLegacyDepartment.ts';
const LEGACY_INDEX = 'IDX_c0e4b9f3e9e82b05072fce2069';
const BACKFILL_MARKER = 'Backfilled by migration 1802500000000:';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
/** Holds departments whose code differs from the legacy label only in letter case. */
const TENANT_C = '33333333-3333-4333-8333-333333333333';
/** Holds several case variants for one label, so the choice between them is visible. */
const TENANT_D = '44444444-4444-4444-8444-444444444444';

type HrMigration = MigrationInterface & {
  postCondition?: (qr: QueryRunner) => Promise<boolean>;
  transaction?: boolean;
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^[0-9]+-.*\.ts$/.test(file))
    .sort();
}

async function instantiate(file: string): Promise<HrMigration> {
  // Loaded by path at run time: the migrations are the unit under test, not a dependency.
  const loaded: unknown = await import(join(MIGRATIONS_DIR, file));
  const exported = typeof loaded === 'object' && loaded !== null ? Object.values(loaded) : [];
  for (const candidate of exported) {
    if (typeof candidate === 'function') {
      // The migration module exports exactly one class; every migration has a no-arg constructor.
      return new (candidate as new () => HrMigration)();
    }
  }
  throw new Error(`${file} exports no migration class`);
}

/** Runs one migration the way the runner does: its own transaction, postCondition inside it. */
async function runInTransaction(
  qr: QueryRunner,
  file: string,
  direction: 'up' | 'down' = 'up',
): Promise<void> {
  const migration = await instantiate(file);
  await qr.startTransaction();
  try {
    await migration[direction](qr);
    if (direction === 'up' && migration.postCondition !== undefined) {
      if (!(await migration.postCondition(qr))) throw new Error(`postCondition false: ${file}`);
    }
    await qr.commitTransaction();
  } catch (error) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw new Error(
      `${file} ${direction}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Session-level so seeding and assertions can see rows; the migration sets its own, transaction-local. */
async function setBypass(qr: QueryRunner, on: boolean): Promise<void> {
  await qr.query(`SELECT set_config('app.bypass_rls', '${on ? 'on' : 'off'}', false)`);
}

let employeeSequence = 0;
let attendanceSequence = 0;

interface DepartmentSeed {
  readonly deleted?: boolean;
  /** Fixed id, to make the lowest-id tie-break observable. */
  readonly id?: string;
  /** Fixed `createdAt`, to make the oldest-first rule observable. */
  readonly createdAt?: string;
}

async function addDepartment(
  qr: QueryRunner,
  tenantId: string,
  code: string,
  seed: DepartmentSeed = {},
): Promise<string> {
  const row = await queryRequiredRow<{ id: string }>(
    qr,
    `INSERT INTO departments_hr ("id", "tenantId", "name", "code", "isDeleted", "createdAt", "version")
     VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, COALESCE($6::timestamp, now()), 1)
     RETURNING id`,
    [seed.id ?? null, tenantId, code, code, seed.deleted === true, seed.createdAt ?? null],
  );
  return row.id;
}

async function addEmployee(
  qr: QueryRunner,
  tenantId: string,
  legacyDepartment: string | null,
  options: { deleted?: boolean; departmentHrId?: string } = {},
): Promise<string> {
  employeeSequence += 1;
  const row = await queryRequiredRow<{ id: string }>(
    qr,
    `INSERT INTO employees ("tenantId", "employeeNumber", "firstName", "lastName", "email",
        "contactInfo", "address", "dateOfBirth", "nationalId", "employmentType", "department",
        "position", "hireDate", "baseSalary", "version", "isDeleted", "departmentHrId")
     VALUES ($1, $2, 'First', 'Last', $3, '{}', '{}', '1990-01-01', 'national-id', 'full_time',
        $4::hr.employees_department_enum, 'position', '2024-01-01', 1, 1, $5, $6)
     RETURNING id`,
    [
      tenantId,
      `EMP-${employeeSequence}`,
      `employee-${employeeSequence}@example.test`,
      legacyDepartment,
      options.deleted === true,
      options.departmentHrId ?? null,
    ],
  );
  return row.id;
}

/** One attendance record with the department snapshot `departmentId` (NULL = taken before the employee had one). */
async function addAttendance(
  qr: QueryRunner,
  tenantId: string,
  employeeId: string,
  date: string,
  departmentId: string | null,
): Promise<string> {
  attendanceSequence += 1;
  const row = await queryRequiredRow<{ id: string }>(
    qr,
    `INSERT INTO attendance_records ("tenantId", "recordNumber", "employeeId", "date", "departmentId", "version")
     VALUES ($1, $2, $3, $4, $5, 1) RETURNING id`,
    [tenantId, `ATT-${attendanceSequence}`, employeeId, date, departmentId],
  );
  return row.id;
}

interface EmployeeRow extends Record<string, unknown> {
  id: string;
  tenantId: string;
  departmentHrId: string | null;
  department: string | null;
}

interface DepartmentRow extends Record<string, unknown> {
  id: string;
  tenantId: string;
  code: string;
  isDeleted: boolean;
  description: string | null;
  moduleCode: string | null;
}

describe('hr-service 1802500000000 RetireEmployeeLegacyDepartment (real Postgres, forced RLS)', () => {
  let ctx: HarnessContext | undefined;
  let qr: QueryRunner;
  let previousAuthority: string | undefined;

  // Seed handles
  let existingOperationsA = '';
  let softDeletedManagementA = '';
  let adminDepartmentA = '';
  let insertedFeedingDepartmentA = '';
  let insertedQualityControlDepartmentA = '';
  let employees = {
    operations1: '',
    operations2: '',
    management: '',
    feeding: '',
    qualityControl: '',
    adminPlaced: '',
    softDeleted: '',
    tenantB: '',
    // tenant C: the department exists, spelled differently
    maintenanceC: '',
    qualityControlC: '',
    managementC: '',
    // tenant D: several case variants match
    administrationD: '',
    securityD: '',
    logisticsD: '',
    feedingD: '',
  };
  // Tenant C departments.
  let departmentsC = {
    maintenanceLive: '',
    qualityControlDeleted: '',
    managementLive: '',
    managementDeletedUpper: '',
  };
  // Tenant D departments; the comment on each says why it is (not) the chosen one.
  let departmentsD = {
    administrationLower: '', // oldest, but not the exact upper-case code
    administrationTitle: '',
    administrationUpper: '', // newest, but the exact upper-case code: chosen
    securityTitle: '', // newer, lowest id
    securityLower: '', // OLDEST, highest id: chosen (oldest outranks lowest id)
    logisticsLower: '', // same createdAt, highest id
    logisticsTitle: '', // same createdAt, LOWEST id: chosen
    feedingDeletedTitle: '', // soft-deleted, older: the one revived
    feedingDeletedLower: '', // soft-deleted, newer: stays deleted
  };
  let attendance = {
    operationsNull: '',
    operationsKept: '',
    qualityControlNull: '',
    adminPlacedNull: '',
    softDeletedNull: '',
  };

  async function employeeById(id: string): Promise<EmployeeRow> {
    return queryRequiredRow<EmployeeRow>(
      qr,
      `SELECT id, "tenantId", "departmentHrId", department::text AS department FROM employees WHERE id = $1`,
      [id],
    );
  }

  async function departmentById(id: string): Promise<DepartmentRow> {
    return queryRequiredRow<DepartmentRow>(
      qr,
      `SELECT id, "tenantId", code, "isDeleted", description, "moduleCode" FROM departments_hr WHERE id = $1`,
      [id],
    );
  }

  async function departmentCount(): Promise<number> {
    const row = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM departments_hr`,
    );
    return Number(row.n);
  }

  async function departmentCountOf(tenantId: string): Promise<number> {
    const row = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM departments_hr WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(row.n);
  }

  async function snapshotOf(attendanceId: string): Promise<string | null> {
    const row = await queryRequiredRow<{ departmentId: string | null }>(
      qr,
      `SELECT "departmentId" FROM attendance_records WHERE id = $1`,
      [attendanceId],
    );
    return row.departmentId;
  }

  /** Every attendance record's snapshot, by record id: what "nothing changed" is compared against. */
  async function allSnapshots(): Promise<Record<string, string | null>> {
    const rows = await queryRows<{ id: string; departmentId: string | null }>(
      qr,
      `SELECT id, "departmentId" FROM attendance_records ORDER BY id`,
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.departmentId]));
  }

  async function linkOf(employeeId: string): Promise<string | null> {
    return (await employeeById(employeeId)).departmentHrId;
  }

  async function runUp(): Promise<void> {
    await setBypass(qr, false);
    await runInTransaction(qr, TARGET_FILE);
    await setBypass(qr, true);
  }

  beforeAll(async () => {
    // The Baseline arms tenant RLS through the db-migrate provisioner's authority.
    previousAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';

    ctx = await bootPostgresContainer();
    qr = expectHarnessContext(ctx).dataSource.createQueryRunner();

    // Superuser prep, then everything as a NON-superuser owner so the FORCEd policy applies.
    await qr.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await qr.query(
      `DO $$ BEGIN CREATE ROLE hr_owner LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    );
    await qr.query(`GRANT USAGE, CREATE ON SCHEMA public TO hr_owner`);
    await qr.query(
      `DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO hr_owner', current_database()); END $$`,
    );
    await qr.query(`CREATE SCHEMA hr AUTHORIZATION hr_owner`);
    await qr.query(`SET ROLE hr_owner`);
    await qr.query(`SELECT set_config('search_path', 'hr,public', false)`);

    // Replay everything BEFORE the target by position: a later hr migration must not break this spec.
    const files = migrationFiles();
    const targetIndex = files.indexOf(TARGET_FILE);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    for (const file of files.slice(0, targetIndex)) await runInTransaction(qr, file);

    // Legacy state: four tenants, every shape the migration must handle.
    await setBypass(qr, true);
    existingOperationsA = await addDepartment(qr, TENANT_A, 'OPERATIONS');
    softDeletedManagementA = await addDepartment(qr, TENANT_A, 'MANAGEMENT', { deleted: true });
    adminDepartmentA = await addDepartment(qr, TENANT_A, 'CUSTOM');

    // Tenant C: the department exists, but spelled with another letter case.
    departmentsC = {
      maintenanceLive: await addDepartment(qr, TENANT_C, 'Maintenance'),
      qualityControlDeleted: await addDepartment(qr, TENANT_C, 'Quality_Control', {
        deleted: true,
      }),
      managementLive: await addDepartment(qr, TENANT_C, 'Management'),
      // Exact upper-case code, but soft-deleted while a live variant exists: must neither be
      // revived nor linked.
      managementDeletedUpper: await addDepartment(qr, TENANT_C, 'MANAGEMENT', { deleted: true }),
    };

    // Tenant D: several case variants of one label. Fixed ids and createdAt make each rule observable.
    departmentsD = {
      administrationLower: await addDepartment(qr, TENANT_D, 'administration', {
        createdAt: '2024-01-01T00:00:00',
      }),
      administrationTitle: await addDepartment(qr, TENANT_D, 'Administration', {
        createdAt: '2024-01-02T00:00:00',
      }),
      administrationUpper: await addDepartment(qr, TENANT_D, 'ADMINISTRATION', {
        createdAt: '2024-01-03T00:00:00',
      }),
      securityTitle: await addDepartment(qr, TENANT_D, 'Security', {
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: '2024-02-02T00:00:00',
      }),
      securityLower: await addDepartment(qr, TENANT_D, 'security', {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        createdAt: '2024-02-01T00:00:00',
      }),
      logisticsLower: await addDepartment(qr, TENANT_D, 'logistics', {
        id: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
        createdAt: '2024-03-01T00:00:00',
      }),
      logisticsTitle: await addDepartment(qr, TENANT_D, 'Logistics', {
        id: '00000000-0000-4000-8000-000000000002',
        createdAt: '2024-03-01T00:00:00',
      }),
      feedingDeletedTitle: await addDepartment(qr, TENANT_D, 'Feeding', {
        deleted: true,
        createdAt: '2024-04-01T00:00:00',
      }),
      feedingDeletedLower: await addDepartment(qr, TENANT_D, 'feeding', {
        deleted: true,
        createdAt: '2024-04-02T00:00:00',
      }),
    };

    employees = {
      operations1: await addEmployee(qr, TENANT_A, 'operations'),
      operations2: await addEmployee(qr, TENANT_A, 'operations'),
      management: await addEmployee(qr, TENANT_A, 'management'),
      feeding: await addEmployee(qr, TENANT_A, 'feeding'),
      qualityControl: await addEmployee(qr, TENANT_A, 'quality_control'),
      adminPlaced: await addEmployee(qr, TENANT_A, 'security', {
        departmentHrId: adminDepartmentA,
      }),
      softDeleted: await addEmployee(qr, TENANT_A, 'logistics', { deleted: true }),
      tenantB: await addEmployee(qr, TENANT_B, 'operations'),
      maintenanceC: await addEmployee(qr, TENANT_C, 'maintenance'),
      qualityControlC: await addEmployee(qr, TENANT_C, 'quality_control'),
      managementC: await addEmployee(qr, TENANT_C, 'management'),
      administrationD: await addEmployee(qr, TENANT_D, 'administration'),
      securityD: await addEmployee(qr, TENANT_D, 'security'),
      logisticsD: await addEmployee(qr, TENANT_D, 'logistics'),
      feedingD: await addEmployee(qr, TENANT_D, 'feeding'),
    };

    // Attendance taken before anyone had a department: the snapshot is NULL.
    attendance = {
      operationsNull: await addAttendance(qr, TENANT_A, employees.operations1, '2024-05-01', null),
      // A snapshot that is already set (to some other department) must survive.
      operationsKept: await addAttendance(
        qr,
        TENANT_A,
        employees.operations1,
        '2024-05-02',
        adminDepartmentA,
      ),
      qualityControlNull: await addAttendance(
        qr,
        TENANT_A,
        employees.qualityControl,
        '2024-05-01',
        null,
      ),
      // Employees this migration does NOT place: their NULL snapshots are none of its business.
      adminPlacedNull: await addAttendance(qr, TENANT_A, employees.adminPlaced, '2024-05-01', null),
      softDeletedNull: await addAttendance(qr, TENANT_A, employees.softDeleted, '2024-05-01', null),
    };
    await setBypass(qr, false);
  }, 240_000);

  afterAll(async () => {
    if (previousAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
    else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousAuthority;
    if (qr !== undefined) {
      await qr.query(`RESET ROLE`).catch(() => undefined);
      await qr.release();
    }
    await shutdownHarness(ctx);
  }, 60_000);

  it('starts blind and strict: no tenant bound sees no rows, and department is NOT NULL', async () => {
    const visible = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM employees`,
    );
    expect(visible.n).toBe('0');

    await setBypass(qr, true);
    await expect(
      qr.query(
        `INSERT INTO employees ("tenantId", "employeeNumber", "firstName", "lastName", "email",
            "contactInfo", "address", "dateOfBirth", "nationalId", "employmentType", "position",
            "hireDate", "baseSalary", "version")
         VALUES ('${TENANT_A}', 'NO-DEPT', 'F', 'L', 'no-dept@example.test', '{}', '{}',
            '1990-01-01', 'x', 'full_time', 'p', '2024-01-01', 1, 1)`,
      ),
    ).rejects.toThrow(/department/);
    await setBypass(qr, false);
  });

  it('places every live unplaced employee by reusing, reviving or inserting a department', async () => {
    await runInTransaction(qr, TARGET_FILE);
    await setBypass(qr, true);

    expect((await employeeById(employees.operations1)).departmentHrId).toBe(existingOperationsA);
    expect((await employeeById(employees.operations2)).departmentHrId).toBe(existingOperationsA);

    const revived = await employeeById(employees.management);
    expect(revived.departmentHrId).toBe(softDeletedManagementA);
    expect((await departmentById(softDeletedManagementA)).isDeleted).toBe(false);

    const feedingLink = (await employeeById(employees.feeding)).departmentHrId;
    expect(feedingLink).not.toBeNull();
    insertedFeedingDepartmentA = feedingLink ?? '';
    const inserted = await departmentById(insertedFeedingDepartmentA);
    expect(inserted).toMatchObject({ code: 'FEEDING', tenantId: TENANT_A, moduleCode: null });
    expect(inserted.description?.startsWith(BACKFILL_MARKER)).toBe(true);

    // Underscore labels become a code and a readable name too.
    const qualityControlLink = await linkOf(employees.qualityControl);
    expect(qualityControlLink).not.toBeNull();
    insertedQualityControlDepartmentA = qualityControlLink ?? '';
    expect(await departmentById(insertedQualityControlDepartmentA)).toMatchObject({
      code: 'QUALITY_CONTROL',
      tenantId: TENANT_A,
      moduleCode: null,
    });
  });

  it('leaves an admin placement, a soft-deleted employee and other tenants alone', async () => {
    expect((await employeeById(employees.adminPlaced)).departmentHrId).toBe(adminDepartmentA);
    expect((await employeeById(employees.softDeleted)).departmentHrId).toBeNull();

    const tenantBLink = (await employeeById(employees.tenantB)).departmentHrId;
    expect(tenantBLink).not.toBeNull();
    const tenantBDepartment = await departmentById(tenantBLink ?? '');
    expect(tenantBDepartment.tenantId).toBe(TENANT_B);
    expect(tenantBDepartment.id).not.toBe(existingOperationsA);

    const all = await queryRows<{ tenantId: string; code: string }>(
      qr,
      `SELECT "tenantId", code FROM departments_hr`,
    );
    const keys = all.map((row) => `${row.tenantId}|${row.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('recognises a department whose code differs only in letter case: reuses a live one, revives a soft-deleted one, inserts none', async () => {
    // Live 'Maintenance' is the department for the legacy label 'maintenance': reused, not duplicated.
    expect(await linkOf(employees.maintenanceC)).toBe(departmentsC.maintenanceLive);

    // Soft-deleted 'Quality_Control' is revived in place (no 'QUALITY_CONTROL' beside it).
    expect(await linkOf(employees.qualityControlC)).toBe(departmentsC.qualityControlDeleted);
    expect(await departmentById(departmentsC.qualityControlDeleted)).toMatchObject({
      isDeleted: false,
      code: 'Quality_Control',
    });

    // A live variant wins over a soft-deleted exact-code row, which is neither linked nor revived.
    expect(await linkOf(employees.managementC)).toBe(departmentsC.managementLive);
    expect((await departmentById(departmentsC.managementDeletedUpper)).isDeleted).toBe(true);

    // The codes stay as the tenant spelled them, and nothing was inserted for the tenant.
    expect(await departmentCountOf(TENANT_C)).toBe(4);
    const codes = await queryRows<{ code: string }>(
      qr,
      `SELECT code FROM departments_hr WHERE "tenantId" = $1`,
      [TENANT_C],
    );
    // Sorted in JS (code-unit order), not by the database's collation.
    expect(codes.map((row) => row.code).sort()).toEqual([
      'MANAGEMENT',
      'Maintenance',
      'Management',
      'Quality_Control',
    ]);
    const marked = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM departments_hr WHERE "tenantId" = $1 AND description LIKE '${BACKFILL_MARKER}%'`,
      [TENANT_C],
    );
    expect(marked.n).toBe('0');
  });

  it('chooses one department among several case variants: exact upper-case code, then oldest, then lowest id', async () => {
    // 'ADMINISTRATION' is the newest of three, but it is the exact upper-case code.
    expect(await linkOf(employees.administrationD)).toBe(departmentsD.administrationUpper);
    // Neither 'Security' nor 'security' is exact: the OLDEST wins although its id is the highest.
    expect(await linkOf(employees.securityD)).toBe(departmentsD.securityLower);
    // Same createdAt: the lowest id wins, though it is not the lower-case spelling.
    expect(await linkOf(employees.logisticsD)).toBe(departmentsD.logisticsTitle);

    // Only ONE of two soft-deleted variants is revived (the older); the other stays deleted.
    expect(await linkOf(employees.feedingD)).toBe(departmentsD.feedingDeletedTitle);
    expect((await departmentById(departmentsD.feedingDeletedTitle)).isDeleted).toBe(false);
    expect((await departmentById(departmentsD.feedingDeletedLower)).isDeleted).toBe(true);

    expect(await departmentCountOf(TENANT_D)).toBe(9);
  });

  it('chooses the same department again on every replay, whatever order the rows are stored in', async () => {
    const expected = {
      administrationD: departmentsD.administrationUpper,
      securityD: departmentsD.securityLower,
      logisticsD: departmentsD.logisticsTitle,
      feedingD: departmentsD.feedingDeletedTitle,
    };

    for (let replay = 1; replay <= 3; replay += 1) {
      // Unplace the tenant's employees, and rewrite its department rows one by one in the reverse of
      // their stored order, so a choice that depended on scan order would have a chance to change.
      await qr.query(`UPDATE employees SET "departmentHrId" = NULL WHERE "tenantId" = $1`, [
        TENANT_D,
      ]);
      const stored = await queryRows<{ id: string }>(
        qr,
        `SELECT id FROM departments_hr WHERE "tenantId" = $1 ORDER BY ctid`,
        [TENANT_D],
      );
      for (const { id } of [...stored].reverse()) {
        await qr.query(`UPDATE departments_hr SET "sortOrder" = "sortOrder" WHERE id = $1`, [id]);
      }

      await runUp();

      expect({
        administrationD: await linkOf(employees.administrationD),
        securityD: await linkOf(employees.securityD),
        logisticsD: await linkOf(employees.logisticsD),
        feedingD: await linkOf(employees.feedingD),
      }).toEqual(expected);
    }
    expect(await departmentCountOf(TENANT_D)).toBe(9);
  });

  it('snapshots the new placement onto the NULL attendance records of the employees it placed, and nothing else', async () => {
    // Placed by this migration: the record that had no department now has the employee's.
    expect(await snapshotOf(attendance.operationsNull)).toBe(existingOperationsA);
    expect(await snapshotOf(attendance.qualityControlNull)).toBe(insertedQualityControlDepartmentA);

    // A snapshot that was already set is not rewritten, even though its employee was placed.
    expect(await snapshotOf(attendance.operationsKept)).toBe(adminDepartmentA);

    // Employees the migration did not place keep their records as they were.
    expect(await snapshotOf(attendance.adminPlacedNull)).toBeNull();
    expect(await snapshotOf(attendance.softDeletedNull)).toBeNull();
  });

  it('keeps the legacy value, accepts a NULL department and drops the legacy index', async () => {
    expect((await employeeById(employees.operations1)).department).toBe('operations');

    await qr.query(
      `INSERT INTO employees ("tenantId", "employeeNumber", "firstName", "lastName", "email",
          "contactInfo", "address", "dateOfBirth", "nationalId", "employmentType", "position",
          "hireDate", "baseSalary", "version")
       VALUES ('${TENANT_A}', 'NO-DEPT-AFTER', 'F', 'L', 'no-dept-after@example.test', '{}', '{}',
          '1990-01-01', 'x', 'full_time', 'p', '2024-01-01', 1, 1)`,
    );

    const index = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM pg_indexes WHERE schemaname = 'hr' AND indexname = '${LEGACY_INDEX}'`,
    );
    expect(index.n).toBe('0');
  });

  it('a re-run also places an employee an old container created after the first run, and snapshots their records', async () => {
    // Blue-green: an old container can still create `department`-only employees after the migration.
    const late = await addEmployee(qr, TENANT_A, 'operations');
    const lateRecord = await addAttendance(qr, TENANT_A, late, '2024-06-01', null);

    await runUp();

    expect(await linkOf(late)).toBe(existingOperationsA);
    expect(await snapshotOf(lateRecord)).toBe(existingOperationsA);
  });

  it('is idempotent: replaying up changes no department and no attendance snapshot', async () => {
    const departmentsBefore = await departmentCount();
    const snapshotsBefore = await allSnapshots();
    const linksBefore = await queryRows<{ id: string; departmentHrId: string | null }>(
      qr,
      `SELECT id, "departmentHrId" FROM employees ORDER BY id`,
    );

    await runUp();

    expect(await departmentCount()).toBe(departmentsBefore);
    expect(await allSnapshots()).toEqual(snapshotsBefore);
    expect(
      await queryRows<{ id: string; departmentHrId: string | null }>(
        qr,
        `SELECT id, "departmentHrId" FROM employees ORDER BY id`,
      ),
    ).toEqual(linksBefore);
  });

  it('down re-imposes NOT NULL, rebuilds the index and removes the departments up inserted that nothing uses', async () => {
    // After `up`, an admin creates an employee (no legacy value) and places them in the department
    // `up` inserted for FEEDING. `down` must not take that placement away.
    await setBypass(qr, true);
    const placedAfterUp = await addEmployee(qr, TENANT_A, null, {
      departmentHrId: insertedFeedingDepartmentA,
    });
    await setBypass(qr, false);

    await runInTransaction(qr, TARGET_FILE, 'down');
    await setBypass(qr, true);

    const nulls = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM employees WHERE department IS NULL`,
    );
    expect(nulls.n).toBe('0');

    const column = await queryRequiredRow<{ is_nullable: string }>(
      qr,
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'hr' AND table_name = 'employees' AND column_name = 'department'`,
    );
    expect(column.is_nullable).toBe('NO');

    const index = await queryRequiredRow<{ n: string }>(
      qr,
      `SELECT count(*)::text AS n FROM pg_indexes WHERE schemaname = 'hr' AND indexname = '${LEGACY_INDEX}'`,
    );
    expect(index.n).toBe('1');

    // The admin's placement survives, and the department it points to survives with it.
    const kept = await employeeById(placedAfterUp);
    expect(kept.departmentHrId).toBe(insertedFeedingDepartmentA);
    expect(kept.department).toBe('feeding');
    expect((await departmentById(insertedFeedingDepartmentA)).code).toBe('FEEDING');

    // Every other department `up` inserted is gone (tenant B's OPERATIONS was used by nothing else)...
    const insertedLeft = await queryRows<{ id: string }>(
      qr,
      `SELECT id FROM departments_hr WHERE description LIKE '${BACKFILL_MARKER}%' ORDER BY id`,
    );
    // ...except QUALITY_CONTROL: no employee points at it any more, but an attendance record does,
    // and `down` never rewrites attendance — a record pointing at a deleted department is worse.
    expect(insertedLeft.map((row) => row.id)).toEqual(
      [insertedFeedingDepartmentA, insertedQualityControlDepartmentA].sort(),
    );
    expect((await employeeById(employees.qualityControl)).departmentHrId).toBeNull();
    expect(await snapshotOf(attendance.qualityControlNull)).toBe(insertedQualityControlDepartmentA);
    expect(await snapshotOf(attendance.operationsNull)).toBe(existingOperationsA);
    expect(await snapshotOf(attendance.operationsKept)).toBe(adminDepartmentA);

    // The department an admin created, the ones that already existed (whatever their spelling)
    // and the revived ones stay.
    expect((await departmentById(adminDepartmentA)).code).toBe('CUSTOM');
    expect((await departmentById(existingOperationsA)).code).toBe('OPERATIONS');
    expect(await departmentCountOf(TENANT_C)).toBe(4);
    expect(await departmentCountOf(TENANT_D)).toBe(9);
    expect((await departmentById(departmentsC.maintenanceLive)).code).toBe('Maintenance');
  });
});
