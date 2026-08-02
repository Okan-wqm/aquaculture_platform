/**
 * Create Site Input DTO
 */
import { Int, InputType, Field, Float } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsEmail,
  MaxLength,
  MinLength,
  IsEnum,
  IsObject,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { GraphQLJSON } from 'graphql-type-json';
import {
  MonitoringAreaGeometry,
  SiteSettings,
  SiteStatus,
  SiteType,
} from '../entities/site.entity';
import { IsMonitoringArea } from './site-monitoring.validation';

@InputType()
export class SiteLocationInput {
  @Field(() => Float)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Field(() => Float)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
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

  /**
   * Norwegian locality number (Akvakulturregisteret, 5-digit). Required for
   * regulatory reporting; unique per tenant.
   */
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(10000)
  @Max(99999)
  lokalitetsnummer?: number;

  /** Org number override when the site is operated under a different entity. */
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  organisationNumberOverride?: string;

  @Field(() => SiteType, { nullable: true, defaultValue: SiteType.LAND_BASED })
  @IsOptional()
  @IsEnum(SiteType)
  type?: SiteType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => SiteLocationInput, { nullable: true })
  @IsOptional()
  @IsObject()
  location?: SiteLocationInput | null;

  @Field(() => Int, { nullable: true, defaultValue: 2000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(20000)
  monitoringRadiusM?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsMonitoringArea()
  monitoringArea?: MonitoringAreaGeometry | null;

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
  settings?: SiteSettings;

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
