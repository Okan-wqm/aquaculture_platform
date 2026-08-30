import { DataSource, EntityManager } from 'typeorm';
import { createMockDataSource } from '@aquaculture/testing';

const runInTenantReadMock = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (
    dataSource: DataSource,
    schema: string,
    tenantId: string,
    callback: (queryRunner: { manager: EntityManager }) => Promise<unknown>,
  ) => runInTenantReadMock(dataSource, schema, tenantId, callback),
}));

import { SiteAuthorizationService, SiteScopeCaller } from '@aquaculture/backend-common/security';
import { MonitoringAreaGeometry, Site, SiteType } from '../../site/entities/site.entity';
import {
  EnvironmentProvider,
  EnvironmentQualityStatus,
  SatelliteCoverageStatus,
} from '../../weather/entities/environment-observation.types';
import { SatelliteSceneObservation } from '../../weather/entities/satellite-scene-observation.entity';
import { SatelliteSceneCoverageAssessment } from '../../weather/entities/satellite-scene-coverage-assessment.entity';
import {
  CDSE_COVERAGE_METHOD,
  CdseProviderError,
  CdseProviderErrorCode,
  CdseSentinelProvider,
} from '../../weather/services/cdse-sentinel.provider';
import {
  MARINE_RENDER_RETRY_AFTER_SECONDS,
  MarineDataService,
  MarineRenderSaturatedException,
} from '../marine-data.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCENE_ID = 'S2B_MSIL2A_20260730T102559_N0511_R108_T32VLM';
const ACQUIRED_AT = new Date('2026-07-30T10:25:59.000Z');
const CALLER: SiteScopeCaller = {
  sub: 'user-1',
  roles: [],
  assignedSiteIds: [SITE_ID],
};
const MONITORING_AREA: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-1, 50],
      [1, 50],
      [1, 52],
      [-1, 52],
      [-1, 50],
    ],
  ],
};

describe('MarineDataService site-bound imagery', () => {
  let manager: jest.Mocked<EntityManager>;
  let dataSource: jest.Mocked<DataSource>;
  let service: MarineDataService;
  let renderScene: jest.Mock;

  beforeEach(() => {
    const mocks = createMockDataSource();
    manager = mocks.mockManager;
    dataSource = mocks.mockDataSource;
    manager.findOne.mockImplementation((entity) => {
      if (entity === Site) {
        return Promise.resolve({
          id: SITE_ID,
          tenantId: TENANT_ID,
          isActive: true,
          isDeleted: false,
          type: SiteType.SEA_CAGE,
          location: { latitude: 51, longitude: 0 },
          monitoringRadiusM: 2_000,
          monitoringArea: MONITORING_AREA,
          monitoringLocationRevision: 4,
        } as Site);
      }
      if (entity === SatelliteSceneObservation) {
        const assessment = Object.assign(new SatelliteSceneCoverageAssessment(), {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          sceneId: SCENE_ID,
          monitoringLocationRevision: 4,
          coverageStatus: SatelliteCoverageStatus.FULL,
          coverageMethod: CDSE_COVERAGE_METHOD,
          coveragePercent: 100,
          coverageSampleCount: 0,
          qualityStatus: EnvironmentQualityStatus.VALID,
          createdAt: ACQUIRED_AT,
        });
        return Promise.resolve({
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          sceneId: SCENE_ID,
          collection: 'sentinel-2-l2a',
          acquiredAt: ACQUIRED_AT,
          coveragePercent: 100,
          coverageAssessments: [assessment],
          qualityStatus: EnvironmentQualityStatus.VALID,
          monitoringLocationRevision: 4,
        } as SatelliteSceneObservation);
      }
      return Promise.resolve(null);
    });
    runInTenantReadMock.mockReset();
    runInTenantReadMock.mockImplementation(
      async (
        _dataSource: DataSource,
        _schema: string,
        _tenantId: string,
        callback: (queryRunner: { manager: EntityManager }) => Promise<unknown>,
      ) => callback({ manager }),
    );
    renderScene = jest.fn().mockResolvedValue({
      status: 200,
      contentType: 'image/png',
      contentLength: 3,
      body: new Response(new Uint8Array([1, 2, 3])).body!,
      sceneId: SCENE_ID,
      validAt: ACQUIRED_AT,
      dispose: jest.fn(),
    });
    const authorization = { assertSiteAssignment: jest.fn() };
    service = new MarineDataService(
      { renderScene } as Pick<CdseSentinelProvider, 'renderScene'> as CdseSentinelProvider,
      authorization as Pick<
        SiteAuthorizationService,
        'assertSiteAssignment'
      > as SiteAuthorizationService,
      dataSource,
    );
  });

  it('renders only the persisted scene over the authorized site AOI', async () => {
    const abortController = new AbortController();
    const response = await service.render({
      tenantId: TENANT_ID,
      caller: CALLER,
      siteId: SITE_ID,
      layerId: 'sentinel:natural-color',
      sceneId: SCENE_ID,
      width: 512,
      height: 512,
      signal: abortController.signal,
    });

    expect(response.sceneId).toBe(SCENE_ID);
    expect(runInTenantReadMock).toHaveBeenCalledTimes(1);
    expect(renderScene).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        geometry: MONITORING_AREA,
        scene: {
          sceneId: SCENE_ID,
          collection: 'sentinel-2-l2a',
          acquiredAt: ACQUIRED_AT,
        },
        signal: abortController.signal,
      }),
    );
    expect(renderScene.mock.calls[0]![0]).not.toHaveProperty('bbox');
    expect(manager.findOne).toHaveBeenCalledWith(
      SatelliteSceneObservation,
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          sceneId: SCENE_ID,
          provider: EnvironmentProvider.CDSE_SENTINEL_2,
          monitoringLocationRevision: 4,
        }),
      }),
    );
    response.dispose();
  });

  it('rejects non-SEA_CAGE and invalid-coordinate sites at the backend boundary', async () => {
    manager.findOne.mockResolvedValueOnce({
      id: SITE_ID,
      tenantId: TENANT_ID,
      type: SiteType.LAND_BASED,
      isActive: true,
      isDeleted: false,
      location: { latitude: 51, longitude: 0 },
    } as Site);
    await expect(
      service.render({
        tenantId: TENANT_ID,
        caller: CALLER,
        siteId: SITE_ID,
        layerId: 'sentinel:natural-color',
        sceneId: SCENE_ID,
        width: 512,
        height: 512,
      }),
    ).rejects.toThrow('only for SEA_CAGE');

    manager.findOne.mockResolvedValueOnce({
      id: SITE_ID,
      tenantId: TENANT_ID,
      type: SiteType.SEA_CAGE,
      isActive: true,
      isDeleted: false,
      location: { latitude: 91, longitude: 0 },
    } as Site);
    await expect(
      service.render({
        tenantId: TENANT_ID,
        caller: CALLER,
        siteId: SITE_ID,
        layerId: 'sentinel:natural-color',
        sceneId: SCENE_ID,
        width: 512,
        height: 512,
      }),
    ).rejects.toThrow('valid monitoring coordinate');
    expect(renderScene).not.toHaveBeenCalled();
  });

  it('rejects an invalid persisted radius before generating the fallback AOI', async () => {
    manager.findOne.mockResolvedValueOnce({
      id: SITE_ID,
      tenantId: TENANT_ID,
      type: SiteType.SEA_CAGE,
      isActive: true,
      isDeleted: false,
      location: { latitude: 51, longitude: 0 },
      monitoringArea: null,
      monitoringRadiusM: 0,
      monitoringLocationRevision: 4,
    } as Site);

    await expect(
      service.render({
        tenantId: TENANT_ID,
        caller: CALLER,
        siteId: SITE_ID,
        layerId: 'sentinel:natural-color',
        sceneId: SCENE_ID,
        width: 512,
        height: 512,
      }),
    ).rejects.toThrow('valid monitoring radius');
    expect(renderScene).not.toHaveBeenCalled();
  });

  it('refuses a scene whose persisted AOI status is outside coverage', async () => {
    manager.findOne.mockImplementation((entity) => {
      if (entity === Site) {
        return Promise.resolve({
          id: SITE_ID,
          tenantId: TENANT_ID,
          isActive: true,
          isDeleted: false,
          type: SiteType.SEA_CAGE,
          location: { latitude: 51, longitude: 0 },
          monitoringRadiusM: 2_000,
          monitoringArea: MONITORING_AREA,
          monitoringLocationRevision: 4,
        } as Site);
      }
      if (entity === SatelliteSceneObservation) {
        const assessment = Object.assign(new SatelliteSceneCoverageAssessment(), {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          sceneId: SCENE_ID,
          monitoringLocationRevision: 4,
          coverageStatus: SatelliteCoverageStatus.OUT_OF_COVERAGE,
          coverageMethod: CDSE_COVERAGE_METHOD,
          coveragePercent: 0,
          coverageSampleCount: 0,
          qualityStatus: EnvironmentQualityStatus.OUT_OF_COVERAGE,
          createdAt: ACQUIRED_AT,
        });
        return Promise.resolve({
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          sceneId: SCENE_ID,
          provider: EnvironmentProvider.CDSE_SENTINEL_2,
          coverageAssessments: [assessment],
          qualityStatus: EnvironmentQualityStatus.VALID,
          monitoringLocationRevision: 4,
        } as SatelliteSceneObservation);
      }
      return Promise.resolve(null);
    });

    await expect(
      service.render({
        tenantId: TENANT_ID,
        caller: CALLER,
        siteId: SITE_ID,
        layerId: 'sentinel:natural-color',
        sceneId: SCENE_ID,
        width: 512,
        height: 512,
      }),
    ).rejects.toThrow('no usable site coverage');
    expect(renderScene).not.toHaveBeenCalled();
  });

  it('maps bounded CDSE admission saturation to a deterministic retryable 503', async () => {
    renderScene.mockRejectedValueOnce(
      new CdseProviderError({
        code: CdseProviderErrorCode.SATURATED,
        message: 'capacity full',
        retryable: true,
      }),
    );

    const request = service.render({
      tenantId: TENANT_ID,
      caller: CALLER,
      siteId: SITE_ID,
      layerId: 'sentinel:natural-color',
      sceneId: SCENE_ID,
      width: 512,
      height: 512,
    });

    await expect(request).rejects.toBeInstanceOf(MarineRenderSaturatedException);
    await expect(request).rejects.toMatchObject({
      retryAfterSeconds: MARINE_RENDER_RETRY_AFTER_SECONDS,
    });
  });
});
