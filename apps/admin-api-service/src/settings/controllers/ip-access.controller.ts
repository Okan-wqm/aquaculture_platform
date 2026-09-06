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
import { getAuthUserId } from '../../shared/authenticated-request';

import {
  createStandardPaginatedResult,
  type PaginationResultV1,
} from '@platform/pagination-contracts';

import {
  IpAccessService,
  CreateIpAccessRuleDto,
  UpdateIpAccessRuleDto,
  type IpAccessRuleResponse,
} from '../services/ip-access.service';

/**
 * Query-string page coordinates arrive as strings and may be absent, empty or
 * unparseable. Anything that is not a positive safe integer falls back to the
 * caller-supplied default rather than reaching the pagination authority as NaN.
 */
function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

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
  constructor(
    private readonly ipAccessService: IpAccessService,
  ) {}

  // ============================================================================
  // Rule CRUD
  // ============================================================================

  /**
   * Get all IP access rules
   */
  @Get()
  async getAllRules(
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PaginationResultV1<IpAccessRuleResponse>> {
    const rules = await this.ipAccessService.getAllRules(tenantId);
    // A page size of zero is not a page, and neither is a page size of NaN.
    // The old `Math.ceil(rules.length / limitNum) || 1` hid both: with no rules
    // and no explicit limit it divided by zero, and an unparseable `?limit=`
    // produced NaN that the `|| 1` swallowed. The coordinates are coerced to
    // something the authority can honour before it ever sees them.
    const pageNum = positiveIntOr(page, 1);
    const limitNum = positiveIntOr(limit, Math.max(1, rules.length));
    const startIndex = (pageNum - 1) * limitNum;
    const paginatedRules = rules.slice(startIndex, startIndex + limitNum);

    return createStandardPaginatedResult<IpAccessRuleResponse>(
      paginatedRules,
      rules.length,
      pageNum,
      limitNum,
    );
  }

  /**
   * Get rules by type
   */
  @Get('type/:ruleType')
  async getRulesByType(
    @Param('ruleType') ruleType: 'whitelist' | 'blacklist',
    @Query('tenantId') tenantId?: string,
  ) {
    return this.ipAccessService.getRulesByType(ruleType, tenantId);
  }

  /**
   * Get rule by ID
   */
  @Get(':id')
  async getRuleById(@Param('id') id: string) {
    return this.ipAccessService.getRuleById(id);
  }

  /**
   * Create a new rule
   * Fix: C6 -- JWT-based identity
   */
  @Post()
  async createRule(
    @Body() dto: CreateIpAccessRuleDto,
    @Req() req: Request,
  ) {
    const userId = getAuthUserId(req);
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.ipAccessService.createRule({ ...dto, createdBy: userId });
  }

  /**
   * Update a rule
   */
  @Put(':id')
  async updateRule(
    @Param('id') id: string,
    @Body() dto: UpdateIpAccessRuleDto,
  ) {
    return this.ipAccessService.updateRule(id, dto);
  }

  /**
   * Delete a rule
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRule(@Param('id') id: string) {
    await this.ipAccessService.deleteRule(id);
  }

  // ============================================================================
  // IP Checking
  // ============================================================================

  /**
   * Check if an IP is allowed
   */
  @Post('check')
  async checkIpAccess(
    @Body() dto: CheckIpAccessDto,
  ) {
    return this.ipAccessService.checkIpAccess(dto.ip, dto.tenantId);
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  /**
   * Bulk add to whitelist
   * H23 fix: BulkIpDto with @ArrayMaxSize(500) + @IsIP validation; createdBy from JWT
   */
  @Post('whitelist/bulk')
  async bulkWhitelist(
    @Body() dto: BulkIpDto,
    @Req() req: Request,
  ) {
    const createdBy = getAuthUserId(req);
    if (!createdBy) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.ipAccessService.bulkWhitelist(
      dto.ips,
      dto.tenantId,
      createdBy,
    );
  }

  /**
   * Bulk add to blacklist
   * H23 fix: BulkIpDto with @ArrayMaxSize(500) + @IsIP validation; createdBy from JWT
   */
  @Post('blacklist/bulk')
  async bulkBlacklist(
    @Body() dto: BulkIpDto,
    @Req() req: Request,
  ) {
    const createdBy = getAuthUserId(req);
    if (!createdBy) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.ipAccessService.bulkBlacklist(
      dto.ips,
      dto.tenantId,
      createdBy,
    );
  }

  /**
   * Clear all rules of a type
   */
  @Delete('type/:ruleType/clear')
  async clearRules(
    @Param('ruleType') ruleType: 'whitelist' | 'blacklist',
    @Query('tenantId') tenantId?: string,
  ) {
    const deleted = await this.ipAccessService.clearRules(ruleType, tenantId);
    return { deleted };
  }

  // ============================================================================
  // Statistics & Maintenance
  // ============================================================================

  /**
   * Get statistics
   */
  @Get('stats')
  async getStatistics(@Query('tenantId') tenantId?: string) {
    return this.ipAccessService.getStatistics(tenantId);
  }

  /**
   * Cleanup expired rules
   */
  @Post('cleanup')
  async cleanupExpiredRules() {
    const deleted = await this.ipAccessService.cleanupExpiredRules();
    return { deleted };
  }
}
