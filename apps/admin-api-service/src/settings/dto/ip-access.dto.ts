import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsIP,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateIpAccessRuleDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsIP()
  ipAddress!: string;

  @IsIn(['whitelist', 'blacklist'])
  ruleType!: 'whitelist' | 'blacklist';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}

export class UpdateIpAccessRuleDto {
  @IsOptional()
  @IsIP()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date | null;
}
