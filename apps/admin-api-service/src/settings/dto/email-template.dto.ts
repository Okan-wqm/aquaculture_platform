import { TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsArray,
  IsUUID,
  IsObject,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

import { EmailTemplateVariable } from '../entities/system-setting.entity';

export class CreateTenantOverrideDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

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

export class SendTestEmailDto {
  @IsEmail()
  recipientEmail!: string;

  @IsObject()
  variables!: Record<string, string>;
}
