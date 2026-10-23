import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

/** A plan to take a cohort of Suderra OS devices to an agent release or an OS bundle, in waves. */
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

  @Field(() => EdgeUpdateTermsInput)
  @ValidateNested()
  @Type(() => EdgeUpdateTermsInput)
  terms!: EdgeUpdateTermsInput;

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
