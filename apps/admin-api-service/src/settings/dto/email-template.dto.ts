import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEmail,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsUUID,
  IsObject,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';

import { EmailTemplateVariable } from '../entities/system-setting.entity';

/**
 * Allowed email-template categories. SSoT mirrors
 * EmailTemplateService.getTemplateCategories().
 */
export const EMAIL_TEMPLATE_CATEGORIES = [
  'auth',
  'billing',
  'notification',
  'marketing',
  'system',
] as const;

/**
 * Validated shape of one entry in a template's `variables` jsonb array, so the
 * global ValidationPipe checks element shapes instead of accepting the array
 * opaquely (APA-348). Structurally satisfies EmailTemplateVariable.
 */
export class EmailTemplateVariableDto implements EmailTemplateVariable {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsString()
  @MaxLength(1000)
  description!: string;

  @IsBoolean()
  required!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  defaultValue?: string;
}

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

export class SendTestEmailDto {
  @IsEmail()
  recipientEmail!: string;

  @IsObject()
  variables!: Record<string, string>;
}

/**
 * Body for `POST /settings/email-templates`. A class (not a TS interface) so the
 * global ValidationPipe engages on template creation (APA-348/364).
 */
export class CreateEmailTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsIn(EMAIL_TEMPLATE_CATEGORIES)
  category!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;

  @IsString()
  @MaxLength(100000)
  bodyHtml!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsUUID('4')
  tenantId?: string;
}

/**
 * Body for `PUT /settings/email-templates/:id`. All fields optional (partial
 * update). A class so the global ValidationPipe engages (APA-348/364).
 */
export class UpdateEmailTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsIn(EMAIL_TEMPLATE_CATEGORIES)
  category?: string;

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
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  updatedBy?: string;
}

/**
 * Body for `POST /settings/email-templates/render`. A class so the global
 * ValidationPipe engages (APA-348/364).
 */
export class RenderTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  templateCode!: string;

  @IsObject()
  variables!: Record<string, string>;

  @IsOptional()
  @IsUUID('4')
  tenantId?: string;
}
