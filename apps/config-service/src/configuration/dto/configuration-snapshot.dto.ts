import { Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import GraphQLJSON from 'graphql-type-json';

import { ConfigEnvironment } from '../entities/configuration.entity';
import {
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationSnapshotSourceV1,
  ConfigurationSnapshotStateV1,
} from '../generated/configuration-graphql.generated';

export enum ConfigurationSnapshotReadinessV1 {
  READY = 'READY',
  RED = 'RED',
}

registerEnumType(ConfigurationSnapshotReadinessV1, {
  name: 'ConfigurationSnapshotReadinessV1',
});

@InputType()
export class ConfigurationScopeInputV1 {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID()
  targetTenantId?: string;

  @Field(() => ConfigEnvironment, { defaultValue: ConfigEnvironment.ALL })
  @IsEnum(ConfigEnvironment)
  environment: ConfigEnvironment = ConfigEnvironment.ALL;
}

@ObjectType()
export class ConfigurationSnapshotEntryV1 {
  @Field(() => ConfigurationKeyId)
  keyId!: ConfigurationKeyId;

  @Field(() => ConfigurationSnapshotStateV1)
  state!: ConfigurationSnapshotStateV1;

  @Field(() => ConfigurationSnapshotSourceV1)
  source!: ConfigurationSnapshotSourceV1;

  @Field(() => GraphQLJSON, { nullable: true })
  value!: unknown;

  @Field(() => String, { nullable: true })
  sourceTenantId!: string | null;

  @Field(() => String, { nullable: true })
  effectiveVersion!: string | null;

  @Field()
  mutable!: boolean;

  @Field()
  required!: boolean;

  @Field()
  requiresRestart!: boolean;

  @Field()
  fallbackSuppressed!: boolean;
}

@ObjectType()
export class ConfigurationSnapshotV1 {
  @Field()
  catalogDigest!: string;

  @Field()
  tenantId!: string;

  @Field(() => ConfigEnvironment)
  environment!: ConfigEnvironment;

  @Field()
  scopeRevision!: string;

  @Field()
  snapshotToken!: string;

  @Field(() => ConfigurationSnapshotReadinessV1)
  readiness!: ConfigurationSnapshotReadinessV1;

  @Field(() => [ConfigurationKeyId])
  missingRequiredKeys!: ConfigurationKeyId[];

  @Field(() => [ConfigurationKeyId])
  invalidKeys!: ConfigurationKeyId[];

  @Field(() => [String])
  catalogMismatches!: string[];

  @Field(() => [ConfigurationSnapshotEntryV1])
  entries!: ConfigurationSnapshotEntryV1[];
}

@InputType()
export class ConfigurationChangeInputV1 {
  @Field(() => ConfigurationKeyId)
  @IsEnum(ConfigurationKeyId)
  keyId!: ConfigurationKeyId;

  @Field(() => ConfigurationChangeIntentV1)
  @IsEnum(ConfigurationChangeIntentV1)
  intent!: ConfigurationChangeIntentV1;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  value?: string;
}

@InputType()
export class ApplyConfigurationBatchInputV1 extends ConfigurationScopeInputV1 {
  @Field()
  @IsUUID()
  operationId!: string;

  @Field()
  @IsString()
  @Length(64, 64)
  catalogDigest!: string;

  @Field()
  @IsString()
  @Length(64, 64)
  expectedSnapshotToken!: string;

  @Field()
  @IsString()
  @Length(1, 255)
  reason!: string;

  @Field(() => [ConfigurationChangeInputV1])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConfigurationChangeInputV1)
  changes!: ConfigurationChangeInputV1[];
}

@ObjectType()
export class ConfigurationChangeReceiptEntryV1 {
  @Field(() => ConfigurationKeyId)
  keyId!: ConfigurationKeyId;

  @Field(() => ConfigurationChangeIntentV1)
  intent!: ConfigurationChangeIntentV1;

  @Field(() => Int, { nullable: true })
  version!: number | null;
}

@ObjectType()
export class ConfigurationBatchReceiptV1 {
  @Field()
  operationId!: string;

  @Field()
  catalogDigest!: string;

  @Field()
  tenantId!: string;

  @Field(() => ConfigEnvironment)
  environment!: ConfigEnvironment;

  @Field()
  previousSnapshotToken!: string;

  @Field()
  resultingSnapshotToken!: string;

  @Field()
  scopeRevision!: string;

  @Field(() => [ConfigurationChangeReceiptEntryV1])
  changes!: ConfigurationChangeReceiptEntryV1[];

  @Field()
  replayed!: boolean;
}
