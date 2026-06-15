import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsEmail,
  MaxLength,
  Matches,
  IsEnum,
  IsNumber,
  Min,
} from 'class-validator';
import GraphQLJSON from 'graphql-type-json';

import { TenantPlan } from '../entities/tenant.entity';

@InputType()
export class CreateTenantInput {
  @Field()
  @IsString()
  @MaxLength(200)
  name!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug?: string;

  @Field()
  @IsEmail()
  contactEmail!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  address?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  taxId?: string;

  @Field(() => TenantPlan, { nullable: true })
  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUsers?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  settings?: Record<string, unknown>;
}

@InputType()
export class UpdateTenantInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  address?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  taxId?: string;

  // HIGH-005 / MT-HIGH-001 tail: the privileged governance/billing fields
  // (status / plan / maxUsers) were REMOVED from this input. They are not
  // tenant-self-service editable — status transitions go through the lifecycle
  // FSM, plan changes through the billing saga, and maxUsers through the
  // provisioning command path. The generic updateTenant mutation is itself
  // command-receipt-owned (the resolver rejects outright), so this input is the
  // self-service profile allow-list, not a governance surface.

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  customDomain?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  settings?: Record<string, unknown>;
}

/**
 * Input for assigning modules to tenant
 */
@InputType()
export class AssignModulesToTenantInput {
  @Field()
  @IsString()
  tenantId!: string;

  @Field(() => [String])
  @IsString({ each: true })
  moduleCodes!: string[];
}

/**
 * Input for assigning module manager
 */
@InputType()
export class AssignModuleManagerInput {
  @Field()
  @IsString()
  moduleId!: string;

  @Field()
  @IsString()
  userId!: string;
}
