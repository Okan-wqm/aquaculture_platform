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
