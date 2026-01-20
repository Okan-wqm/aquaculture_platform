/**
 * Update Site Input DTO
 */
import { InputType, Field, Float, PartialType, ID } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsString, MinLength, MaxLength, IsEnum } from 'class-validator';
import { CreateSiteInput } from './create-site.input';
import { SiteStatus } from '../entities/site.entity';

@InputType()
export class UpdateSiteInput extends PartialType(CreateSiteInput) {
  @Field(() => ID)
  @IsUUID()
  id: string;

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

  @Field(() => SiteStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SiteStatus)
  status?: SiteStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
