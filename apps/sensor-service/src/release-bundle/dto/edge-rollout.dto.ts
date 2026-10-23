import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GraphQLJSON } from 'graphql-scalars';

import { EdgeRolloutDevicePhase, EdgeRolloutKind } from '../entities/edge-rollout.entity';

/** The terms root applies an update under (DEC-13.4): approval on site, blockers override, outage budget. */
@InputType()
export class EdgeUpdateTermsInput {
  @Field()
  @IsBoolean()
  localApproval!: boolean;

  @Field()
  @IsBoolean()
  blockersOverride!: boolean;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(86_400)
  maxOutageSeconds!: number;
}

/** An OS bundle an operator registered for one board's images. */
@InputType()
export class EdgeOsBundleInput {
  @Field()
  @IsString()
  @Length(1, 32)
  version!: string;

  @Field()
  @IsString()
  @Length(1, 32)
  rollbackFloor!: string;

  @Field()
  @IsString()
  @Length(1, 32)
  minCurrentVersion!: string;

  @Field()
  @IsString()
  @Matches(/^[0-9]+-[0-9]+$/)
  supportedAgentAbi!: string;

  @Field()
  @IsString()
  @Length(1, 2048)
  url!: string;

  @Field()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sha256!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

/** One operator-authored site file of a site-config rollout. */
@InputType()
export class EdgeSiteFileInput {
  /** A fixed site path other than config.yaml, which the cloud renders itself. */
  @Field()
  @IsString()
  @Length(1, 64)
  path!: string;

  /** The file's bytes, base64. */
  @Field()
  @IsString()
  @Matches(/^[A-Za-z0-9+/]*={0,2}$/)
  contentBase64!: string;
}

/**
 * A plan to take a cohort of Suderra OS devices to an agent release, an OS bundle, a site
 * config, a site network policy or the trust-anchors bundle, in waves. Which of `version`,
 * `osBundle`, `siteFiles` and `netpolicy` (with `terms` for the first two) a plan names is
 * decided by `kind`; naming another kind's member is refused.
 */
@InputType()
export class CreateEdgeRolloutInput {
  @Field()
  @IsString()
  @Length(1, 120)
  name!: string;

  @Field(() => EdgeRolloutKind)
  @IsEnum(EdgeRolloutKind)
  kind!: EdgeRolloutKind;

  /** The agent release version, for an edge-update rollout. */
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  version?: string;

  /** The OS bundle, for an os-update rollout. */
  @Field(() => EdgeOsBundleInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EdgeOsBundleInput)
  osBundle?: EdgeOsBundleInput;

  /** The terms of an agent or OS update. */
  @Field(() => EdgeUpdateTermsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => EdgeUpdateTermsInput)
  terms?: EdgeUpdateTermsInput;

  /** The operator's site files of a site-config rollout (none: a refresh of config.yaml and the RBAC manifest). */
  @Field(() => [EdgeSiteFileInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => EdgeSiteFileInput)
  siteFiles?: EdgeSiteFileInput[];

  /** The policy of a site-netpolicy rollout, in the contract's own form: `interfaces`, `ot_rules`, `time_sources`. */
  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  netpolicy?: Record<string, unknown>;

  /** The first moment the statements are valid; omitted, from when each is signed. */
  @Field(() => Date, { nullable: true })
  @IsOptional()
  @IsDate()
  windowNotBefore?: Date;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(86_400)
  windowSeconds!: number;

  /** The rollout halts when more devices than this fail. */
  @Field(() => Int)
  @IsInt()
  @Min(0)
  maxFailures!: number;

  /** Device ids, wave by wave; wave n+1 starts only after wave n concluded. */
  @Field(() => [[ID]])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  waves!: string[][];
}

/** Where one device of a rollout stands. */
@ObjectType('EdgeRolloutDeviceStatus')
export class EdgeRolloutDeviceStatusType {
  @Field(() => ID)
  deviceId!: string;

  @Field(() => Int)
  wave!: number;

  @Field(() => EdgeRolloutDevicePhase)
  phase!: EdgeRolloutDevicePhase;

  /** The state of the latest request of the device's campaign. */
  @Field(() => String, { nullable: true })
  requestState!: string | null;

  /** Why the device failed, when it did and the cloud knows. */
  @Field(() => String, { nullable: true })
  detail!: string | null;
}

@ObjectType('EdgeRolloutProgress')
export class EdgeRolloutProgressType {
  @Field(() => Int)
  queued!: number;

  @Field(() => Int)
  inFlight!: number;

  @Field(() => Int)
  done!: number;

  @Field(() => Int)
  failed!: number;
}
