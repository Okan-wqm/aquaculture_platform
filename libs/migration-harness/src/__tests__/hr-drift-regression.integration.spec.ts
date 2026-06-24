/**
 * HR-drift regression spec — reproduces the 5-commit loop in <60s locally.
 * ============================================================================
 *
 * Commits `5df00179` → `e83904d2` (2026-04-20 → 2026-04-21) shipped 5
 * consecutive fixes for HR schema drift, each surfacing the next drift
 * class the prior one didn't cover:
 *
 *   5df00179  SAVEPOINT band-aid (swallowed failure; drift persisted)
 *   3686e3c5  Tier-1 pre-flight DROP helper (dead code — migration already applied)
 *   1b664906  HealHrEnumTypeDrift new migration — failed on EXCLUDE constraint
 *   d943f605  Helper expanded: partial index + EXCLUDE + CHECK (3 classes)
 *   e83904d2  HealHrNullabilityDrift — explicit SET NOT NULL / TYPE uuid pass
 *
 * Root cause across the sequence: production deploy is the FIRST place any
 * drift class gets exercised against real data. Every new class = one
 * failed deploy + one commit.
 *
 * This spec exists to END that pattern. Every HR drift class detectable by
 * the production SchemaDriftValidator (A-D) reproduces HERE, at PR time,
 * in under 60 seconds. A future entity/migration combo that would cause
 * the same failure mode is caught by `nx affected --target=test` before
 * it reaches the droplet.
 *
 * # What this spec proves
 *
 *   1. Harness can seed the exact drift class that caused each deploy
 *      failure in the 5-commit loop.
 *   2. expectNoDriftAgainst detects every class correctly.
 *   3. dropDependentPartialIndexes (the Tier-1 helper shipped in d943f605)
 *      unblocks the ALTER COLUMN TYPE path that failed in deploy 7.
 *   4. The same harness contract works for future drift classes as R11
 *      expands the validator from 4 classes to 10.
 */
import { dropDependentPartialIndexes, parseAlterColumnTypeTargets } from '@aquaculture/backend-common/database';
import { Column, Entity, PrimaryColumn } from 'typeorm';

import {
  bootPostgresContainer,
  expectNoDriftAgainst,
  type HarnessContext,
  registerDriftMatcher,
  shutdownHarness,
} from '../index';

import { expectHarnessContext, withHarnessSchema } from './test-helpers';

registerDriftMatcher();

/**
 * Fixture entity that mirrors the hr.employee_certifications shape that
 * was the canonical drift case in commit 5df00179. Columns intentionally
 * minimal — the spec is about drift CLASS, not HR business logic.
 */
@Entity({ name: 'hr_cert_fixture', schema: 'hr_regression' })
class HrCertFixture {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  tenant_id!: string;

  // Using text + string enum values rather than a TypeScript enum so the
  // fixture stays self-contained. The validator checks uuid/nullability;
  // enum-values drift detection ships with Class F (plan v3 Phase 2).
  @Column({ type: 'text', nullable: false })
  status!: string;

  @Column({ type: 'date', nullable: true })
  expiry_date!: Date | null;
}

describe('HR-drift regression — 5-commit loop reproduced in <60s', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  /**
   * Deploy 7 (commit 5df00179) — the original failure mode. ALTER COLUMN
   * TYPE blocked by a partial index whose WHERE predicate references the
   * OLD enum type. PG re-validates the predicate against the NEW type
   * during ALTER; the two enums have no implicit cross-type equality,
   * ALTER aborts.
   */
  it('reproduces deploy 7 (5df00179) — ALTER COLUMN TYPE blocked by partial-index predicate', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS hr_regression`);
      try {
        await qr.query(
          `CREATE TYPE hr_regression.cert_status_old AS ENUM ('pending', 'active', 'expired')`,
        );
        await qr.query(
          `CREATE TABLE hr_regression.hr_cert_fixture (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             status hr_regression.cert_status_old NOT NULL,
             expiry_date date
           )`,
        );
        // The offending partial index — mirrors IDX_emp_cert_expiry from HR.
        await qr.query(
          `CREATE INDEX idx_cert_active ON hr_regression.hr_cert_fixture
            (tenant_id, expiry_date)
            WHERE status = 'active'::hr_regression.cert_status_old`,
        );
        await qr.query(
          `CREATE TYPE hr_regression.cert_status_new AS ENUM ('pending', 'active', 'expired', 'expiring_soon')`,
        );

        // The ALTER that deploy 7 attempted. Without pre-flight DROP, PG
        // rejects: "operator does not exist: cert_status_new = cert_status_old".
        await expect(
          qr.query(
            `ALTER TABLE hr_regression.hr_cert_fixture
               ALTER COLUMN status TYPE hr_regression.cert_status_new
               USING status::text::hr_regression.cert_status_new`,
          ),
        ).rejects.toThrow(/operator does not exist/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS hr_regression CASCADE`);
      }
    });
  });

  /**
   * Deploy 11 (commit d943f605) — the Tier-1 fix. dropDependentPartialIndexes
   * enumerates every partial index whose predicate references the target
   * column and DROPs it BEFORE the ALTER. The ALTER then succeeds.
   *
   * This is the SAME test flow the real HealHrEnumTypeDrift1786900000000
   * migration exercises in prod; reproducing it in-harness proves the
   * helper is correct without round-tripping a droplet deploy.
   */
  it('reproduces deploy 11 (d943f605) — dropDependentPartialIndexes unblocks ALTER', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS hr_regression`);
      try {
        // Same seed as the deploy-7 reproduction
        await qr.query(
          `CREATE TYPE hr_regression.cert_status_old AS ENUM ('pending', 'active', 'expired')`,
        );
        await qr.query(
          `CREATE TABLE hr_regression.hr_cert_fixture (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             status hr_regression.cert_status_old NOT NULL,
             expiry_date date
           )`,
        );
        await qr.query(
          `CREATE INDEX idx_cert_active ON hr_regression.hr_cert_fixture
            (tenant_id, expiry_date)
            WHERE status = 'active'::hr_regression.cert_status_old`,
        );
        await qr.query(
          `CREATE TYPE hr_regression.cert_status_new AS ENUM ('pending', 'active', 'expired', 'expiring_soon')`,
        );

        // ----- Tier-1 pre-flight DROP -----
        const alterSql = `ALTER TABLE "hr_regression"."hr_cert_fixture" ALTER COLUMN "status" TYPE "hr_regression"."cert_status_new" USING "status"::"text"::"hr_regression"."cert_status_new"`;
        const targets = parseAlterColumnTypeTargets([alterSql]);
        expect(targets).toHaveLength(1);

        const dropped = await dropDependentPartialIndexes(qr, targets);
        expect(dropped.length).toBeGreaterThan(0);
        expect(dropped[0]?.kind).toBe('partial_index');

        // Now the ALTER succeeds.
        await qr.query(alterSql);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS hr_regression CASCADE`);
      }
    });
  });

  /**
   * Deploy 11 post-heal — the boot-signal assertion. The WHOLE POINT of
   * commits 5df00179 → e83904d2 was to let hr-service emit
   * "Schema drift scan clean" on cold boot. This test asserts the
   * equivalent: after the fix, expectNoDriftAgainst returns zero
   * violations across all 4 production classes.
   */
  it('reproduces post-heal clean state — zero drift across Class A–D', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS hr_regression`);
      try {
        // DB shape EXACTLY matches the entity declaration — no drift.
        await qr.query(
          `CREATE TABLE hr_regression.hr_cert_fixture (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             status text NOT NULL,
             expiry_date date
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'hr_regression' },
          [HrCertFixture],
        );
        expect(report).toHaveNoDrift();
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS hr_regression CASCADE`);
      }
    });
  });

  /**
   * Deploy 11 pre-heal boot signal — what SchemaDriftValidator ACTUALLY
   * saw on deploy 11. Multiple drift classes present simultaneously;
   * "Schema drift scan clean" therefore NEVER emitted; asserter timed
   * out at round 30/30.
   *
   * The harness version: seed the same multi-class drift state and
   * confirm every violation the production validator would report.
   */
  it('reproduces deploy-11 pre-heal boot state — multi-class drift visible', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS hr_regression`);
      try {
        // Drifted DB: id is text not uuid (Class B), tenant_id nullable
        // (Class C), status column missing entirely (Class D).
        await qr.query(
          `CREATE TABLE hr_regression.hr_cert_fixture (
             id text PRIMARY KEY,
             tenant_id uuid,
             expiry_date date
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'hr_regression' },
          [HrCertFixture],
        );
        expect(report.totalViolations).toBe(3);
        expect(report.byClass.uuid_type).toBe(1);
        expect(report.byClass.nullability).toBe(1);
        expect(report.byClass.missing_column).toBe(1);
        // Failure message for operator readability — matches the output the
        // asserter would log at round 30/30 in prod deploy.
        expect(() => expect(report).toHaveNoDrift()).toThrow(
          /3 violation\(s\)[\s\S]*uuid_type: 1[\s\S]*nullability: 1[\s\S]*missing_column: 1/,
        );
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS hr_regression CASCADE`);
      }
    });
  });
});
