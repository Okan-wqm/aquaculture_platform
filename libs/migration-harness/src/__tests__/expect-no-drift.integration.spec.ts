/**
 * Integration test for expectNoDriftAgainst + toHaveNoDrift matcher.
 * Uses fixture entities to verify each of the 4 drift classes (A-D) is
 * detected correctly, and that a clean shape produces zero violations.
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';

import {
  type HarnessContext,
  bootPostgresContainer,
  expectNoDriftAgainst,
  registerDriftMatcher,
  shutdownHarness,
  withEphemeralSchema,
} from '../index';

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

describe('expectNoDriftAgainst — 4-class drift detection', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('returns zero drift when DB matches entity exactly', async () => {
    await withEphemeralSchema(ctx!, async (ephemeral, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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

  it('detects Class A (schema location — table in wrong schema)', async () => {
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
    await withEphemeralSchema(ctx!, async (_e, qr) => {
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
