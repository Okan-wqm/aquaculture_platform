import { runInTenantRead } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService, SiteScopeCaller } from '@aquaculture/backend-common/security';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import {
  MonitoringAreaGeometry,
  MonitoringPosition,
  Site,
  SiteType,
} from '../site/entities/site.entity';
import {
  EnvironmentLayerCapability,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  SatelliteCoverageStatus,
} from '../weather/entities/environment-observation.types';
import { SatelliteSceneObservation } from '../weather/entities/satellite-scene-observation.entity';
import {
  CdseProviderError,
  CdseProviderErrorCode,
  CdseSentinelProvider,
} from '../weather/services/cdse-sentinel.provider';
import { selectSatelliteCoverageAssessment } from '../weather/services/satellite-coverage-assessment-selection';
import { SentinelLayerDefinition, findSentinelLayer } from './marine-layer-catalog';

const EARTH_RADIUS_M = 6_371_008.8;

export const MARINE_RENDER_RETRY_AFTER_SECONDS = 5;

/**
 * Signals bounded render-admission saturation without misclassifying the
 * provider as failed. The controller exposes the explicit retry contract and
 * the gateway forwards it to the authenticated tenant client.
 */
export class MarineRenderSaturatedException extends ServiceUnavailableException {
  readonly retryAfterSeconds = MARINE_RENDER_RETRY_AFTER_SECONDS;

  constructor() {
    super({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Satellite render capacity is temporarily full',
      code: 'MARINE_RENDER_SATURATED',
    });
  }
}

export interface MarineBinaryResponse {
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly body: ReadableStream<Uint8Array>;
  readonly sceneId: string;
  readonly validAt: Date;
  readonly dispose: () => void;
}
export interface MarineRenderRequest {
  readonly tenantId: string;
  readonly caller: SiteScopeCaller;
  readonly siteId: string;
  readonly layerId: string;
  readonly sceneId: string;
  readonly width: number;
  readonly height: number;
  readonly signal?: AbortSignal;
}

interface SiteAreaContext {
  readonly site: Site;
  readonly geometry: MonitoringAreaGeometry;
  readonly scene: SatelliteSceneObservation;
}

@Injectable()
export class MarineDataService {
  constructor(
    private readonly cdseSentinelProvider: CdseSentinelProvider,
    private readonly siteAuthorization: SiteAuthorizationService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async render(input: MarineRenderRequest): Promise<MarineBinaryResponse> {
    const layer = this.requireSentinelLayer(input.layerId);
    const area = await this.siteArea(input.tenantId, input.caller, input.siteId, input.sceneId);
    const width = this.requireDimension('width', input.width);
    const height = this.requireDimension('height', input.height);
    if (width * height > 4_194_304) {
      throw new BadRequestException('Requested image dimensions exceed the pixel limit');
    }
    return this.fetchSentinelImage({
      tenantId: input.tenantId,
      layer,
      scene: area.scene,
      geometry: area.geometry,
      width,
      height,
      signal: input.signal,
    });
  }

  private async siteArea(
    tenantId: string,
    caller: SiteScopeCaller,
    siteId: string,
    sceneId: string,
  ): Promise<SiteAreaContext> {
    if (!isUUID(siteId)) {
      throw new BadRequestException('siteId must be a UUID');
    }
    this.siteAuthorization.assertSiteAssignment({ caller, siteId });
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await queryRunner.manager.findOne(Site, {
        where: { id: siteId, tenantId, isActive: true, isDeleted: false },
      });
      if (!site) {
        throw new NotFoundException('Site not found');
      }
      if (site.type !== SiteType.SEA_CAGE) {
        throw new BadRequestException(
          'Environmental monitoring is available only for SEA_CAGE sites',
        );
      }
      const location = site.location;
      if (
        !location ||
        !Number.isFinite(location.latitude) ||
        !Number.isFinite(location.longitude) ||
        location.latitude < -90 ||
        location.latitude > 90 ||
        location.longitude < -180 ||
        location.longitude > 180
      ) {
        throw new BadRequestException('SEA_CAGE site has no valid monitoring coordinate');
      }
      const geometry =
        site.monitoringArea ??
        this.circleGeometry(location.latitude, location.longitude, site.monitoringRadiusM);
      const scene = await queryRunner.manager.findOne(SatelliteSceneObservation, {
        where: {
          tenantId,
          siteId,
          sceneId,
          provider: EnvironmentProvider.CDSE_SENTINEL_2,
          monitoringLocationRevision: site.monitoringLocationRevision,
        },
        relations: { coverageAssessments: true },
      });
      if (!scene) {
        throw new NotFoundException('Satellite scene not found for the current site area');
      }
      const coverage = selectSatelliteCoverageAssessment(scene);
      if (
        coverage.coverageStatus === SatelliteCoverageStatus.OUT_OF_COVERAGE ||
        coverage.qualityStatus === EnvironmentQualityStatus.NO_DATA ||
        coverage.qualityStatus === EnvironmentQualityStatus.OUT_OF_COVERAGE
      ) {
        throw new BadRequestException('The selected scene has no usable site coverage');
      }
      return {
        site,
        geometry,
        scene,
      };
    });
  }

  private async fetchSentinelImage(input: {
    tenantId: string;
    layer: SentinelLayerDefinition;
    scene: SatelliteSceneObservation;
    geometry: MonitoringAreaGeometry;
    width: number;
    height: number;
    signal?: AbortSignal;
  }): Promise<MarineBinaryResponse> {
    try {
      return await this.cdseSentinelProvider.renderScene({
        tenantId: input.tenantId,
        siteId: input.scene.siteId,
        monitoringLocationRevision: input.scene.monitoringLocationRevision,
        geometry: input.geometry,
        scene: {
          sceneId: input.scene.sceneId,
          collection: input.scene.collection,
          acquiredAt: input.scene.acquiredAt,
        },
        product: input.layer.processProduct,
        width: input.width,
        height: input.height,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof CdseProviderError && error.code === CdseProviderErrorCode.SATURATED) {
        throw new MarineRenderSaturatedException();
      }
      if (
        error instanceof CdseProviderError &&
        (error.code === CdseProviderErrorCode.CONFIGURATION ||
          error.code === CdseProviderErrorCode.AUTHENTICATION)
      ) {
        throw new BadRequestException('CDSE satellite provider is not configured for this tenant');
      }
      if (
        error instanceof CdseProviderError &&
        (error.code === CdseProviderErrorCode.CLIENT_REQUEST ||
          error.code === CdseProviderErrorCode.SCENE_MISMATCH)
      ) {
        throw new BadRequestException(
          'The selected satellite scene cannot be rendered for this site area',
        );
      }
      throw new BadGatewayException('CDSE satellite image request failed');
    }
  }

  private requireSentinelLayer(layerId: string): SentinelLayerDefinition {
    const layer = findSentinelLayer(layerId);
    if (!layer || !layer.capabilities.includes(EnvironmentLayerCapability.IMAGERY)) {
      throw new BadRequestException(`Unsupported Sentinel imagery layer: ${layerId}`);
    }
    return layer;
  }

  private requireDimension(name: string, value: number): number {
    if (!Number.isInteger(value) || value < 64 || value > 2_048) {
      throw new BadRequestException(`${name} must be an integer between 64 and 2048`);
    }
    return value;
  }

  private circleGeometry(
    latitude: number,
    longitude: number,
    radiusM: number,
  ): MonitoringAreaGeometry {
    if (!Number.isInteger(radiusM) || radiusM < 100 || radiusM > 20_000) {
      throw new BadRequestException('SEA_CAGE site has no valid monitoring radius');
    }
    const points: MonitoringPosition[] = [];
    const angularDistance = radiusM / EARTH_RADIUS_M;
    const latitudeRadians = this.toRadians(latitude);
    const longitudeRadians = this.toRadians(longitude);
    for (let index = 0; index < 32; index += 1) {
      const bearing = (2 * Math.PI * index) / 32;
      const pointLatitude = Math.asin(
        Math.sin(latitudeRadians) * Math.cos(angularDistance) +
          Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
      );
      const pointLongitude =
        longitudeRadians +
        Math.atan2(
          Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
          Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(pointLatitude),
        );
      points.push([
        this.normalizeLongitude(this.toDegrees(pointLongitude)),
        this.toDegrees(pointLatitude),
      ]);
    }
    points.push(points[0]!);
    return { type: 'Polygon', coordinates: [points] };
  }

  private toRadians(value: number): number {
    return (value * Math.PI) / 180;
  }

  private toDegrees(value: number): number {
    return (value * 180) / Math.PI;
  }

  private normalizeLongitude(value: number): number {
    return ((((value + 180) % 360) + 360) % 360) - 180;
  }
}
