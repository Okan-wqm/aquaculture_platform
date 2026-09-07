import { TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEmail,
  IsArray,
  IsUUID,
  IsObject,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
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

// ============================================================================
// Template CRUD (CONTRACT-CRITICAL-003)
//
// The three bodies below were service `interface`s, so ValidationPipe never
// saw them: a template body of any size and shape reached the renderer. The
// actor (`updatedBy`) is not a property here — a client never names who acted
// (ADMIN-CRITICAL-008).
// ============================================================================

export class EmailTemplateVariableDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(500)
  description!: string;

  @IsBoolean()
  required!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  defaultValue?: string;
}

export class CreateEmailTemplateDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @MaxLength(100)
  category!: string;

  @IsString()
  @MaxLength(500)
  subject!: string;

  @IsString()
  @MaxLength(100000)
  bodyHtml!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateEmailTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  bodyHtml?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RenderTemplateDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  templateCode!: string;

  @IsObject()
  variables!: Record<string, string>;
}
