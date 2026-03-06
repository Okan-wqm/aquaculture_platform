import { InputType, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { IsOptional, IsUUID, IsInt, Min, Max } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { ScadaDeployStatus } from '../entities/scada-deploy-log.entity';

// ============================================================================
// Output DTOs
// ============================================================================

@ObjectType()
export class ScadaDeployLogType {
  @Field(() => ID)
  id!: string;

  @Field()
  tenantId!: string;

  @Field()
  packageId!: string;

  @Field()
  deviceId!: string;

  @Field()
  commandId!: string;

  @Field(() => Int)
  version!: number;

  @Field(() => ScadaDeployStatus)
  status!: ScadaDeployStatus;

  @Field()
  sentAt!: Date;

  @Field({ nullable: true })
  receivedAt?: Date;

  @Field({ nullable: true })
  deployedAt?: Date;

  @Field({ nullable: true })
  verifiedAt?: Date;

  @Field(() => GraphQLJSON, { nullable: true })
  healthCheckResults?: Record<string, unknown>;

  @Field({ nullable: true })
  errorMessage?: string;

  @Field(() => Int, { nullable: true })
  rolledBackTo?: number;

  @Field({ nullable: true })
  deployedBy?: string;

  @Field()
  createdAt!: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

@ObjectType()
export class ScadaDeployLogListType {
  @Field(() => [ScadaDeployLogType])
  items!: ScadaDeployLogType[];

  @Field(() => Int)
  total!: number;
}

// ============================================================================
// Input DTOs
// ============================================================================

@InputType()
export class DeployLogFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  packageId?: string;

  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
