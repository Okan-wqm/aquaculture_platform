import {
  IsBoolean,
  IsString,
  IsOptional,
  IsEmail,
  IsArray,
  IsUUID,
  IsObject,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { EmailTemplateVariable } from '../entities/system-setting.entity';

export class EmailTemplateVariableDto implements EmailTemplateVariable {
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
  @MaxLength(2000)
  defaultValue?: string;
}

export class CreateEmailTemplateDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MaxLength(100) category!: string;
  @IsString() @MaxLength(1000) subject!: string;
  @IsString() @MaxLength(100000) bodyHtml!: string;
  @IsOptional() @IsString() @MaxLength(50000) bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];

  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsUUID('4') tenantId?: string;
}

export class UpdateEmailTemplateDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(1000) subject?: string;
  @IsOptional() @IsString() @MaxLength(100000) bodyHtml?: string;
  @IsOptional() @IsString() @MaxLength(50000) bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];

  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class RenderTemplateDto {
  @IsString()
  @MaxLength(100)
  templateCode!: string;

  @IsObject()
  variables!: Record<string, string>;

  @IsOptional()
  @IsUUID('4')
  tenantId?: string;
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
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables?: EmailTemplateVariableDto[];
}

export class ValidateTemplateDto {
  @IsString()
  @MaxLength(100000)
  bodyHtml!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmailTemplateVariableDto)
  variables!: EmailTemplateVariableDto[];
}

export class SendTestEmailDto {
  @IsEmail()
  recipientEmail!: string;

  @IsObject()
  variables!: Record<string, string>;
}
