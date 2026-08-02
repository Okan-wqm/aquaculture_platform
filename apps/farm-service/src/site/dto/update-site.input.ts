/**
 * Update Site Input DTO
 */
import { InputType, Field, PartialType, ID, Int } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsBoolean,
  IsString,
  MinLength,
  MaxLength,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { CreateSiteInput } from './create-site.input';
import { SiteStatus, SiteType } from '../entities/site.entity';

@InputType()
export class UpdateSiteInput extends PartialType(CreateSiteInput) {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  // Override inherited required fields to make them optional for partial updates
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

  // Create defaults must not be inherited by partial updates: omission means
  // "leave unchanged", never "reset to LAND_BASED / 2000 m".
  @Field(() => SiteType, { nullable: true })
  @IsOptional()
  @IsEnum(SiteType)
  type?: SiteType;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(20000)
  monitoringRadiusM?: number;

  @Field(() => SiteStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SiteStatus)
  status?: SiteStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
