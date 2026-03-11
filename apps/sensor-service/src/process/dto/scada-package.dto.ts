import { InputType, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsUUID, MaxLength, IsObject, IsArray } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import { ScadaPackageStatus } from '../entities/scada-package.entity';

// ============================================================================
// Input DTOs
// ============================================================================

@InputType()
export class CreateScadaPackageInput {
  @Field()
  @IsString()
  @MaxLength(255)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  processId?: string;

  @Field(() => GraphQLJSON)
  @IsObject()
  packageData!: Record<string, unknown>;
}

@InputType()
export class UpdateScadaPackageInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  processId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  packageData?: Record<string, unknown>;

  @Field(() => ScadaPackageStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ScadaPackageStatus)
  status?: ScadaPackageStatus;
}

@InputType()
export class ScadaPackageFilterInput {
  @Field(() => ScadaPackageStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ScadaPackageStatus)
  status?: ScadaPackageStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  processId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  searchTerm?: string;
}

// ============================================================================
// Output DTOs
// ============================================================================

@ObjectType()
export class ScadaPackageType {
  @Field(() => ID)
  id!: string;

  @Field()
  tenantId!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Int)
  version!: number;

  @Field({ nullable: true })
  processId?: string;

  @Field({ nullable: true })
  processName?: string;

  @Field(() => GraphQLJSON)
  packageData!: Record<string, unknown>;

  @Field(() => ScadaPackageStatus)
  status!: ScadaPackageStatus;

  @Field({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  updatedBy?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class ScadaPackageListType {
  @Field(() => [ScadaPackageType])
  items!: ScadaPackageType[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  offset!: number;

  @Field(() => Int)
  limit!: number;

  @Field()
  hasMore!: boolean;
}

@ObjectType()
export class DeployScadaPackageResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => ID, { nullable: true })
  packageId?: string;

  @Field(() => ID, { nullable: true })
  deviceId?: string;
}

// ============================================================================
// Unified Deploy (SCADA + Automation) DTOs
// ============================================================================

@InputType()
export class DeployScadaWithAutomationInput {
  @Field(() => ID)
  @IsUUID()
  packageId!: string;

  @Field(() => ID)
  @IsUUID()
  deviceId!: string;

  @Field(() => [ID], { nullable: true, description: 'Override which automation programs to deploy. If omitted, uses programs from package automationBindings.' })
  @IsOptional()
  @IsArray()
  programIds?: string[];
}

@ObjectType()
export class AutomationDeployStepResultType {
  @Field(() => ID)
  programId!: string;

  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field({ nullable: true })
  commandId?: string;
}

@ObjectType()
export class ScadaDeployStepResultType {
  @Field(() => ID)
  packageId!: string;

  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;
}

@ObjectType()
export class UnifiedDeployResultType {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => [AutomationDeployStepResultType])
  automationResults!: AutomationDeployStepResultType[];

  @Field(() => ScadaDeployStepResultType, { nullable: true })
  scadaResult?: ScadaDeployStepResultType;
}
