/**
 * GraphQL DTOs for Regulatory Settings
 *
 * Input and Output types for company information and Maskinporten configuration.
 * SECURITY: Private key and client ID are never returned in output.
 */
import { InputType, ObjectType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsInt,
  IsArray,
  ValidateNested,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';

// =============================================================================
// INPUT TYPES
// =============================================================================

@InputType()
export class CompanyAddressInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  street?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  city?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  country?: string;
}

@InputType()
export class SiteLocalityMappingInput {
  @Field()
  @IsUUID()
  siteId: string;

  @Field(() => Int)
  @IsInt()
  lokalitetsnummer: number;
}

@InputType()
export class UpdateRegulatorySettingsInput {
  // Company Information
  @Field({ nullable: true, description: 'Company legal name' })
  @IsOptional()
  @IsString()
  companyName?: string;

  @Field({ nullable: true, description: 'Norwegian organization number (orgnr)' })
  @IsOptional()
  @IsString()
  organisationNumber?: string;

  @Field(() => CompanyAddressInput, { nullable: true, description: 'Company address' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyAddressInput)
  companyAddress?: CompanyAddressInput;

  // Maskinporten Credentials (encrypted on save, never returned)
  @Field({ nullable: true, description: 'Maskinporten OAuth2 Client ID' })
  @IsOptional()
  @IsString()
  maskinportenClientId?: string;

  @Field({ nullable: true, description: 'Maskinporten private key in PEM format' })
  @IsOptional()
  @IsString()
  maskinportenPrivateKey?: string;

  @Field({ nullable: true, description: 'Maskinporten Key ID (kid) for JWT header' })
  @IsOptional()
  @IsString()
  maskinportenKeyId?: string;

  @Field({ nullable: true, description: 'Environment: TEST or PRODUCTION' })
  @IsOptional()
  @IsString()
  maskinportenEnvironment?: string;

  // Default Contact
  @Field({ nullable: true, description: 'Default contact name for regulatory reports' })
  @IsOptional()
  @IsString()
  defaultContactName?: string;

  @Field({ nullable: true, description: 'Default contact email for regulatory reports' })
  @IsOptional()
  @IsString()
  defaultContactEmail?: string;

  @Field({ nullable: true, description: 'Default contact phone for regulatory reports' })
  @IsOptional()
  @IsString()
  defaultContactPhone?: string;

  // Site Mappings
  @Field(() => [SiteLocalityMappingInput], {
    nullable: true,
    description: 'Site to Lokalitetsnummer mappings for Mattilsynet reports',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SiteLocalityMappingInput)
  siteLocalityMappings?: SiteLocalityMappingInput[];

  // Slaughter
  @Field({ nullable: true, description: 'Slaughter facility approval number' })
  @IsOptional()
  @IsString()
  slaughterApprovalNumber?: string;
}

// =============================================================================
// OUTPUT TYPES
// =============================================================================

@ObjectType()
export class CompanyAddressOutput {
  @Field({ nullable: true })
  street?: string;

  @Field({ nullable: true })
  postalCode?: string;

  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  country?: string;
}

@ObjectType()
export class SiteLocalityMappingOutput {
  @Field()
  siteId: string;

  @Field(() => Int)
  lokalitetsnummer: number;

  @Field({ nullable: true, description: 'Site name for display' })
  siteName?: string;
}

@ObjectType({ description: 'Regulatory settings for a tenant' })
export class RegulatorySettingsOutput {
  @Field(() => ID, { nullable: true })
  id?: string;

  // Company Information
  @Field({ nullable: true })
  companyName?: string;

  @Field({ nullable: true })
  organisationNumber?: string;

  @Field(() => CompanyAddressOutput, { nullable: true })
  companyAddress?: CompanyAddressOutput;

  // Maskinporten Status (credentials are NEVER exposed)
  @Field({ description: 'Whether Maskinporten credentials are configured' })
  maskinportenConfigured: boolean;

  @Field({ nullable: true, description: 'Maskinporten environment (TEST or PRODUCTION)' })
  maskinportenEnvironment?: string;

  @Field({ nullable: true, description: 'Masked client ID for display (first4****last4)' })
  maskinportenClientIdMasked?: string;

  @Field({ nullable: true, description: 'Maskinporten Key ID (kid)' })
  maskinportenKeyId?: string;

  // Default Contact
  @Field({ nullable: true })
  defaultContactName?: string;

  @Field({ nullable: true })
  defaultContactEmail?: string;

  @Field({ nullable: true })
  defaultContactPhone?: string;

  // Site Mappings
  @Field(() => [SiteLocalityMappingOutput], { nullable: true })
  siteLocalityMappings?: SiteLocalityMappingOutput[];

  // Slaughter
  @Field({ nullable: true })
  slaughterApprovalNumber?: string;

  // Metadata
  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

// =============================================================================
// CONNECTION TEST RESULT
// =============================================================================

@ObjectType({ description: 'Result of Maskinporten connection test' })
export class MaskinportenConnectionTestResult {
  @Field()
  success: boolean;

  @Field({ nullable: true, description: 'Success message' })
  message?: string;

  @Field({ nullable: true, description: 'Error message if test failed' })
  error?: string;

  @Field(() => [String], { nullable: true, description: 'Granted scopes' })
  scopes?: string[];
}

// =============================================================================
// ADDITIONAL OUTPUT TYPES
// =============================================================================

@ObjectType({ description: 'Default contact information for reports' })
export class DefaultContactOutput {
  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  phone?: string;
}

@ObjectType({ description: 'Summary of regulatory configuration status' })
export class RegulatoryConfigurationStatus {
  @Field()
  hasCompanyInfo: boolean;

  @Field()
  hasMaskinportenCredentials: boolean;

  @Field()
  hasDefaultContact: boolean;

  @Field(() => Int)
  siteMappingsCount: number;

  @Field()
  hasSlaughterApproval: boolean;

  @Field()
  isFullyConfigured: boolean;
}
