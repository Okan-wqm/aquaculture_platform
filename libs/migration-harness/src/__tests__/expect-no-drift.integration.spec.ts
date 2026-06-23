import { AllowTenantDelta, EncryptedAtRest } from '@aquaculture/backend-common/database';
import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

import {
  type HarnessContext,
  bootPostgresContainer,
  expectNoDriftAgainst,
  registerDriftMatcher,
  shutdownHarness,
} from '../index';

import { expectHarnessContext, withHarnessSchema } from './test-helpers';

registerDriftMatcher();

@Entity({ name: 'fixture_entity', schema: 'drifttest' })
class FixtureEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'int', nullable: true })
  score!: number | null;
}

enum WidgetStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity({ name: 'widget_with_enum', schema: 'drifttest' })
class WidgetWithEnumEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({
    type: 'enum',
    enum: WidgetStatus,
    enumName: 'widget_status_enum',
    nullable: false,
  })
  status!: WidgetStatus;
}

@Entity({ name: 'widget_with_check', schema: 'drifttest' })
@Check(`"amount" > 0`)
@Check(`"name" <> ''`)
class WidgetWithCheckEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: false })
  name!: string;

  @Column({ type: 'numeric', nullable: false })
  amount!: string;
}

@Entity({ name: 'employee_sensitive', schema: 'drifttest' })
class EmployeeSensitiveEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'bytea', name: 'national_id', nullable: false })
  @EncryptedAtRest({ keyId: 'tenant-pii-v1', algorithm: 'pgp_sym' })
  nationalId!: Buffer;
}

@Entity({ name: 'widget_delta', schema: 'drifttest' })
@AllowTenantDelta({ columnPrefix: ['enterprise_', 'custom_'] })
class WidgetDeltaEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: false })
  name!: string;
}

describe('expectNoDriftAgainst — 4-class drift detection', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('returns zero drift when DB matches entity exactly', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (ephemeral, qr) => {
      // Use the ephemeral schema AS the entity's declared 'drifttest' schema
      // by creating a schema with that exact name too.
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        expect(report).toHaveNoDrift();
        expect(report.totalViolations).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class D (missing column)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // MISSING 'score' column
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        expect(report.totalViolations).toBeGreaterThan(0);
        expect(report.byClass.missing_column).toBe(1);
        expect(report.violations[0]).toContain('entity declares column but DB has no such column');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class B (uuid type mismatch)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // id column is text, entity declares uuid
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id text PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        expect(report.byClass.uuid_type).toBe(1);
        expect(report.violations.some((v) => v.includes('entity declares uuid but DB is text'))).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class C (nullability mismatch)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // name is nullable in DB but entity says NOT NULL
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text,
             score int
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        expect(report.byClass.nullability).toBe(1);
        expect(report.violations.some((v) => v.includes('NOT NULL but DB column is nullable'))).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class E (orphan column — DB has column, entity does not)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // DB has an EXTRA 'legacy_flag' column the entity does not declare.
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int,
             legacy_flag boolean
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        expect(report.byClass.orphan_column).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes('legacy_flag') && v.includes('orphan_column'),
          ),
        ).toBe(true);
        // Other classes should be clean.
        expect(report.byClass.missing_column).toBe(0);
        expect(report.byClass.uuid_type).toBe(0);
        expect(report.byClass.nullability).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class F (enum label drift — entity has label DB lacks)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // DB enum is MISSING 'archived' — entity has 3 labels, DB has 2.
        await qr.query(
          `CREATE TYPE drifttest.widget_status_enum AS ENUM ('draft', 'active')`,
        );
        await qr.query(
          `CREATE TABLE drifttest.widget_with_enum (
             id uuid PRIMARY KEY,
             status drifttest.widget_status_enum NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithEnumEntity],
        );
        expect(report.byClass.enum_labels).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes('widget_status_enum') &&
              v.includes('entity-only: [archived]'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class F (enum label drift — DB has label entity lacks)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // DB has EXTRA 'deprecated' label not declared on the entity.
        await qr.query(
          `CREATE TYPE drifttest.widget_status_enum AS ENUM ('draft', 'active', 'archived', 'deprecated')`,
        );
        await qr.query(
          `CREATE TABLE drifttest.widget_with_enum (
             id uuid PRIMARY KEY,
             status drifttest.widget_status_enum NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithEnumEntity],
        );
        expect(report.byClass.enum_labels).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes('widget_status_enum') &&
              v.includes('db-only: [deprecated]'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class F (enum type missing entirely)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // Table created with a plain text column instead of the declared enum.
        await qr.query(
          `CREATE TABLE drifttest.widget_with_enum (
             id uuid PRIMARY KEY,
             status text NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithEnumEntity],
        );
        expect(report.byClass.enum_labels).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes('widget_status_enum') &&
              v.includes('no such pg_enum exists'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('Class F is clean when labels match exactly (order-insensitive set diff)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // Same labels, different order — set diff should show no drift.
        await qr.query(
          `CREATE TYPE drifttest.widget_status_enum AS ENUM ('active', 'archived', 'draft')`,
        );
        await qr.query(
          `CREATE TABLE drifttest.widget_with_enum (
             id uuid PRIMARY KEY,
             status drifttest.widget_status_enum NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithEnumEntity],
        );
        expect(report.byClass.enum_labels).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('Class G clean when both entity @Check count matches DB constraint count', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.widget_with_check (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             amount numeric NOT NULL,
             CHECK ("amount" > 0),
             CHECK ("name" <> '')
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithCheckEntity],
        );
        expect(report.byClass.check_constraint).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class G (entity declares CHECK the DB lacks)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // Only one CHECK present instead of the entity-declared two.
        await qr.query(
          `CREATE TABLE drifttest.widget_with_check (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             amount numeric NOT NULL,
             CHECK ("amount" > 0)
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithCheckEntity],
        );
        expect(report.byClass.check_constraint).toBe(1);
        expect(
          report.violations.some(
            (v) => v.includes('1 missing in DB') && v.includes('check_constraint'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class G (DB has CHECK the entity does not)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // Three CHECKs in DB, entity declares two.
        await qr.query(
          `CREATE TABLE drifttest.widget_with_check (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             amount numeric NOT NULL,
             CHECK ("amount" > 0),
             CHECK ("name" <> ''),
             CHECK (char_length("name") <= 100)
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [WidgetWithCheckEntity],
        );
        expect(report.byClass.check_constraint).toBe(1);
        expect(
          report.violations.some(
            (v) => v.includes('1 orphaned') && v.includes('check_constraint'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('Class J clean when @EncryptedAtRest column is bytea', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.employee_sensitive (
             id uuid PRIMARY KEY,
             national_id bytea NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [EmployeeSensitiveEntity],
        );
        expect(report.byClass.encrypted_column_protection).toBe(0);
        expect(report.byClass.uuid_type).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('detects Class J when @EncryptedAtRest column is NOT bytea', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // national_id is text — should be bytea per @EncryptedAtRest
        await qr.query(
          `CREATE TABLE drifttest.employee_sensitive (
             id uuid PRIMARY KEY,
             national_id text NOT NULL
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [EmployeeSensitiveEntity],
        );
        expect(report.byClass.encrypted_column_protection).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes('encrypted_column_protection') &&
              v.includes("keyId='tenant-pii-v1'") &&
              v.includes("algorithm='pgp_sym'") &&
              v.includes("DB type is 'text'"),
          ),
        ).toBe(true);
        // Class B (uuid_type) must be SUPPRESSED for decorated columns
        // — the entity declares Buffer / bytea, and the protection
        // class takes precedence.
        expect(report.byClass.uuid_type).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });

  it('Class I clean when tenant clones match source schema shape', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      const tenant1 = 'tenant_1234567890abcdef';
      const tenant2 = 'tenant_fedcba0987654321';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenant1}`);
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenant2}`);
      try {
        for (const s of ['drifttest', tenant1, tenant2]) {
          await qr.query(
            `CREATE TABLE ${s}.fixture_entity (
               id uuid PRIMARY KEY,
               name text NOT NULL,
               score int
             )`,
          );
        }
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest', tenantScan: true },
          [FixtureEntity],
        );
        expect(report.byClass.per_tenant_shape_divergence).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenant1} CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenant2} CASCADE`);
      }
    });
  });

  it('detects Class I (tenant clone has extra column vs source)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      const tenantGood = 'tenant_aaaaaaaaaaaaaaaa';
      const tenantBad = 'tenant_bbbbbbbbbbbbbbbb';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenantGood}`);
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenantBad}`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        await qr.query(
          `CREATE TABLE ${tenantGood}.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        // Tenant-bad carries an extra legacy column the source no longer has.
        await qr.query(
          `CREATE TABLE ${tenantBad}.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int,
             legacy_flag boolean
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest', tenantScan: true },
          [FixtureEntity],
        );
        expect(report.byClass.per_tenant_shape_divergence).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes(tenantBad) &&
              v.includes('extra col') &&
              v.includes('legacy_flag') &&
              v.includes('per_tenant_shape_divergence'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenantGood} CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenantBad} CASCADE`);
      }
    });
  });

  it('detects Class I (tenant clone missing table entirely)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      const tenantMissing = 'tenant_cccccccccccccccc';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenantMissing}`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        // Tenant schema exists but the table was never provisioned.
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest', tenantScan: true },
          [FixtureEntity],
        );
        expect(report.byClass.per_tenant_shape_divergence).toBe(1);
        expect(
          report.violations.some(
            (v) =>
              v.includes(tenantMissing) &&
              v.includes('missing table') &&
              v.includes('per_tenant_shape_divergence'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenantMissing} CASCADE`);
      }
    });
  });

  it('Class I suppresses allowlisted-prefix extra columns per @AllowTenantDelta (R24)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      const tenant = 'tenant_eeeeeeeeeeeeeeee';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenant}`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.widget_delta (
             id uuid PRIMARY KEY,
             name text NOT NULL
           )`,
        );
        // Tenant carries two extra columns: one authorized (enterprise_*
        // matches the @AllowTenantDelta prefix) and one unauthorized
        // (legacy_* does NOT match).
        await qr.query(
          `CREATE TABLE ${tenant}.widget_delta (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             enterprise_sla_tier text,
             legacy_flag boolean
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest', tenantScan: true },
          [WidgetDeltaEntity],
        );
        // ONLY the unauthorized column should emit a violation.
        expect(report.byClass.per_tenant_shape_divergence).toBe(1);
        expect(
          report.violations.some(
            (v) => v.includes('legacy_flag') && !v.includes('enterprise_'),
          ),
        ).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenant} CASCADE`);
      }
    });
  });

  it('Class I is off when tenantScan flag is false (default)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      const tenant = 'tenant_dddddddddddddddd';
      await qr.query(`CREATE SCHEMA IF NOT EXISTS ${tenant}`);
      try {
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        // No tenant table — would flag Class I if scan was enabled.
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' /* tenantScan omitted */ },
          [FixtureEntity],
        );
        expect(report.byClass.per_tenant_shape_divergence).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS ${tenant} CASCADE`);
      }
    });
  });

  it('detects Class A (schema location — table in wrong schema)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      await qr.query(`CREATE SCHEMA IF NOT EXISTS other`);
      try {
        // Table lives in 'other', entity declares 'drifttest'
        await qr.query(
          `CREATE TABLE other.fixture_entity (
             id uuid PRIMARY KEY,
             name text NOT NULL,
             score int
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        expect(report.byClass.schema_location).toBe(1);
        expect(report.violations.some((v) => v.includes("table lives in 'other'"))).toBe(true);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
        await qr.query(`DROP SCHEMA IF EXISTS other CASCADE`);
      }
    });
  });

  it('Jest matcher toHaveNoDrift renders per-class breakdown on failure', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS drifttest`);
      try {
        // Seed multiple violations (missing column + uuid type + nullability)
        await qr.query(
          `CREATE TABLE drifttest.fixture_entity (
             id text PRIMARY KEY,
             name text
           )`,
        );
        const report = await expectNoDriftAgainst(
          { qr, schema: 'drifttest' },
          [FixtureEntity],
        );
        // Expect the matcher to produce a readable failure message.
        expect(() => expect(report).toHaveNoDrift()).toThrow(/violation/);
        expect(report.byClass.missing_column).toBeGreaterThan(0);
        expect(report.byClass.uuid_type).toBeGreaterThan(0);
        expect(report.byClass.nullability).toBeGreaterThan(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS drifttest CASCADE`);
      }
    });
  });
});
