/**
 * Regex unit tests for SyncHrEntitiesToDb1786800000000's whitelist + idempotency.
 *
 * The migration's two helper predicates (`isValidatorRelevant` and
 * `makeIdempotent`) are inlined inside its `up()` method to keep the
 * migration self-contained. We re-declare the SAME regex/replacement
 * shapes here and assert each known log() output statement class
 * receives the expected verdict.
 *
 * If the migration's inline helpers are ever edited, these tests must
 * be updated to match — both copies are mirrored 1:1 by intent.
 *
 * Failure modes this test catches:
 *   - Whitelist accidentally allows ADD CONSTRAINT (deploy 5 regression)
 *   - Whitelist accidentally rejects ALTER COLUMN TYPE (uuid drift goes uncaught)
 *   - makeIdempotent fails to inject IF NOT EXISTS into ADD COLUMN
 *   - makeIdempotent corrupts schema-qualified table names
 */
describe('SyncHrEntitiesToDb1786800000000 — Phase L whitelist + idempotency', () => {
  // Mirrors apps/hr-service/src/database/migrations/1786800000000-SyncHrEntitiesToDb.ts
  // §6 isValidatorRelevant. Update BOTH if either changes.
  const isValidatorRelevant = (sql: string): boolean => {
    const t = sql.trim();
    if (/^CREATE\s+TYPE\b/i.test(t)) return true;
    if (/^CREATE\s+TABLE\b/i.test(t)) return true;
    if (/^ALTER\s+TABLE\b[^;]*?\bADD\s+(?!CONSTRAINT\b)"/i.test(t)) return true;
    // Phase L+: any ALTER COLUMN sub-action passes (TYPE / SET NOT NULL
    // / DROP NOT NULL / SET DEFAULT / DROP DEFAULT). The trio
    // DROP-DEFAULT → TYPE → SET-DEFAULT must stay together for PG's
    // enum type changes to succeed (deploy 6 regression).
    if (/^ALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b/i.test(t)) return true;
    return false;
  };

  // Mirrors §6b makeIdempotent. Update BOTH if either changes.
  const makeIdempotent = (sql: string): string => {
    let s = sql;
    s = s.replace(/^CREATE\s+TABLE\s+"/i, 'CREATE TABLE IF NOT EXISTS "');
    s = s.replace(
      /(\bALTER\s+TABLE\s+"[^"]+"\."[^"]+"\s+)ADD\s+"/i,
      '$1ADD COLUMN IF NOT EXISTS "',
    );
    if (/^CREATE\s+TYPE\b/i.test(s)) {
      s = `DO $$ BEGIN ${s}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    }
    return s;
  };

  describe('isValidatorRelevant — KEEP cases', () => {
    it.each([
      [
        'CREATE TABLE for missing table',
        `CREATE TABLE "hr"."hr_outbox" ("id" BIGSERIAL NOT NULL, "eventType" varchar(100))`,
      ],
      [
        'CREATE TYPE for enum',
        `CREATE TYPE "hr"."shifts_shifttype_enum" AS ENUM ('regular', 'overtime')`,
      ],
      [
        'ALTER TABLE … ADD column (TypeORM omits COLUMN keyword)',
        `ALTER TABLE "hr"."payrolls" ADD "earningsBaseSalary" numeric(12,2) NOT NULL`,
      ],
      [
        'ALTER TABLE … ALTER COLUMN TYPE (uuid mismatch fix)',
        `ALTER TABLE "hr"."payrolls" ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid`,
      ],
      [
        'ALTER TABLE … ALTER COLUMN SET NOT NULL',
        `ALTER TABLE "hr"."payrolls" ALTER COLUMN "tenantId" SET NOT NULL`,
      ],
      [
        'ALTER TABLE … ALTER COLUMN DROP DEFAULT (deploy 6 trio precondition)',
        `ALTER TABLE "hr"."training_enrollments" ALTER COLUMN "status" DROP DEFAULT`,
      ],
      [
        'ALTER TABLE … ALTER COLUMN SET DEFAULT (deploy 6 trio postcondition)',
        `ALTER TABLE "hr"."training_enrollments" ALTER COLUMN "status" SET DEFAULT 'enrolled'`,
      ],
      [
        'ALTER TABLE … ALTER COLUMN DROP NOT NULL (validator does not flag relaxed nullability)',
        `ALTER TABLE "hr"."weekly_plans" ALTER COLUMN "notifiedAt" DROP NOT NULL`,
      ],
    ])('keeps %s', (_label, sql) => {
      expect(isValidatorRelevant(sql)).toBe(true);
    });
  });

  describe('isValidatorRelevant — SKIP cases (validator does not check these)', () => {
    it.each([
      [
        'ADD CONSTRAINT PRIMARY KEY (deploy 5 failure mode)',
        `ALTER TABLE "hr"."scheduling_settings" ADD CONSTRAINT "PK_8e3892ce17b3a09c6172d83423d" PRIMARY KEY ("tenantId")`,
      ],
      [
        'ADD CONSTRAINT UNIQUE',
        `ALTER TABLE "hr"."shifts" ADD CONSTRAINT "UQ_shift_tenant_code" UNIQUE ("tenantId", "code")`,
      ],
      [
        'ADD CONSTRAINT FOREIGN KEY',
        `ALTER TABLE "hr"."employees" ADD CONSTRAINT "FK_employee_department" FOREIGN KEY ("departmentId") REFERENCES "hr"."departments_hr"("id")`,
      ],
      [
        'ADD CONSTRAINT CHECK',
        `ALTER TABLE "hr"."leave_requests" ADD CONSTRAINT "CK_dates" CHECK ("startDate" <= "endDate")`,
      ],
      ['CREATE INDEX', `CREATE INDEX "IDX_payroll_tenant" ON "hr"."payrolls" ("tenantId")`],
      ['DROP TABLE', `DROP TABLE "hr"."old_table"`],
      [
        'DROP TYPE (deploy 4 failure mode)',
        `DROP TYPE "hr"."work_week_day"`,
      ],
      ['DROP COLUMN', `ALTER TABLE "hr"."payrolls" DROP COLUMN "earnings"`],
      [
        'DROP CONSTRAINT',
        `ALTER TABLE "hr"."employees" DROP CONSTRAINT "FK_old_dept"`,
      ],
      ['COMMENT ON COLUMN', `COMMENT ON COLUMN "hr"."payrolls"."tenantId" IS 'tenant id'`],
    ])('skips %s', (_label, sql) => {
      expect(isValidatorRelevant(sql)).toBe(false);
    });
  });

  describe('makeIdempotent', () => {
    it('rewrites CREATE TABLE → CREATE TABLE IF NOT EXISTS', () => {
      const input = `CREATE TABLE "hr"."hr_outbox" ("id" BIGSERIAL NOT NULL)`;
      expect(makeIdempotent(input)).toBe(
        `CREATE TABLE IF NOT EXISTS "hr"."hr_outbox" ("id" BIGSERIAL NOT NULL)`,
      );
    });

    it('rewrites ALTER TABLE … ADD "col" → ALTER TABLE … ADD COLUMN IF NOT EXISTS "col"', () => {
      const input = `ALTER TABLE "hr"."payrolls" ADD "earningsBaseSalary" numeric(12,2) NOT NULL`;
      expect(makeIdempotent(input)).toBe(
        `ALTER TABLE "hr"."payrolls" ADD COLUMN IF NOT EXISTS "earningsBaseSalary" numeric(12,2) NOT NULL`,
      );
    });

    it('wraps CREATE TYPE in DO/EXCEPTION duplicate_object', () => {
      const input = `CREATE TYPE "hr"."shifts_shifttype_enum" AS ENUM ('regular')`;
      const out = makeIdempotent(input);
      expect(out).toContain('DO $$ BEGIN');
      expect(out).toContain(input);
      expect(out).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
    });

    it('does NOT touch ALTER COLUMN TYPE (no idempotent rewrite needed; PG is idempotent at type level)', () => {
      const input = `ALTER TABLE "hr"."payrolls" ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid`;
      expect(makeIdempotent(input)).toBe(input);
    });

    it('does NOT touch ALTER COLUMN SET NOT NULL', () => {
      const input = `ALTER TABLE "hr"."payrolls" ALTER COLUMN "tenantId" SET NOT NULL`;
      expect(makeIdempotent(input)).toBe(input);
    });

    it('preserves schema-qualified table names through ADD COLUMN rewrite', () => {
      const input = `ALTER TABLE "tenant_abc123def456abc1"."payrolls" ADD "newCol" varchar`;
      expect(makeIdempotent(input)).toBe(
        `ALTER TABLE "tenant_abc123def456abc1"."payrolls" ADD COLUMN IF NOT EXISTS "newCol" varchar`,
      );
    });
  });

  describe('end-to-end pipeline (whitelist + idempotency)', () => {
    it('keeps and rewrites a missing-column ADD scenario', () => {
      const sql = `ALTER TABLE "hr"."payrolls" ADD "earningsBaseSalary" numeric(12,2) NOT NULL`;
      expect(isValidatorRelevant(sql)).toBe(true);
      expect(makeIdempotent(sql)).toBe(
        `ALTER TABLE "hr"."payrolls" ADD COLUMN IF NOT EXISTS "earningsBaseSalary" numeric(12,2) NOT NULL`,
      );
    });

    it('rejects the deploy 5 PK conflict scenario before idempotency runs', () => {
      const sql = `ALTER TABLE "hr"."scheduling_settings" ADD CONSTRAINT "PK_x" PRIMARY KEY ("tenantId")`;
      expect(isValidatorRelevant(sql)).toBe(false);
    });

    it('rejects the deploy 4 DROP TYPE cascade scenario', () => {
      const sql = `DROP TYPE "hr"."work_week_day"`;
      expect(isValidatorRelevant(sql)).toBe(false);
    });
  });
});
