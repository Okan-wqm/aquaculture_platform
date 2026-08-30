import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { CreateEnvironmentalObservationFoundation1807100000000 } from '../1807100000000-CreateEnvironmentalObservationFoundation';

describe('CreateEnvironmentalObservationFoundation1807100000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('creates tenant-relative provenance, scene, and sync-state contracts', async () => {
    await new CreateEnvironmentalObservationFoundation1807100000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('ALTER TABLE "weather_observations"');
    expect(sql).toContain('ALTER TABLE "marine_observations"');
    expect(sql).toContain('"source_run_key"');
    expect(sql).toContain('"monitoring_location_revision"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "satellite_scene_observations"');
    expect(sql).toContain('"product_id" character varying(512) NOT NULL');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "site_environment_sync_state"');
    expect(sql).not.toContain('"farm"."weather_observations"');
    expect(sql).not.toContain('"farm"."marine_observations"');
    expect(sql).toContain("\"provider\" IN ('MET_LOCATIONFORECAST', 'MET_FROST')");
    expect(sql).toContain('"semantic_class" = \'FORECAST\'');
    expect(sql).toContain('"semantic_class" = \'OBSERVATION\'');
    expect(sql).toContain('"station_distance_km" IS NOT NULL');
    expect(sql).toContain('"provider" = \'CMEMS\'');
    expect(sql).toContain('"variable_set_id" IS NOT NULL');
    expect(sql).toContain('"horizontal_resolution_m" IS NOT NULL');
    expect(sql).toContain('"issued_at" IS NOT NULL');
    expect(sql).toContain('"uq_sites_tenant_identity"');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "site_id")');
    expect(sql).toContain('REFERENCES "sites"("tenantId", "id")');
    expect(sql).toContain('"FK_weather_observation_tenant_site"');
    expect(sql).toContain('"FK_marine_observation_tenant_site"');
    expect(sql).toContain('"FK_satellite_scene_tenant_site"');
    expect(sql).toContain('"FK_site_environment_sync_tenant_site"');
    expect(sql).toContain('VALIDATE CONSTRAINT "FK_weather_observation_tenant_site"');
    expect(sql).toContain('VALIDATE CONSTRAINT "FK_marine_observation_tenant_site"');
    expect(sql).toContain("constraint_row.confdeltype <> 'c'");
    expect(sql.indexOf('FOREIGN KEY ("tenant_id", "site_id")')).toBeLessThan(
      sql.indexOf('VALIDATE CONSTRAINT "FK_weather_observation_tenant_site"'),
    );
    expect(sql.indexOf('VALIDATE CONSTRAINT "FK_weather_observation_tenant_site"')).toBeLessThan(
      sql.indexOf('VALIDATE CONSTRAINT "FK_marine_observation_tenant_site"'),
    );

    const marineConstraint = queryRunner.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) => statement.includes('CHK_marine_observation_provenance_bundle'));
    expect(marineConstraint).toBeDefined();
    expect(marineConstraint).not.toContain('"issued_at" IS NOT NULL');
  });

  it('makes the provider discriminator complete and bounds canonical values to storage contracts', async () => {
    await new CreateEnvironmentalObservationFoundation1807100000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('"provider" IS NULL');
    expect(sql).toContain('"product_id" IS NULL');
    expect(sql).toContain('"source_run_key" IS NULL');
    expect(sql).toContain('"variable_set_id" IS NULL');
    expect(sql).toContain('"model_chlorophyll" IS NULL');
    expect(sql).toContain('"CHK_weather_observation_canonical_values"');
    expect(sql).toContain('"wind_direction" BETWEEN 0 AND 360');
    expect(sql).toContain('"relative_humidity" BETWEEN 0 AND 100');
    expect(sql).toContain('"CHK_marine_observation_canonical_values"');
    expect(sql).toContain('"ocean_current_velocity" BETWEEN 0 AND 99.999');
    expect(sql).toContain('"horizontal_resolution_m" BETWEEN 0.001 AND 999999999.999');
    expect(sql).toContain('num_nonnulls(');
  });

  it('makes canonical observations immutable and revision-idempotent', async () => {
    await new CreateEnvironmentalObservationFoundation1807100000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('canonical environmental observations are append-only');
    expect(sql).toContain('IF OLD."provider" IS NOT NULL THEN');
    expect(sql).not.toContain('OLD."provider" IS NOT NULL OR NEW."provider" IS NOT NULL');
    expect(sql).toContain('"trg_satellite_scene_append_only"');
    expect(sql).toContain('WHERE "provider" IS NOT NULL');
    expect(sql).toContain('"source_run_key", "observed_at"');
    expect(sql).toContain('COALESCE("model_depth_m", -1)');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "uq_weather_obs"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "uq_marine_obs"');
    expect(sql).toContain('"uq_weather_obs_legacy"');
    expect(sql).toContain('"uq_marine_obs_legacy"');
  });

  it('adds explicit quality, bounds, and 45-day-retention lookup indexes', async () => {
    await new CreateEnvironmentalObservationFoundation1807100000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('CHK_satellite_scene_percentages');
    expect(sql).toContain('CHK_marine_observation_dimensions');
    expect(sql).toContain('CHK_site_environment_sync_lease');
    expect(sql).toContain('idx_weather_obs_retention');
    expect(sql).toContain('idx_marine_obs_retention');
    expect(sql).toContain('idx_satellite_scene_retention');
    expect(sql).toContain('idx_weather_obs_latest_metric');
    expect(sql).toContain('idx_marine_obs_latest_metric');
    expect(sql).toContain('CHK_site_environment_sync_outcome');
    expect(sql).toContain('"lease_expires_at" > "last_attempt_at"');
  });

  it('refuses destructive rollback after canonical monitoring data exists', async () => {
    await new CreateEnvironmentalObservationFoundation1807100000000().down(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain(
      'cannot roll back environmental observation foundation after canonical monitoring data exists',
    );
    expect(sql.indexOf('cannot roll back environmental observation foundation')).toBeLessThan(
      sql.indexOf('DROP TABLE IF EXISTS "site_environment_sync_state"'),
    );
    expect(sql).toContain('DROP TABLE IF EXISTS "site_environment_sync_state"');
    expect(sql).toContain('DROP TABLE IF EXISTS "satellite_scene_observations"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "provider"');
    expect(sql).toContain('cannot restore uq_weather_obs');
    expect(sql).toContain('cannot restore uq_marine_obs');
    expect(sql).toContain('ADD CONSTRAINT "uq_weather_obs"');
    expect(sql).toContain('ADD CONSTRAINT "uq_marine_obs"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "FK_weather_observation_tenant_site"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "FK_marine_observation_tenant_site"');
    expect(sql).toContain('DROP INDEX IF EXISTS "uq_sites_tenant_identity"');
    expect(sql).not.toContain('DROP TABLE IF EXISTS "marine_observations"');
    expect(sql).not.toContain('DROP TABLE IF EXISTS "weather_observations"');
  });
});
