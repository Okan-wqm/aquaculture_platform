import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';
import { EntitiesMetadataStorage } from '@nestjs/typeorm/dist/entities-metadata.storage';
import { getMetadataArgsStorage } from 'typeorm';

import { EnvironmentMetricSyncOutcome } from '../entities/environment-metric-sync-outcome.entity';
import { MarineObservation } from '../entities/marine-observation.entity';
import { SatelliteSceneCoverageAssessment } from '../entities/satellite-scene-coverage-assessment.entity';
import { SatelliteSceneObservation } from '../entities/satellite-scene-observation.entity';
import { SiteEnvironmentSyncState } from '../entities/site-environment-sync-state.entity';
import { WeatherObservation } from '../entities/weather-observation.entity';
import { WeatherModule } from '../weather.module';

describe('environment entity foreign-key metadata', () => {
  it('registers every runtime-read environment entity in WeatherModule', () => {
    expect(WeatherModule).toBeDefined();
    expect(EntitiesMetadataStorage.getEntitiesByDataSource('default')).toEqual(
      expect.arrayContaining([
        WeatherObservation,
        MarineObservation,
        SatelliteSceneObservation,
        SatelliteSceneCoverageAssessment,
        SiteEnvironmentSyncState,
        EnvironmentMetricSyncOutcome,
      ]),
    );
  });

  it('keeps every migration-owned environment table in farm tenant ownership SSoT', () => {
    const expectedTables = [
      'weather_observations',
      'marine_observations',
      'satellite_scene_observations',
      'satellite_scene_coverage_assessments',
      'site_environment_sync_state',
      'environment_metric_sync_outcomes',
    ];
    const farmTables = MODULE_SCHEMAS.find((entry) => entry.moduleName === 'farm')?.tables;
    const environmentEntities = new Set<unknown>([
      WeatherObservation,
      MarineObservation,
      SatelliteSceneObservation,
      SatelliteSceneCoverageAssessment,
      SiteEnvironmentSyncState,
      EnvironmentMetricSyncOutcome,
    ]);
    const entityTables = getMetadataArgsStorage()
      .tables.filter((table) => environmentEntities.has(table.target))
      .map((table) => table.name)
      .sort();

    expect(farmTables).toEqual(expect.arrayContaining(expectedTables));
    expect(entityTables).toEqual([...expectedTables].sort());
  });

  it.each([
    ['weather observation', WeatherObservation],
    ['marine observation', MarineObservation],
    ['satellite scene', SatelliteSceneObservation],
    ['satellite coverage assessment', SatelliteSceneCoverageAssessment],
    ['sync state', SiteEnvironmentSyncState],
  ])('maps the %s tenant/site identity to the migration-owned Site FK', (_name, target) => {
    const metadata = getMetadataArgsStorage();
    const relation = metadata.relations.find(
      (candidate) => candidate.target === target && candidate.propertyName === 'site',
    );
    const joinColumns = metadata.joinColumns
      .filter((candidate) => candidate.target === target && candidate.propertyName === 'site')
      .map((candidate) => ({
        name: candidate.name,
        referencedColumnName: candidate.referencedColumnName,
      }));

    expect(relation?.relationType).toBe('many-to-one');
    expect(relation?.options.onDelete).toBe('CASCADE');
    expect(joinColumns).toEqual([
      { name: 'tenant_id', referencedColumnName: 'tenantId' },
      { name: 'site_id', referencedColumnName: 'id' },
    ]);
  });

  it('maps coverage assessments to the immutable raw scene natural identity', () => {
    const metadata = getMetadataArgsStorage();
    const relation = metadata.relations.find(
      (candidate) =>
        candidate.target === SatelliteSceneCoverageAssessment && candidate.propertyName === 'scene',
    );
    const joinColumns = metadata.joinColumns
      .filter(
        (candidate) =>
          candidate.target === SatelliteSceneCoverageAssessment &&
          candidate.propertyName === 'scene',
      )
      .map((candidate) => ({
        name: candidate.name,
        referencedColumnName: candidate.referencedColumnName,
      }));

    expect(relation?.relationType).toBe('many-to-one');
    expect(relation?.options.onDelete).toBe('CASCADE');
    expect(joinColumns).toEqual([
      { name: 'tenant_id', referencedColumnName: 'tenantId' },
      { name: 'site_id', referencedColumnName: 'siteId' },
      { name: 'scene_id', referencedColumnName: 'sceneId' },
      {
        name: 'monitoring_location_revision',
        referencedColumnName: 'monitoringLocationRevision',
      },
    ]);
  });

  it('maps metric outcomes to the exact composite sync-state FK', () => {
    const metadata = getMetadataArgsStorage();
    const relation = metadata.relations.find(
      (candidate) =>
        candidate.target === EnvironmentMetricSyncOutcome && candidate.propertyName === 'syncState',
    );
    const joinColumns = metadata.joinColumns
      .filter(
        (candidate) =>
          candidate.target === EnvironmentMetricSyncOutcome &&
          candidate.propertyName === 'syncState',
      )
      .map((candidate) => ({
        name: candidate.name,
        referencedColumnName: candidate.referencedColumnName,
      }));

    expect(relation?.relationType).toBe('many-to-one');
    expect(relation?.options.onDelete).toBe('CASCADE');
    expect(joinColumns).toEqual([
      { name: 'tenant_id', referencedColumnName: 'tenantId' },
      { name: 'site_id', referencedColumnName: 'siteId' },
      { name: 'provider', referencedColumnName: 'provider' },
      {
        name: 'monitoring_location_revision',
        referencedColumnName: 'monitoringLocationRevision',
      },
    ]);
  });
});
