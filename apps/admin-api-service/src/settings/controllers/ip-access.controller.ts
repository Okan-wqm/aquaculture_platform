import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsIP, IsOptional, IsString, ArrayMaxSize, MaxLength } from 'class-validator';
import { Request } from 'express';

import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { getAuthUserId } from '../../shared/authenticated-request';

import {
  IpAccessService,
  CreateIpAccessRuleDto,
  UpdateIpAccessRuleDto,
} from '../services/ip-access.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  ipAccessIpAccessRulePageContract,
  type IpAccessIpAccessRuleDto,
  ipAccessIpAccessRuleResponseArrayContract,
  type IpAccessIpAccessRuleResponseDto,
  ipAccessIpAccessRuleContract,
  voidResponseContract,
  type VoidResponseDto,
  ipAccessCheckIpAccessResponseContract,
  type IpAccessCheckIpAccessResponseDto,
  ipAccessBulkWhitelistResponseContract,
  type IpAccessBulkWhitelistResponseDto,
  ipAccessBulkBlacklistResponseContract,
  type IpAccessBulkBlacklistResponseDto,
  ipAccessClearRulesResponseContract,
  type IpAccessClearRulesResponseDto,
  ipAccessGetStatisticsResponseContract,
  type IpAccessGetStatisticsResponseDto,
  ipAccessCleanupExpiredRulesResponseContract,
  type IpAccessCleanupExpiredRulesResponseDto,
} from '../contracts/admin-http-response.contract';

class CheckIpAccessDto {
  @IsIP()
  ip!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tenantId?: string;
}

// H23 fix: Proper DTO with array size limit and IP validation for bulk operations
class BulkIpDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsIP(undefined, { each: true })
  ips!: string[];

  @IsOptional()
  @IsString()
  tenantId?: string;
}

@ApiTags('Settings')
@Controller('settings/ip-access')
export class IpAccessController {
  constructor(private readonly ipAccessService: IpAccessService) {}

  // ============================================================================
  // Rule CRUD
  // ============================================================================

  /**
   * Get all IP access rules
   */
  @AdminResponseContract(ipAccessIpAccessRulePageContract)
  @Get()
  async getAllRules(
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<IpAccessIpAccessRuleDto>> {
    const rules = await this.ipAccessService.getAllRules(tenantId);
    const pageNum = page ? parseInt(page, 10) : 1;
    // A page size of 0 is nonsensical (only reachable with zero rules and no
    // explicit limit) — floor at 1 so pagination math never divides by zero.
    const limitNum = limit ? parseInt(limit, 10) : rules.length || 1;
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    const paginatedRules = rules.slice(startIndex, endIndex);

    return createStandardPaginatedResult(paginatedRules, rules.length, pageNum, limitNum);
  }

  /**
   * Get rules by type
   */
  @AdminResponseContract(ipAccessIpAccessRuleResponseArrayContract)
  @Get('type/:ruleType')
  async getRulesByType(
    @Param('ruleType') ruleType: 'whitelist' | 'blacklist',
    @Query('tenantId') tenantId?: string,
  ): Promise<IpAccessIpAccessRuleResponseDto[]> {
    return this.ipAccessService.getRulesByType(ruleType, tenantId);
  }

  /**
   * Get statistics. Static route registration must precede the parameter
   * route below; the generated matcher proof enforces this order.
   */
  @AdminResponseContract(ipAccessGetStatisticsResponseContract)
  @Get('stats')
  async getStatistics(
    @Query('tenantId') tenantId?: string,
  ): Promise<IpAccessGetStatisticsResponseDto> {
    return this.ipAccessService.getStatistics(tenantId);
  }

  /**
   * Get rule by ID
   */
  @AdminResponseContract(ipAccessIpAccessRuleContract)
  @Get(':id')
  async getRuleById(@Param('id') id: string): Promise<IpAccessIpAccessRuleDto> {
    return this.ipAccessService.getRuleById(id);
  }

  /**
   * Create a new rule
   * Fix: C6 -- JWT-based identity
   */
  @AdminResponseContract(ipAccessIpAccessRuleContract)
  @Post()
  async createRule(
    @Body() dto: CreateIpAccessRuleDto,
    @Req() req: Request,
  ): Promise<IpAccessIpAccessRuleDto> {
    const userId = getAuthUserId(req);
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.ipAccessService.createRule({ ...dto, createdBy: userId });
  }

  /**
   * Update a rule
   */
  @AdminResponseContract(ipAccessIpAccessRuleContract)
  @Put(':id')
  async updateRule(
    @Param('id') id: string,
    @Body() dto: UpdateIpAccessRuleDto,
  ): Promise<IpAccessIpAccessRuleDto> {
    return this.ipAccessService.updateRule(id, dto);
  }

  /**
   * Delete a rule
   */
  @AdminResponseContract(voidResponseContract)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRule(@Param('id') id: string): Promise<void> {
    await this.ipAccessService.deleteRule(id);
  }

  // ============================================================================
  // IP Checking
  // ============================================================================

  /**
   * Check if an IP is allowed
   */
  @AdminResponseContract(ipAccessCheckIpAccessResponseContract)
  @Post('check')
  async checkIpAccess(@Body() dto: CheckIpAccessDto): Promise<IpAccessCheckIpAccessResponseDto> {
    return this.ipAccessService.checkIpAccess(dto.ip, dto.tenantId);
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  /**
   * Bulk add to whitelist
   * H23 fix: BulkIpDto with @ArrayMaxSize(500) + @IsIP validation; createdBy from JWT
   */
  @AdminResponseContract(ipAccessBulkWhitelistResponseContract)
  @Post('whitelist/bulk')
  async bulkWhitelist(
    @Body() dto: BulkIpDto,
    @Req() req: Request,
  ): Promise<IpAccessBulkWhitelistResponseDto> {
    const createdBy = getAuthUserId(req);
    if (!createdBy) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.ipAccessService.bulkWhitelist(dto.ips, dto.tenantId, createdBy);
  }

  /**
   * Bulk add to blacklist
   * H23 fix: BulkIpDto with @ArrayMaxSize(500) + @IsIP validation; createdBy from JWT
   */
  @AdminResponseContract(ipAccessBulkBlacklistResponseContract)
  @Post('blacklist/bulk')
  async bulkBlacklist(
    @Body() dto: BulkIpDto,
    @Req() req: Request,
  ): Promise<IpAccessBulkBlacklistResponseDto> {
    const createdBy = getAuthUserId(req);
    if (!createdBy) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.ipAccessService.bulkBlacklist(dto.ips, dto.tenantId, createdBy);
  }

  /**
   * Clear all rules of a type
   */
  @AdminResponseContract(ipAccessClearRulesResponseContract)
  @Delete('type/:ruleType/clear')
  async clearRules(
    @Param('ruleType') ruleType: 'whitelist' | 'blacklist',
    @Query('tenantId') tenantId?: string,
  ): Promise<IpAccessClearRulesResponseDto> {
    const deleted = await this.ipAccessService.clearRules(ruleType, tenantId);
    return { deleted };
  }

  // ============================================================================
  // Statistics & Maintenance
  // ============================================================================

  /**
   * Cleanup expired rules
   */
  @AdminResponseContract(ipAccessCleanupExpiredRulesResponseContract)
  @Post('cleanup')
  async cleanupExpiredRules(): Promise<IpAccessCleanupExpiredRulesResponseDto> {
    const deleted = await this.ipAccessService.cleanupExpiredRules();
    return { deleted };
  }
}
