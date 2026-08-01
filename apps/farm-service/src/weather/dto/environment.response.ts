import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

import {
  EnvironmentAvailabilityStatus,
  EnvironmentLayerCapability,
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  SatelliteCoverageStatus,
} from '../entities/environment-observation.types';

@ObjectType()
export class EnvironmentCoverageScopeResponse {
  @Field(() => EnvironmentProvider)
  provider!: EnvironmentProvider;

  @Field(() => EnvironmentMetric, { nullable: true })
  metric!: EnvironmentMetric | null;

  @Field(() => EnvironmentSyncScopeKind)
  scopeKind!: EnvironmentSyncScopeKind;

  @Field()
  scopeKey!: string;

  @Field(() => Date, { nullable: true })
  validFrom!: Date | null;

  @Field(() => Date, { nullable: true })
  validTo!: Date | null;

  @Field(() => EnvironmentSyncScopeOutcome)
  outcome!: EnvironmentSyncScopeOutcome;

  @Field(() => String, { nullable: true })
  errorCode!: string | null;

  @Field(() => Int)
  observationCount!: number;

  @Field()
  completedAt!: Date;
}

@ObjectType()
export class EnvironmentCoverageSummaryResponse {
  @Field(() => Int)
  expected!: number;

  @Field(() => Int)
  successful!: number;

  @Field(() => Int)
  failed!: number;

  @Field(() => Int)
  noData!: number;

  @Field(() => Int)
  outOfCoverage!: number;

  @Field(() => [EnvironmentCoverageScopeResponse])
  scopes!: EnvironmentCoverageScopeResponse[];
}

@ObjectType()
export class EnvironmentValueResponse {
  @Field(() => EnvironmentMetric)
  metric!: EnvironmentMetric;

  @Field(() => Float)
  value!: number;

  @Field()
  unit!: string;

  @Field(() => EnvironmentProvider)
  source!: EnvironmentProvider;

  @Field(() => EnvironmentSemanticClass)
  semanticClass!: EnvironmentSemanticClass;

  @Field()
  validAt!: Date;

  @Field(() => Date, { nullable: true })
  issuedAt?: Date | null;

  @Field()
  fetchedAt!: Date;

  @Field(() => EnvironmentQualityStatus)
  qualityStatus!: EnvironmentQualityStatus;

  @Field(() => Float, { nullable: true })
  depthM?: number | null;

  @Field(() => Float, { nullable: true })
  requestedDepthM?: number | null;

  @Field()
  datasetId!: string;

  @Field()
  productId!: string;

  @Field()
  variableId!: string;

  @Field(() => Float, { nullable: true })
  resolutionM?: number | null;

  @Field(() => Float, { nullable: true })
  gridCellDistanceM?: number | null;

  @Field(() => Int)
  locationRevision!: number;

  @Field(() => String, { nullable: true })
  stationId?: string | null;

  @Field(() => Float, { nullable: true })
  stationDistanceKm?: number | null;
}

@ObjectType()
export class SiteEnvironmentValuesResponse {
  @Field(() => ID)
  siteId!: string;

  @Field(() => [EnvironmentValueResponse])
  values!: EnvironmentValueResponse[];
}

@ObjectType()
export class EnvironmentLayerResponse {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field()
  description!: string;

  @Field()
  scientificLabel!: string;

  @Field(() => EnvironmentProvider)
  source!: EnvironmentProvider;

  @Field(() => [EnvironmentProvider])
  sources!: EnvironmentProvider[];

  @Field(() => EnvironmentSemanticClass)
  semanticClass!: EnvironmentSemanticClass;

  @Field(() => String, { nullable: true })
  unit?: string | null;

  @Field(() => EnvironmentMetric, { nullable: true })
  metric?: EnvironmentMetric | null;

  @Field(() => [EnvironmentLayerCapability])
  capabilities!: EnvironmentLayerCapability[];

  @Field()
  supportsDepth!: boolean;

  @Field(() => Float, { nullable: true })
  nominalResolutionM?: number | null;

  @Field()
  resolutionLabel!: string;

  @Field(() => Float, { nullable: true })
  minValue?: number | null;

  @Field(() => Float, { nullable: true })
  maxValue?: number | null;

  @Field(() => EnvironmentAvailabilityStatus)
  availability!: EnvironmentAvailabilityStatus;

  @Field(() => Date, { nullable: true })
  availableFrom?: Date | null;

  @Field(() => Date, { nullable: true })
  availableTo?: Date | null;

  @Field(() => EnvironmentCoverageSummaryResponse)
  coverage!: EnvironmentCoverageSummaryResponse;
}

@ObjectType()
export class EnvironmentSceneResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  sceneId!: string;

  @Field()
  collection!: string;

  @Field()
  productId!: string;

  @Field()
  datasetId!: string;

  @Field()
  acquiredAt!: Date;

  @Field(() => Float, { nullable: true })
  cloudCoverPercent?: number | null;

  @Field(() => Float, { nullable: true })
  coveragePercent?: number | null;

  @Field(() => SatelliteCoverageStatus)
  coverageStatus!: SatelliteCoverageStatus;

  @Field()
  coverageMethod!: string;

  /** AOI grid-point count; null only for legacy rows with unknown method. */
  @Field(() => Int, { nullable: true })
  coverageSampleCount!: number | null;

  @Field(() => EnvironmentQualityStatus)
  qualityStatus!: EnvironmentQualityStatus;

  @Field(() => Int)
  locationRevision!: number;

  @Field()
  fetchedAt!: Date;

  @Field()
  cursor!: string;
}

@ObjectType()
export class EnvironmentSceneConnection {
  @Field(() => ID)
  siteId!: string;

  @Field(() => [EnvironmentSceneResponse])
  nodes!: EnvironmentSceneResponse[];

  @Field()
  hasNextPage!: boolean;

  @Field(() => String, { nullable: true })
  endCursor?: string | null;
}
