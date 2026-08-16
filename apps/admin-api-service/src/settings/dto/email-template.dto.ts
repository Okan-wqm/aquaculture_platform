import { IsString, IsOptional, IsArray, IsUUID, MaxLength, ArrayMaxSize } from 'class-validator';

import { EmailTemplateVariable } from '../entities/settings-resource.entity';

export class CreateTenantOverrideDto {
  @IsUUID('4')
  tenantId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  bodyHtml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  variables?: EmailTemplateVariable[];
}

export class ValidateTemplateDto {
  @IsString()
  @MaxLength(100000)
  bodyHtml!: string;

  @IsArray()
  @ArrayMaxSize(50)
  variables!: EmailTemplateVariable[];
}
