import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { AddSiteMonitoringContract1806900000000 } from '../1806900000000-AddSiteMonitoringContract';

describe('AddSiteMonitoringContract1806900000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  it('adds current-schema-relative monitoring columns with canonical defaults', async () => {
    await new AddSiteMonitoringContract1806900000000().up(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('ALTER TABLE "sites"');
    expect(sql).not.toContain('"farm"."sites"');
    expect(sql).toContain('"monitoringRadiusM" integer NOT NULL DEFAULT 2000');
    expect(sql).toContain('"monitoringArea" jsonb');
    expect(sql).toContain('"monitoringLocationRevision" integer NOT NULL DEFAULT 1');
  });

  it('enforces radius, revision, geometry kind, and new SEA_CAGE location writes', async () => {
    await new AddSiteMonitoringContract1806900000000().up(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('CHK_sites_monitoring_radius');
    expect(sql).toContain('BETWEEN 100 AND 20000');
    expect(sql).toContain('CHK_sites_monitoring_location_revision');
    expect(sql).toContain('"monitoringLocationRevision" >= 1');
    expect(sql).toContain('CHK_sites_monitoring_area_geometry_kind');
    expect(sql).toContain("'Polygon', 'MultiPolygon'");
    expect(sql).toContain('CHK_sites_sea_cage_location');
    expect(sql).toContain('NOT VALID');
  });

  it('removes only the forward migration contract in reverse order', async () => {
    await new AddSiteMonitoringContract1806900000000().down(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_sites_sea_cage_location"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_sites_monitoring_area_geometry_kind"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_sites_monitoring_location_revision"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_sites_monitoring_radius"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "monitoringArea"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "monitoringRadiusM"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "monitoringLocationRevision"');
  });
});
