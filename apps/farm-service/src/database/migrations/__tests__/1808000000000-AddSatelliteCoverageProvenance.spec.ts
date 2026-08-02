import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

const applyTenantRlsToSchemaMock = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  applyTenantRlsToSchema: (...args: unknown[]) => applyTenantRlsToSchemaMock(...args),
}));

import { AddSatelliteCoverageProvenance1808000000000 } from '../1808000000000-AddSatelliteCoverageProvenance';

describe('AddSatelliteCoverageProvenance1808000000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
    applyTenantRlsToSchemaMock.mockReset().mockResolvedValue(undefined);
  });

  it('creates an immutable versioned assessment SSOT without altering raw scenes', async () => {
    await new AddSatelliteCoverageProvenance1808000000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "satellite_scene_coverage_assessments"');
    expect(sql).toContain('"FK_satellite_coverage_scene_identity"');
    expect(sql).toContain(
      'UNIQUE (\n            "tenant_id", "site_id", "scene_id", "monitoring_location_revision",',
    );
    expect(sql).toContain('"coverage_method"');
    expect(sql).toContain('"coverage_status" = \'UNKNOWN\'');
    expect(sql).toContain('"coverage_status" = \'FULL\'');
    expect(sql).toContain('"coverage_status" = \'PARTIAL\'');
    expect(sql).toContain('"coverage_status" = \'OUT_OF_COVERAGE\'');
    expect(sql).toContain('"quality_status" character varying(32) NOT NULL');
    expect(sql).toContain('"trg_satellite_coverage_assessment_append_only"');
    expect(sql).not.toContain('ALTER TABLE "satellite_scene_observations"');
    expect(applyTenantRlsToSchemaMock).toHaveBeenCalledWith(queryRunner, {
      includeTables: ['satellite_scene_coverage_assessments'],
      tenantIdColumns: ['tenant_id'],
    });
  });

  it('backfills legacy provenance and covers old-replica inserts during rollout', async () => {
    await new AddSatelliteCoverageProvenance1808000000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('"insert_legacy_satellite_scene_coverage_assessment"');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "trg_satellite_scene_legacy_coverage"');
    expect(sql).toContain('AFTER INSERT ON "satellite_scene_observations"');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('has_versioned_assessment');
    expect(sql).toContain('TG_TABLE_SCHEMA');
    expect(sql).toContain('NEW."coverage_percent"');
    expect(sql).toContain('NEW."quality_status"');
    expect(sql).toContain('FROM "satellite_scene_observations" AS scene');
    expect(sql).toContain('WHERE NOT EXISTS (');
    expect(sql).toContain('assessment."coverage_method" <> \'LEGACY_UNKNOWN\'');
    expect(sql).toContain("'UNKNOWN', 'LEGACY_UNKNOWN'");
    expect(sql).toContain('ON CONFLICT (');
    expect(sql).toContain('DO NOTHING');
    expect(sql).toContain("rolname = 'farm_service'");
    expect(sql).toContain('TO "farm_service"');
  });

  it('refuses a destructive rollback after versioned coverage is persisted', async () => {
    await new AddSatelliteCoverageProvenance1808000000000().down(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('Refusing to drop persisted versioned satellite coverage assessments');
    expect(sql).toContain('IN ACCESS EXCLUSIVE MODE');
    expect(sql.indexOf('LOCK TABLE "satellite_scene_observations"')).toBeLessThan(
      sql.indexOf('LOCK TABLE "satellite_scene_coverage_assessments"'),
    );
    expect(sql.indexOf('LOCK TABLE "satellite_scene_coverage_assessments"')).toBeLessThan(
      sql.indexOf('Refusing to drop persisted'),
    );
    expect(sql.indexOf('Refusing to drop persisted')).toBeLessThan(
      sql.indexOf('DROP TABLE IF EXISTS "satellite_scene_coverage_assessments"'),
    );
  });
});
