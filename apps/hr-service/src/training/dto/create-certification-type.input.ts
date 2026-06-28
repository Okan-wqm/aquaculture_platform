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
 * Input for CreateCertificationType mutation.
 *
 * Field set mirrors the writable surface of the CertificationType entity that the
 * FE CertificationTypeFull fragment reads back (web/modules/hr-module/src/graphql/fragments.ts).
 * Server-managed columns (id, tenantId, audit columns, version, soft-delete,
 * displayOrder default) are NOT writable here.
 */
@InputType()
export class CreateCertificationTypeInput {
  @Field()
  @IsString()
  // Codes are the per-tenant unique business key (@Index(['tenantId','code'], unique)).
  // Constrain to an uppercase token so two visually distinct codes cannot collide.
  @Matches(/^[A-Z0-9_-]{1,30}$/, {
    message: 'code must be 1-30 uppercase letters, digits, hyphens or underscores',
  })
  code!: string;

  @Field()
  @IsString()
  @Length(1, 150)
  name!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  description?: string;

  @Field(() => CertificationCategory, { defaultValue: CertificationCategory.OTHER })
  @IsEnum(CertificationCategory)
  @IsOptional()
  category?: CertificationCategory;

  @Field(() => CertificationRequirement, { defaultValue: CertificationRequirement.OPTIONAL })
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

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  requiresRenewal?: boolean;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  requiresPhysicalAssessment?: boolean;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  isOffshoreRequired?: boolean;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  isDivingRequired?: boolean;

  @Field({ defaultValue: false })
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

  @Field(() => Int, { defaultValue: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  displayOrder?: number;

  @Field({ defaultValue: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
