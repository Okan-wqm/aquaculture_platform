import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * class-validator DTOs for the IP-access-rule CRUD surface (APA-355/364).
 *
 * These replace the interface-typed @Body() parameters that erased to metatype
 * Object at runtime, silently bypassing the global ValidationPipe. The exact
 * IP/CIDR format is validated in IpAccessService.isValidIpOrCidr (the single
 * source of truth for that check); here we only guarantee the field shapes so
 * whitelist/forbidNonWhitelisted engage.
 */

const IP_RULE_TYPES = ['whitelist', 'blacklist'] as const;

export class CreateIpAccessRuleDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ipAddress!: string;

  @IsIn(IP_RULE_TYPES)
  ruleType!: 'whitelist' | 'blacklist';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;

  // The admin panel sends `isActive` on create (IpAccessRulesPage). Whitelisted
  // here so forbidNonWhitelisted does not reject the existing payload.
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  createdBy?: string;
}

export class UpdateIpAccessRuleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date | null;
}
