/**
 * Create Site Input DTO
 */
import { InputType, Field, Float } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, IsEmail, MaxLength, MinLength, IsEnum, IsObject } from 'class-validator';
import { GraphQLJSON } from 'graphql-type-json';
import { SiteStatus } from '../entities/site.entity';

@InputType()
export class SiteLocationInput {
  @Field(() => Float)
  @IsNumber()
  latitude!: number;

  @Field(() => Float)
  @IsNumber()
  longitude!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  altitude?: number;
}

@InputType()
export class SiteAddressInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  street?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

@InputType()
export class CreateSiteInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => SiteLocationInput, { nullable: true })
  @IsOptional()
  @IsObject()
  location?: SiteLocationInput;

  @Field(() => SiteAddressInput, { nullable: true })
  @IsOptional()
  @IsObject()
  address?: SiteAddressInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @Field(() => SiteStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SiteStatus)
  status?: SiteStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  totalArea?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  siteManager?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  contactEmail?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;
}
