import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateModuleDto {
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
  @MaxLength(255)
  defaultRoute!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isCore?: boolean;
}

export class UpdateModuleDto {
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
  @MaxLength(255)
  defaultRoute?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ModuleQuantitiesDto {
  @IsOptional() @IsInt() @Min(0) users?: number;
  @IsOptional() @IsInt() @Min(0) farms?: number;
  @IsOptional() @IsInt() @Min(0) ponds?: number;
  @IsOptional() @IsInt() @Min(0) sensors?: number;
  @IsOptional() @IsInt() @Min(0) devices?: number;
  @IsOptional() @IsInt() @Min(0) storageGb?: number;
  @IsOptional() @IsInt() @Min(0) apiCalls?: number;
  @IsOptional() @IsInt() @Min(0) alerts?: number;
  @IsOptional() @IsInt() @Min(0) reports?: number;
  @IsOptional() @IsInt() @Min(0) integrations?: number;
}

export class AssignModuleDto {
  @IsUUID('4')
  tenantId!: string;

  @IsUUID('4')
  moduleId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModuleQuantitiesDto)
  quantities?: ModuleQuantitiesDto;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}
