import { InputType, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { IsString, IsOptional, IsEnum, IsUUID, MaxLength, IsObject, IsArray } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

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
  // SSoT: the package id is the `updateScadaPackage(id: ID!, input: …)` resolver
  // arg (process.resolver.ts) — the service looks the row up by that arg, never
  // by an input field. A second required `id` here was dual-source and forced
  // every client to send the id twice; the FE only sends the top-level arg, so
  // the redundant required field rejected every update. Removed (id is the arg).
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
export class ScadaPackageListType extends StandardPaginatedResponse(ScadaPackageType) {}

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

/**
 * Result of the V2 packageData backfill (Faz 6 / 6d): rewrites legacy
 * (pre-Faz2, schemaVersion ≠ 2) rows to the canonical ScadaPackageDocV2 so the
 * read-path upcast eventually becomes a no-op. Idempotent — a second run
 * reports `migrated = 0`.
 */
@ObjectType()
export class ScadaBackfillResultType {
  /** Rows examined for this tenant. */
  @Field(() => Int)
  scanned!: number;

  /** Legacy rows rewritten to V2 (0 when `dryRun`). */
  @Field(() => Int)
  migrated!: number;

  /** Rows already at V2, left untouched. */
  @Field(() => Int)
  skipped!: number;

  /** Rows that failed V2 validation and were left as-is (never partially written). */
  @Field(() => Int)
  failed!: number;

  /** True when no row was written (preview only). */
  @Field()
  dryRun!: boolean;
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
