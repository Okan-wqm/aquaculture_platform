import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeCoverage,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
} from '../entities/environment-observation.types';
import {
  buildCmemsFeatureInfoUrl,
  CMEMS_CLOCK,
  CmemsClock,
  CmemsDatasetRegistry,
  CmemsDiscoveredProduct,
  CmemsHttpClient,
  CmemsLayerCapabilities,
  CmemsProductKey,
  CmemsProviderError,
  CmemsProviderErrorCode,
  CmemsRegion,
  cmemsSchemaError,
  isUnknownRecord,
  requireFiniteCmemsNumber,
  selectNearestCmemsElevation,
  selectNearestCmemsTime,
} from './cmems-provider';

const SYSTEM_CLOCK: CmemsClock = {
  now: (): Date => new Date(),
};
const MAX_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FORECAST_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MODEL_DEPTH_M = 10_000;
const EARTH_RADIUS_M = 6_371_008.8;
const VECTOR_TOLERANCE_ABSOLUTE = 1e-6;
const VECTOR_TOLERANCE_RELATIVE = 1e-4;
const ARCTIC_POLAR_STEREOGRAPHIC_CENTRAL_MERIDIAN_DEGREES = -45;

export enum CmemsVectorReference {
  EAST_NORTH = 'EAST_NORTH',
  ARCTIC_POLAR_STEREOGRAPHIC_X_Y = 'ARCTIC_POLAR_STEREOGRAPHIC_X_Y',
}

export const CMEMS_ENVIRONMENT_METRICS: readonly EnvironmentMetric[] = [
  EnvironmentMetric.SEA_TEMPERATURE,
  EnvironmentMetric.SALINITY,
  EnvironmentMetric.DISSOLVED_OXYGEN,
  EnvironmentMetric.MODEL_CHLOROPHYLL,
  EnvironmentMetric.WAVE_HEIGHT,
  EnvironmentMetric.WAVE_DIRECTION,
  EnvironmentMetric.WAVE_PERIOD,
  EnvironmentMetric.CURRENT_SPEED,
  EnvironmentMetric.CURRENT_DIRECTION,
];

const CMEMS_METRIC_SET = new Set<EnvironmentMetric>(CMEMS_ENVIRONMENT_METRICS);

interface CmemsMetricDefinition {
  metric: EnvironmentMetric;
  productKey: CmemsProductKey;
  datasetBase: string;
  variableId: string;
  expectedSourceUnits: readonly string[];
  canonicalUnit: string;
  requiresDepth: boolean;
  vector: {
    speedMetric: EnvironmentMetric;
    directionMetric: EnvironmentMetric;
    component1VariableId: string;
    component2VariableId: string;
    reference: CmemsVectorReference;
  } | null;
}

type CmemsRegionDefinitions = Readonly<Partial<Record<EnvironmentMetric, CmemsMetricDefinition>>>;

const NWS_DEFINITIONS: CmemsRegionDefinitions = {
  [EnvironmentMetric.SEA_TEMPERATURE]: {
    metric: EnvironmentMetric.SEA_TEMPERATURE,
    productKey: CmemsProductKey.NWS_PHY,
    datasetBase: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i',
    variableId: 'thetao',
    expectedSourceUnits: ['degrees_C', 'degree_C'],
    canonicalUnit: '°C',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.SALINITY]: {
    metric: EnvironmentMetric.SALINITY,
    productKey: CmemsProductKey.NWS_PHY,
    datasetBase: 'cmems_mod_nws_phy-sal_anfc_1.5km-3D_PT1H-i',
    variableId: 'so',
    expectedSourceUnits: ['1e-3', '0.001'],
    canonicalUnit: 'PSU',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.DISSOLVED_OXYGEN]: {
    metric: EnvironmentMetric.DISSOLVED_OXYGEN,
    productKey: CmemsProductKey.NWS_BGC,
    datasetBase: 'cmems_mod_nws_bgc-o2_anfc_7km-3D_P1D-m',
    variableId: 'o2',
    expectedSourceUnits: ['mmol m-3'],
    canonicalUnit: 'mmol/m³',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.MODEL_CHLOROPHYLL]: {
    metric: EnvironmentMetric.MODEL_CHLOROPHYLL,
    productKey: CmemsProductKey.NWS_BGC,
    datasetBase: 'cmems_mod_nws_bgc-chl_anfc_7km-3D_P1D-m',
    variableId: 'chl',
    expectedSourceUnits: ['mg m-3'],
    canonicalUnit: 'mg/m³',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.WAVE_HEIGHT]: {
    metric: EnvironmentMetric.WAVE_HEIGHT,
    productKey: CmemsProductKey.NWS_WAV,
    datasetBase: 'cmems_mod_nws_wav_anfc_1.5km_PT1H-i',
    variableId: 'VHM0',
    expectedSourceUnits: ['m'],
    canonicalUnit: 'm',
    requiresDepth: false,
    vector: null,
  },
  [EnvironmentMetric.WAVE_DIRECTION]: {
    metric: EnvironmentMetric.WAVE_DIRECTION,
    productKey: CmemsProductKey.NWS_WAV,
    datasetBase: 'cmems_mod_nws_wav_anfc_1.5km_PT1H-i',
    variableId: 'VMDR',
    expectedSourceUnits: ['degree'],
    canonicalUnit: '°',
    requiresDepth: false,
    vector: null,
  },
  [EnvironmentMetric.WAVE_PERIOD]: {
    metric: EnvironmentMetric.WAVE_PERIOD,
    productKey: CmemsProductKey.NWS_WAV,
    datasetBase: 'cmems_mod_nws_wav_anfc_1.5km_PT1H-i',
    variableId: 'VTM02',
    expectedSourceUnits: ['s'],
    canonicalUnit: 's',
    requiresDepth: false,
    vector: null,
  },
  [EnvironmentMetric.CURRENT_SPEED]: {
    metric: EnvironmentMetric.CURRENT_SPEED,
    productKey: CmemsProductKey.NWS_PHY,
    datasetBase: 'cmems_mod_nws_phy-cur_anfc_1.5km-3D_PT1H-i',
    variableId: 'sea_water_velocity',
    expectedSourceUnits: ['m s-1'],
    canonicalUnit: 'm/s',
    requiresDepth: true,
    vector: {
      speedMetric: EnvironmentMetric.CURRENT_SPEED,
      directionMetric: EnvironmentMetric.CURRENT_DIRECTION,
      component1VariableId: 'uo',
      component2VariableId: 'vo',
      reference: CmemsVectorReference.EAST_NORTH,
    },
  },
  [EnvironmentMetric.CURRENT_DIRECTION]: {
    metric: EnvironmentMetric.CURRENT_DIRECTION,
    productKey: CmemsProductKey.NWS_PHY,
    datasetBase: 'cmems_mod_nws_phy-cur_anfc_1.5km-3D_PT1H-i',
    variableId: 'sea_water_velocity',
    expectedSourceUnits: ['m s-1'],
    canonicalUnit: '°',
    requiresDepth: true,
    vector: {
      speedMetric: EnvironmentMetric.CURRENT_SPEED,
      directionMetric: EnvironmentMetric.CURRENT_DIRECTION,
      component1VariableId: 'uo',
      component2VariableId: 'vo',
      reference: CmemsVectorReference.EAST_NORTH,
    },
  },
};

const ARCTIC_DEFINITIONS: CmemsRegionDefinitions = {
  [EnvironmentMetric.SEA_TEMPERATURE]: {
    metric: EnvironmentMetric.SEA_TEMPERATURE,
    productKey: CmemsProductKey.ARCTIC_PHY,
    datasetBase: 'cmems_mod_arc_phy_anfc_6km_detided_PT1H-i',
    variableId: 'thetao',
    expectedSourceUnits: ['degrees_C', 'degree_C'],
    canonicalUnit: '°C',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.SALINITY]: {
    metric: EnvironmentMetric.SALINITY,
    productKey: CmemsProductKey.ARCTIC_PHY,
    datasetBase: 'cmems_mod_arc_phy_anfc_6km_detided_PT1H-i',
    variableId: 'so',
    expectedSourceUnits: ['1e-3', '0.001'],
    canonicalUnit: 'PSU',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.DISSOLVED_OXYGEN]: {
    metric: EnvironmentMetric.DISSOLVED_OXYGEN,
    productKey: CmemsProductKey.ARCTIC_BGC,
    datasetBase: 'cmems_mod_arc_bgc_anfc_ecosmo_P1D-m',
    variableId: 'o2',
    expectedSourceUnits: ['mmol m-3'],
    canonicalUnit: 'mmol/m³',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.MODEL_CHLOROPHYLL]: {
    metric: EnvironmentMetric.MODEL_CHLOROPHYLL,
    productKey: CmemsProductKey.ARCTIC_BGC,
    datasetBase: 'cmems_mod_arc_bgc_anfc_ecosmo_P1D-m',
    variableId: 'chl',
    expectedSourceUnits: ['mg m-3'],
    canonicalUnit: 'mg/m³',
    requiresDepth: true,
    vector: null,
  },
  [EnvironmentMetric.WAVE_HEIGHT]: {
    metric: EnvironmentMetric.WAVE_HEIGHT,
    productKey: CmemsProductKey.ARCTIC_WAV,
    datasetBase: 'dataset-wam-arctic-1hr3km-be',
    variableId: 'VHM0',
    expectedSourceUnits: ['m'],
    canonicalUnit: 'm',
    requiresDepth: false,
    vector: null,
  },
  [EnvironmentMetric.WAVE_DIRECTION]: {
    metric: EnvironmentMetric.WAVE_DIRECTION,
    productKey: CmemsProductKey.ARCTIC_WAV,
    datasetBase: 'dataset-wam-arctic-1hr3km-be',
    variableId: 'VMDR',
    expectedSourceUnits: ['degree'],
    canonicalUnit: '°',
    requiresDepth: false,
    vector: null,
  },
  [EnvironmentMetric.WAVE_PERIOD]: {
    metric: EnvironmentMetric.WAVE_PERIOD,
    productKey: CmemsProductKey.ARCTIC_WAV,
    datasetBase: 'dataset-wam-arctic-1hr3km-be',
    variableId: 'VTM02',
    expectedSourceUnits: ['s'],
    canonicalUnit: 's',
    requiresDepth: false,
    vector: null,
  },
  [EnvironmentMetric.CURRENT_SPEED]: {
    metric: EnvironmentMetric.CURRENT_SPEED,
    productKey: CmemsProductKey.ARCTIC_PHY,
    datasetBase: 'cmems_mod_arc_phy_anfc_6km_detided_PT1H-i',
    variableId: 'sea_water_velocity',
    expectedSourceUnits: ['m s-1'],
    canonicalUnit: 'm/s',
    requiresDepth: true,
    vector: {
      speedMetric: EnvironmentMetric.CURRENT_SPEED,
      directionMetric: EnvironmentMetric.CURRENT_DIRECTION,
      component1VariableId: 'vxo',
      component2VariableId: 'vyo',
      reference: CmemsVectorReference.ARCTIC_POLAR_STEREOGRAPHIC_X_Y,
    },
  },
  [EnvironmentMetric.CURRENT_DIRECTION]: {
    metric: EnvironmentMetric.CURRENT_DIRECTION,
    productKey: CmemsProductKey.ARCTIC_PHY,
    datasetBase: 'cmems_mod_arc_phy_anfc_6km_detided_PT1H-i',
    variableId: 'sea_water_velocity',
    expectedSourceUnits: ['m s-1'],
    canonicalUnit: '°',
    requiresDepth: true,
    vector: {
      speedMetric: EnvironmentMetric.CURRENT_SPEED,
      directionMetric: EnvironmentMetric.CURRENT_DIRECTION,
      component1VariableId: 'vxo',
      component2VariableId: 'vyo',
      reference: CmemsVectorReference.ARCTIC_POLAR_STEREOGRAPHIC_X_Y,
    },
  },
};

export interface CmemsRegionalRequest {
  latitude: number;
  longitude: number;
  validAt: Date;
  requestedDepthM?: number;
  metrics?: readonly EnvironmentMetric[];
}

export interface CmemsEnvironmentValue {
  provider: EnvironmentProvider.CMEMS;
  metric: EnvironmentMetric;
  value: number | null;
  unit: string;
  productId: string;
  datasetId: string;
  variableId: string;
  sourceVariableIds: readonly string[];
  validAt: string;
  productMetadataUpdatedAt: string;
  capabilityUpdatedAt: string;
  dataUpdatedAt: string | null;
  fetchedAt: string;
  requestedDepthM: number | null;
  modelDepthM: number | null;
  horizontalResolutionM: number;
  gridDistanceM: number | null;
  qualityStatus: EnvironmentQualityStatus.PROVISIONAL;
  semanticClass: EnvironmentSemanticClass.ANALYSIS | EnvironmentSemanticClass.FORECAST;
  discoveryStale: boolean;
  capabilityStale: boolean;
}

export interface CmemsRegionalAvailable {
  status: 'AVAILABLE';
  region: CmemsRegion;
  requestedAt: string;
  values: CmemsEnvironmentValue[];
  coverage: EnvironmentSyncScopeCoverage[];
}

export interface CmemsRegionalNoData {
  status: 'NO_DATA';
  region: CmemsRegion;
  requestedAt: string;
  values: CmemsEnvironmentValue[];
  coverage: EnvironmentSyncScopeCoverage[];
}

export interface CmemsRegionalOutOfCoverage {
  status: 'OUT_OF_COVERAGE';
  region: null;
  requestedAt: string;
  values: [];
  coverage: EnvironmentSyncScopeCoverage[];
}

export interface CmemsRegionalProviderFailure {
  status: 'PROVIDER_FAILURE';
  region: CmemsRegion;
  requestedAt: string;
  values: [];
  coverage: EnvironmentSyncScopeCoverage[];
  errorCode: string;
  configurationError: boolean;
  retryAfterMs: number | null;
}

export type CmemsRegionalResult =
  | CmemsRegionalAvailable
  | CmemsRegionalNoData
  | CmemsRegionalOutOfCoverage
  | CmemsRegionalProviderFailure;

interface CmemsFailureDetails {
  errorCode: string;
  outcome:
    | EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
    | EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE;
  configurationError: boolean;
  retryAfterMs: number | null;
}

interface ResolvedQuery {
  definition: CmemsMetricDefinition;
  product: CmemsDiscoveredProduct;
  capabilities: CmemsLayerCapabilities;
  selectedTime: string;
  modelElevationM: number | null;
}

interface ParsedFeature {
  value: number | null;
  gridLatitude: number | null;
  gridLongitude: number | null;
  component1Value: number | null;
  component2Value: number | null;
}

export function selectCmemsRegion(latitude: number, longitude: number): CmemsRegion | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new RangeError('CMEMS coordinates are invalid');
  }
  if (longitude >= -16 && longitude <= 13 && latitude >= 46 && latitude <= 62.74324035644531) {
    return CmemsRegion.NORTH_WEST_SHELF;
  }
  if (latitude >= 50 && latitude <= 85.05112878) {
    return CmemsRegion.ARCTIC;
  }
  return null;
}

@Injectable()
export class CmemsRegionalService {
  private readonly clock: CmemsClock;

  constructor(
    private readonly registry: CmemsDatasetRegistry,
    private readonly http: CmemsHttpClient,
    @Optional() @Inject(CMEMS_CLOCK) clock?: CmemsClock,
  ) {
    this.clock = clock ?? SYSTEM_CLOCK;
  }

  async fetchEnvironment(request: CmemsRegionalRequest): Promise<CmemsRegionalResult> {
    const validated = this.validateRequest(request);
    const requestedAt = validated.validAt.toISOString();
    const region = selectCmemsRegion(validated.latitude, validated.longitude);
    if (!region) {
      const coverage = validated.metrics.map((metric) =>
        cmemsCoverageScope(
          metric,
          'CMEMS:REGIONAL_DOMAIN',
          validated.validAt,
          EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
          null,
          0,
        ),
      );
      return {
        status: 'OUT_OF_COVERAGE',
        region: null,
        requestedAt,
        values: [],
        coverage,
      };
    }
    const definitions =
      region === CmemsRegion.NORTH_WEST_SHELF ? NWS_DEFINITIONS : ARCTIC_DEFINITIONS;
    const plans = this.buildPlans(validated.metrics, definitions);
    const resolutionAttempts = await Promise.allSettled(
      plans.map((definition) => this.resolveQuery(definition, validated.validAt, validated.depthM)),
    );
    const coverage: EnvironmentSyncScopeCoverage[] = [];
    const resolved: ResolvedQuery[] = [];
    let firstFailure: CmemsFailureDetails | null = null;
    for (const [index, attempt] of resolutionAttempts.entries()) {
      const definition = plans[index]!;
      if (attempt.status === 'rejected') {
        const failure = cmemsFailureDetails(attempt.reason);
        firstFailure ??= failure;
        coverage.push(
          ...cmemsDefinitionCoverage(
            definition,
            validated.metrics,
            validated.validAt,
            failure.outcome,
            failure.errorCode,
            0,
          ),
        );
      } else if (attempt.value === null) {
        coverage.push(
          ...cmemsDefinitionCoverage(
            definition,
            validated.metrics,
            validated.validAt,
            EnvironmentSyncScopeOutcome.NO_DATA,
            null,
            0,
          ),
        );
      } else if (!this.isCovered(attempt.value, validated.latitude, validated.longitude)) {
        coverage.push(
          ...cmemsDefinitionCoverage(
            definition,
            validated.metrics,
            validated.validAt,
            EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
            null,
            0,
          ),
        );
      } else {
        resolved.push(attempt.value);
      }
    }

    if (resolved.length === 0 && coverage.every((scope) => isFailedCoverage(scope.outcome))) {
      return cmemsProviderFailure(region, requestedAt, coverage, firstFailure);
    }
    if (resolved.length === 0) {
      if (coverage.some((scope) => scope.outcome !== EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE)) {
        return {
          status: 'NO_DATA',
          region,
          requestedAt,
          values: [],
          coverage,
        };
      }
      return {
        status: 'OUT_OF_COVERAGE',
        region: null,
        requestedAt,
        values: [],
        coverage,
      };
    }

    const fetchAttempts = await Promise.allSettled(
      resolved.map((query) =>
        this.fetchQuery(query, {
          latitude: validated.latitude,
          longitude: validated.longitude,
          depthM: validated.depthM,
          requestedMetrics: validated.metrics,
        }),
      ),
    );
    const groups: CmemsEnvironmentValue[][] = [];
    for (const [index, attempt] of fetchAttempts.entries()) {
      const query = resolved[index]!;
      if (attempt.status === 'rejected') {
        const failure = cmemsFailureDetails(attempt.reason);
        firstFailure ??= failure;
        coverage.push(
          ...cmemsDefinitionCoverage(
            query.definition,
            validated.metrics,
            validated.validAt,
            failure.outcome,
            failure.errorCode,
            0,
          ),
        );
        continue;
      }
      groups.push(attempt.value);
      for (const metric of cmemsDefinitionMetrics(query.definition, validated.metrics)) {
        const value = attempt.value.find((candidate) => candidate.metric === metric);
        coverage.push(
          cmemsCoverageScope(
            metric,
            cmemsScopeKey(query.definition),
            validated.validAt,
            value?.value === null || value === undefined
              ? EnvironmentSyncScopeOutcome.NO_DATA
              : EnvironmentSyncScopeOutcome.AVAILABLE,
            null,
            value?.value === null || value === undefined ? 0 : 1,
          ),
        );
      }
    }
    if (coverage.every((scope) => isFailedCoverage(scope.outcome))) {
      return cmemsProviderFailure(region, requestedAt, coverage, firstFailure);
    }
    const requestedOrder = new Map(validated.metrics.map((metric, index) => [metric, index]));
    const values = groups
      .flat()
      .sort(
        (left, right) =>
          (requestedOrder.get(left.metric) ?? Number.MAX_SAFE_INTEGER) -
          (requestedOrder.get(right.metric) ?? Number.MAX_SAFE_INTEGER),
      );
    return {
      status: values.some((value) => value.value !== null) ? 'AVAILABLE' : 'NO_DATA',
      region,
      requestedAt,
      values,
      coverage,
    };
  }

  private isCovered(query: ResolvedQuery, latitude: number, longitude: number): boolean {
    return (
      longitude >= query.capabilities.bbox.west &&
      longitude <= query.capabilities.bbox.east &&
      latitude >= query.capabilities.bbox.south &&
      latitude <= query.capabilities.bbox.north
    );
  }

  private validateRequest(request: CmemsRegionalRequest): {
    latitude: number;
    longitude: number;
    validAt: Date;
    depthM: number;
    metrics: EnvironmentMetric[];
  } {
    selectCmemsRegion(request.latitude, request.longitude);
    if (!(request.validAt instanceof Date) || Number.isNaN(request.validAt.getTime())) {
      throw new RangeError('validAt must be a valid Date');
    }
    const nowMs = this.clock.now().getTime();
    const requestedMs = request.validAt.getTime();
    if (requestedMs < nowMs - MAX_HISTORY_MS || requestedMs > nowMs + MAX_FORECAST_MS) {
      throw new RangeError('validAt must be within the past 30 days and next 7 days');
    }
    const depthM = request.requestedDepthM ?? 0;
    if (!Number.isFinite(depthM) || depthM < 0 || depthM > MAX_MODEL_DEPTH_M) {
      throw new RangeError('requestedDepthM must be between 0 and 10000 metres');
    }
    const metrics = request.metrics
      ? Array.from(new Set(request.metrics))
      : [...CMEMS_ENVIRONMENT_METRICS];
    if (metrics.length === 0 || metrics.some((metric) => !CMEMS_METRIC_SET.has(metric))) {
      throw new RangeError('metrics contains an unsupported CMEMS metric');
    }
    return {
      latitude: request.latitude,
      longitude: request.longitude,
      validAt: request.validAt,
      depthM,
      metrics,
    };
  }

  private buildPlans(
    metrics: readonly EnvironmentMetric[],
    definitions: CmemsRegionDefinitions,
  ): CmemsMetricDefinition[] {
    const plans = new Map<string, CmemsMetricDefinition>();
    for (const metric of metrics) {
      const definition = definitions[metric];
      if (!definition) {
        throw new CmemsProviderError({
          code: CmemsProviderErrorCode.CONFIGURATION,
          message: 'CMEMS metric mapping is incomplete',
          retryable: false,
        });
      }
      const key = `${definition.productKey}/${definition.datasetBase}/${definition.variableId}`;
      plans.set(key, definition);
    }
    return Array.from(plans.values());
  }

  private async resolveQuery(
    definition: CmemsMetricDefinition,
    requestedAt: Date,
    requestedDepthM: number,
  ): Promise<ResolvedQuery | null> {
    const product = await this.registry.resolveProduct(definition.productKey);
    const capabilities = await this.registry.resolveCapabilities({
      product,
      datasetBase: definition.datasetBase,
      variableId: definition.variableId,
      expectedUnits: definition.expectedSourceUnits,
      requiresDepth: definition.requiresDepth,
    });
    const selectedTime = selectNearestCmemsTime(capabilities, requestedAt);
    if (!selectedTime) {
      return null;
    }
    return {
      definition,
      product,
      capabilities,
      selectedTime,
      modelElevationM: selectNearestCmemsElevation(capabilities, requestedDepthM),
    };
  }

  private async fetchQuery(
    query: ResolvedQuery,
    request: {
      latitude: number;
      longitude: number;
      depthM: number;
      requestedMetrics: readonly EnvironmentMetric[];
    },
  ): Promise<CmemsEnvironmentValue[]> {
    const response = await this.http.getFeatureInfo(
      buildCmemsFeatureInfoUrl({
        productId: query.capabilities.productId,
        datasetId: query.capabilities.datasetId,
        variableId: query.capabilities.variableId,
        latitude: request.latitude,
        longitude: request.longitude,
        validAt: query.selectedTime,
        modelElevationM: query.modelElevationM,
      }),
    );
    const parsed =
      response.status === 'NO_DATA' ? emptyFeature() : parseFeatureInfo(response.payload, query);
    const fetchedAt = response.fetchedAt;
    const gridDistanceM =
      parsed.gridLatitude === null || parsed.gridLongitude === null
        ? null
        : haversineDistanceM(
            request.latitude,
            request.longitude,
            parsed.gridLatitude,
            parsed.gridLongitude,
          );
    const base = {
      provider: EnvironmentProvider.CMEMS as const,
      productId: query.capabilities.productId,
      datasetId: query.capabilities.datasetId,
      variableId: query.capabilities.variableId,
      validAt: query.selectedTime,
      productMetadataUpdatedAt: query.product.metadataUpdatedAt,
      capabilityUpdatedAt: query.capabilities.updatedAt,
      dataUpdatedAt: query.capabilities.dataUpdatedAt,
      fetchedAt,
      requestedDepthM: query.definition.requiresDepth ? request.depthM : null,
      modelDepthM: query.modelElevationM === null ? null : -query.modelElevationM,
      horizontalResolutionM: query.product.product.resolutionM,
      gridDistanceM,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL as const,
      semanticClass:
        new Date(query.selectedTime).getTime() <= this.clock.now().getTime()
          ? (EnvironmentSemanticClass.ANALYSIS as const)
          : (EnvironmentSemanticClass.FORECAST as const),
      discoveryStale: query.product.stale,
      capabilityStale: query.capabilities.stale,
    };

    if (!query.definition.vector) {
      return [
        {
          ...base,
          metric: query.definition.metric,
          value: parsed.value,
          unit: query.definition.canonicalUnit,
          sourceVariableIds: [query.definition.variableId],
        },
      ];
    }

    const vector = query.definition.vector;
    const speedRequested = request.requestedMetrics.includes(vector.speedMetric);
    const directionRequested = request.requestedMetrics.includes(vector.directionMetric);
    const eastNorth =
      parsed.component1Value === null || parsed.component2Value === null
        ? null
        : cmemsVectorToEastNorth(
            vector.reference,
            parsed.component1Value,
            parsed.component2Value,
            request.longitude,
          );
    const direction =
      eastNorth === null || Math.hypot(eastNorth[0], eastNorth[1]) === 0
        ? null
        : currentToDirectionDegrees(eastNorth[0], eastNorth[1]);
    const values: CmemsEnvironmentValue[] = [];
    if (speedRequested) {
      values.push({
        ...base,
        metric: vector.speedMetric,
        value: parsed.value,
        unit: 'm/s',
        sourceVariableIds: [vector.component1VariableId, vector.component2VariableId],
      });
    }
    if (directionRequested) {
      values.push({
        ...base,
        metric: vector.directionMetric,
        value: direction,
        unit: '°',
        sourceVariableIds: [vector.component1VariableId, vector.component2VariableId],
      });
    }
    return values;
  }
}

function cmemsDefinitionMetrics(
  definition: CmemsMetricDefinition,
  requestedMetrics: readonly EnvironmentMetric[],
): EnvironmentMetric[] {
  if (!definition.vector) return [definition.metric];
  return [definition.vector.speedMetric, definition.vector.directionMetric].filter((metric) =>
    requestedMetrics.includes(metric),
  );
}

function cmemsScopeKey(definition: CmemsMetricDefinition): string {
  return `CMEMS:${definition.productKey}:${definition.datasetBase}`;
}

function cmemsCoverageScope(
  metric: EnvironmentMetric,
  scopeKey: string,
  validAt: Date,
  outcome: EnvironmentSyncScopeOutcome,
  errorCode: string | null,
  observationCount: number,
): EnvironmentSyncScopeCoverage {
  return {
    scopeKind: EnvironmentSyncScopeKind.METRIC_HORIZON,
    scopeKey,
    metric,
    validFrom: validAt,
    validTo: validAt,
    outcome,
    errorCode,
    observationCount,
  };
}

function cmemsDefinitionCoverage(
  definition: CmemsMetricDefinition,
  requestedMetrics: readonly EnvironmentMetric[],
  validAt: Date,
  outcome: EnvironmentSyncScopeOutcome,
  errorCode: string | null,
  observationCount: number,
): EnvironmentSyncScopeCoverage[] {
  return cmemsDefinitionMetrics(definition, requestedMetrics).map((metric) =>
    cmemsCoverageScope(
      metric,
      cmemsScopeKey(definition),
      validAt,
      outcome,
      errorCode,
      observationCount,
    ),
  );
}

function cmemsFailureDetails(error: unknown): CmemsFailureDetails {
  if (error instanceof CmemsProviderError) {
    const configurationError = [
      CmemsProviderErrorCode.CONFIGURATION,
      CmemsProviderErrorCode.CLIENT_REQUEST,
    ].includes(error.code);
    return {
      errorCode: `CMEMS_${error.code}`,
      outcome: configurationError
        ? EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
        : EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE,
      configurationError,
      retryAfterMs: error.retryAfterMs ?? null,
    };
  }
  return {
    errorCode: 'CMEMS_UNEXPECTED_ERROR',
    outcome: EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE,
    configurationError: false,
    retryAfterMs: null,
  };
}

function isFailedCoverage(outcome: EnvironmentSyncScopeOutcome): boolean {
  return (
    outcome === EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE ||
    outcome === EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR
  );
}

function cmemsProviderFailure(
  region: CmemsRegion,
  requestedAt: string,
  coverage: EnvironmentSyncScopeCoverage[],
  firstFailure: CmemsFailureDetails | null,
): CmemsRegionalProviderFailure {
  const failure = firstFailure ?? cmemsFailureDetails(new Error('CMEMS provider failure'));
  return {
    status: 'PROVIDER_FAILURE',
    region,
    requestedAt,
    values: [],
    coverage,
    errorCode: failure.errorCode,
    configurationError: failure.configurationError,
    retryAfterMs: failure.retryAfterMs,
  };
}

function emptyFeature(): ParsedFeature {
  return {
    value: null,
    gridLatitude: null,
    gridLongitude: null,
    component1Value: null,
    component2Value: null,
  };
}

function readNullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return requireFiniteCmemsNumber(value, path);
}

function requireString(parent: Record<string, unknown>, key: string, path: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw cmemsSchemaError(path);
  }
  return value;
}

function assertCmemsSourceValue(variableId: string, value: number | null): void {
  if (value === null) return;
  let invalid: boolean;
  switch (variableId) {
    case 'thetao':
      invalid = value < -273.15;
      break;
    case 'VMDR':
      invalid = value < 0 || value > 360;
      break;
    case 'so':
    case 'o2':
    case 'chl':
    case 'VHM0':
    case 'VTM02':
    case 'sea_water_velocity':
      invalid = value < 0;
      break;
    default:
      throw cmemsSchemaError('FeatureCollection.features[0].properties.variableId');
  }
  if (invalid) {
    throw cmemsSchemaError('FeatureCollection.features[0].properties.value.range');
  }
}

function parseFeatureInfo(payload: unknown, query: ResolvedQuery): ParsedFeature {
  if (
    !isUnknownRecord(payload) ||
    payload.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features)
  ) {
    throw cmemsSchemaError('FeatureCollection');
  }
  if (payload.features.length === 0) return emptyFeature();
  if (payload.features.length !== 1) {
    throw cmemsSchemaError('FeatureCollection.features');
  }
  const feature = payload.features[0];
  if (
    !isUnknownRecord(feature) ||
    feature.type !== 'Feature' ||
    !isUnknownRecord(feature.geometry) ||
    feature.geometry.type !== 'Point' ||
    !Array.isArray(feature.geometry.coordinates) ||
    feature.geometry.coordinates.length !== 2 ||
    !isUnknownRecord(feature.properties)
  ) {
    throw cmemsSchemaError('FeatureCollection.features[0]');
  }
  const properties = feature.properties;
  const latitude = requireFiniteCmemsNumber(
    properties.lat,
    'FeatureCollection.features[0].properties.lat',
  );
  const longitude = requireFiniteCmemsNumber(
    properties.lon,
    'FeatureCollection.features[0].properties.lon',
  );
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw cmemsSchemaError('FeatureCollection.features[0].properties.coordinates');
  }
  const geometryLatitude = requireFiniteCmemsNumber(
    feature.geometry.coordinates[0],
    'FeatureCollection.features[0].geometry.coordinates[0]',
  );
  const geometryLongitude = requireFiniteCmemsNumber(
    feature.geometry.coordinates[1],
    'FeatureCollection.features[0].geometry.coordinates[1]',
  );
  if (geometryLatitude !== latitude || geometryLongitude !== longitude) {
    throw cmemsSchemaError('FeatureCollection.features[0].geometry.coordinates');
  }
  if (
    requireString(
      properties,
      'variableId',
      'FeatureCollection.features[0].properties.variableId',
    ) !== query.capabilities.variableId ||
    requireString(properties, 'datasetId', 'FeatureCollection.features[0].properties.datasetId') !==
      `${query.capabilities.productId}/${query.capabilities.datasetId}` ||
    requireString(properties, 'units', 'FeatureCollection.features[0].properties.units') !==
      query.capabilities.sourceUnit ||
    !Object.prototype.hasOwnProperty.call(properties, 'value')
  ) {
    throw cmemsSchemaError('FeatureCollection.features[0].properties.identity');
  }
  const value = readNullableNumber(
    properties.value,
    'FeatureCollection.features[0].properties.value',
  );
  assertCmemsSourceValue(query.capabilities.variableId, value);
  if (!query.definition.vector) {
    return {
      value,
      gridLatitude: latitude,
      gridLongitude: longitude,
      component1Value: null,
      component2Value: null,
    };
  }

  const vector = query.definition.vector;
  const component1Id = requireString(
    properties,
    'component1VariableId',
    'FeatureCollection.features[0].properties.component1VariableId',
  );
  const component2Id = requireString(
    properties,
    'component2VariableId',
    'FeatureCollection.features[0].properties.component2VariableId',
  );
  const component1Units = requireString(
    properties,
    'component1Units',
    'FeatureCollection.features[0].properties.component1Units',
  );
  const component2Units = requireString(
    properties,
    'component2Units',
    'FeatureCollection.features[0].properties.component2Units',
  );
  if (
    component1Id !== vector.component1VariableId ||
    component2Id !== vector.component2VariableId ||
    component1Units !== query.capabilities.sourceUnit ||
    component2Units !== query.capabilities.sourceUnit
  ) {
    throw cmemsSchemaError('FeatureCollection.features[0].properties.components');
  }
  if (
    !Object.prototype.hasOwnProperty.call(properties, 'component1Value') ||
    !Object.prototype.hasOwnProperty.call(properties, 'component2Value')
  ) {
    throw cmemsSchemaError('FeatureCollection.features[0].properties.components');
  }
  const component1Value = readNullableNumber(
    properties.component1Value,
    'FeatureCollection.features[0].properties.component1Value',
  );
  const component2Value = readNullableNumber(
    properties.component2Value,
    'FeatureCollection.features[0].properties.component2Value',
  );
  const allVectorValuesNull =
    value === null && component1Value === null && component2Value === null;
  const allVectorValuesPresent =
    value !== null && component1Value !== null && component2Value !== null;
  if (!allVectorValuesNull && !allVectorValuesPresent) {
    throw cmemsSchemaError('FeatureCollection.features[0].properties.vectorNullability');
  }
  if (value !== null && component1Value !== null && component2Value !== null) {
    const magnitude = Math.hypot(component1Value, component2Value);
    const tolerance = Math.max(VECTOR_TOLERANCE_ABSOLUTE, magnitude * VECTOR_TOLERANCE_RELATIVE);
    if (Math.abs(magnitude - value) > tolerance) {
      throw cmemsSchemaError('FeatureCollection.features[0].properties.vectorMagnitude');
    }
  }
  return {
    value,
    gridLatitude: latitude,
    gridLongitude: longitude,
    component1Value,
    component2Value,
  };
}

/**
 * Converts provider current components into local east/north components.
 * Arctic vxo/vyo are aligned with the product's polar-stereographic x/y
 * axes, whose central meridian is 45°W; uo/vo products are already
 * eastward/northward.
 */
export function cmemsVectorToEastNorth(
  reference: CmemsVectorReference,
  component1Value: number,
  component2Value: number,
  longitude: number,
): readonly [number, number] {
  if (
    !Number.isFinite(component1Value) ||
    !Number.isFinite(component2Value) ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new RangeError('CMEMS vector components and longitude must be finite');
  }
  if (reference === CmemsVectorReference.EAST_NORTH) {
    return [component1Value, component2Value];
  }

  const convergenceRadians =
    ((longitude - ARCTIC_POLAR_STEREOGRAPHIC_CENTRAL_MERIDIAN_DEGREES) * Math.PI) / 180;
  const cosine = Math.cos(convergenceRadians);
  const sine = Math.sin(convergenceRadians);
  return [
    component1Value * cosine + component2Value * sine,
    -component1Value * sine + component2Value * cosine,
  ];
}

export function currentToDirectionDegrees(eastwardValue: number, northwardValue: number): number {
  if (!Number.isFinite(eastwardValue) || !Number.isFinite(northwardValue)) {
    throw new RangeError('current vector components must be finite');
  }
  const direction = (Math.atan2(eastwardValue, northwardValue) * 180) / Math.PI;
  return (direction + 360) % 360;
}

export function haversineDistanceM(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const firstLatitude = toRadians(latitudeA);
  const secondLatitude = toRadians(latitudeB);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}
