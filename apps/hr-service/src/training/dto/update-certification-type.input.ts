import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';

import {
  CertificationCategory,
  CertificationRequirement,
} from '../entities/certification-type.entity';

/**
 * Input for UpdateCertificationType mutation.
 *
 * `id` identifies the target row; every other field is optional so the FE can send
 * a partial patch — only provided keys are applied (undefined keys untouched).
 * `code` is intentionally NOT updatable: it is the stable per-tenant business key.
 */
@InputType()
export class UpdateCertificationTypeInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsString()
  @Length(1, 150)
  @IsOptional()
  name?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  description?: string;

  @Field(() => CertificationCategory, { nullable: true })
  @IsEnum(CertificationCategory)
  @IsOptional()
  category?: CertificationCategory;

  @Field(() => CertificationRequirement, { nullable: true })
  @IsEnum(CertificationRequirement)
  @IsOptional()
  requirement?: CertificationRequirement;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @Length(1, 200)
  issuingAuthority?: string;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  validityMonths?: number;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  renewalReminderDays?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  requiresRenewal?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  requiresPhysicalAssessment?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isOffshoreRequired?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isDivingRequired?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isSTCW?: boolean;

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  applicableWorkAreas?: string[];

  @Field(() => [String], { nullable: true })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  prerequisiteCertifications?: string[];

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'colorCode must be a #RRGGBB hex value' })
  colorCode?: string;

  @Field(() => Int, { nullable: true })
  @IsInt()
  @Min(0)
  @IsOptional()
  displayOrder?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
