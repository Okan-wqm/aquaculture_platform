import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  IpAccessService,
  CreateIpAccessRuleDto,
  UpdateIpAccessRuleDto,
} from '../services/ip-access.service';

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
  ) {
    const rules = await this.ipAccessService.getAllRules(tenantId);
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : rules.length;
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    const paginatedRules = rules.slice(startIndex, endIndex);

    return {
      data: paginatedRules,
      total: rules.length,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(rules.length / limitNum) || 1,
    };
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
   */
  @Post()
  async createRule(@Body() dto: CreateIpAccessRuleDto) {
    return this.ipAccessService.createRule(dto);
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
    @Body() body: { ip: string; tenantId?: string },
  ) {
    return this.ipAccessService.checkIpAccess(body.ip, body.tenantId);
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  /**
   * Bulk add to whitelist
   */
  @Post('whitelist/bulk')
  async bulkWhitelist(
    @Body() body: { ips: string[]; tenantId?: string; createdBy?: string },
  ) {
    return this.ipAccessService.bulkWhitelist(
      body.ips,
      body.tenantId,
      body.createdBy,
    );
  }

  /**
   * Bulk add to blacklist
   */
  @Post('blacklist/bulk')
  async bulkBlacklist(
    @Body() body: { ips: string[]; tenantId?: string; createdBy?: string },
  ) {
    return this.ipAccessService.bulkBlacklist(
      body.ips,
      body.tenantId,
      body.createdBy,
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
