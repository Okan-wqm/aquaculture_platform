import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull } from 'typeorm';
import { IpAccessRule } from '../entities/system-setting.entity';

// ============================================================================
// DTOs
// ============================================================================

export interface CreateIpAccessRuleDto {
  tenantId?: string;
  ipAddress: string;
  ruleType: 'whitelist' | 'blacklist';
  description?: string;
  expiresAt?: Date;
  createdBy?: string;
}

export interface UpdateIpAccessRuleDto {
  ipAddress?: string;
  description?: string;
  isActive?: boolean;
  expiresAt?: Date | null;
}

export interface IpAccessRuleResponse {
  id: string;
  tenantId?: string;
  ipAddress: string;
  ruleType: 'whitelist' | 'blacklist';
  description?: string;
  isActive: boolean;
  expiresAt?: Date;
  hitCount: number;
  lastHitAt?: Date;
  createdAt: Date;
  createdBy?: string;
}

export interface IpCheckResult {
  allowed: boolean;
  matchedRule?: IpAccessRuleResponse;
  reason: string;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class IpAccessService {
  private readonly logger = new Logger(IpAccessService.name);

  constructor(
    @InjectRepository(IpAccessRule)
    private readonly ruleRepository: Repository<IpAccessRule>,
  ) {}

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Get all rules (optionally filtered by tenant)
   */
  async getAllRules(tenantId?: string): Promise<IpAccessRuleResponse[]> {
    const query = this.ruleRepository.createQueryBuilder('rule');

    if (tenantId) {
      query.where('rule.tenantId = :tenantId OR rule.tenantId IS NULL', { tenantId });
    }

    query.orderBy('rule.ruleType', 'ASC').addOrderBy('rule.createdAt', 'DESC');

    const rules = await query.getMany();
    return rules.map(r => this.toResponse(r));
  }

  /**
   * Get rules by type
   */
  async getRulesByType(
    ruleType: 'whitelist' | 'blacklist',
    tenantId?: string,
  ): Promise<IpAccessRuleResponse[]> {
    const query = this.ruleRepository
      .createQueryBuilder('rule')
      .where('rule.ruleType = :ruleType', { ruleType });

    if (tenantId) {
      query.andWhere('(rule.tenantId = :tenantId OR rule.tenantId IS NULL)', { tenantId });
    }

    query.orderBy('rule.createdAt', 'DESC');

    const rules = await query.getMany();
    return rules.map(r => this.toResponse(r));
  }

  /**
   * Get rule by ID
   */
  async getRuleById(id: string): Promise<IpAccessRuleResponse> {
    const rule = await this.ruleRepository.findOne({ where: { id } });

    if (!rule) {
      throw new NotFoundException(`IP access rule with ID "${id}" not found`);
    }

    return this.toResponse(rule);
  }

  /**
   * Create a new IP access rule
   */
  async createRule(dto: CreateIpAccessRuleDto): Promise<IpAccessRuleResponse> {
    // Validate IP address or CIDR notation
    if (!this.isValidIpOrCidr(dto.ipAddress)) {
      throw new BadRequestException(`Invalid IP address or CIDR notation: ${dto.ipAddress}`);
    }

    // Check for duplicate
    const existing = await this.ruleRepository.findOne({
      where: {
        ipAddress: dto.ipAddress,
        ruleType: dto.ruleType,
        tenantId: dto.tenantId || IsNull(),
      },
    });

    if (existing) {
      throw new ConflictException(
        `${dto.ruleType} rule for IP "${dto.ipAddress}" already exists`
      );
    }

    const rule = this.ruleRepository.create({
      ...dto,
      isActive: true,
      hitCount: 0,
    });

    const saved = await this.ruleRepository.save(rule);
    this.logger.log(`Created ${dto.ruleType} rule for IP: ${dto.ipAddress}`);
    return this.toResponse(saved);
  }

  /**
   * Update a rule
   */
  async updateRule(id: string, dto: UpdateIpAccessRuleDto): Promise<IpAccessRuleResponse> {
    const rule = await this.ruleRepository.findOne({ where: { id } });

    if (!rule) {
      throw new NotFoundException(`IP access rule with ID "${id}" not found`);
    }

    if (dto.ipAddress !== undefined) {
      if (!this.isValidIpOrCidr(dto.ipAddress)) {
        throw new BadRequestException(`Invalid IP address or CIDR notation: ${dto.ipAddress}`);
      }
      rule.ipAddress = dto.ipAddress;
    }

    if (dto.description !== undefined) rule.description = dto.description;
    if (dto.isActive !== undefined) rule.isActive = dto.isActive;
    if (dto.expiresAt !== undefined) rule.expiresAt = dto.expiresAt || undefined;

    const saved = await this.ruleRepository.save(rule);
    this.logger.log(`Updated IP access rule: ${id}`);
    return this.toResponse(saved);
  }

  /**
   * Delete a rule
   */
  async deleteRule(id: string): Promise<void> {
    const rule = await this.ruleRepository.findOne({ where: { id } });

    if (!rule) {
      throw new NotFoundException(`IP access rule with ID "${id}" not found`);
    }

    await this.ruleRepository.remove(rule);
    this.logger.log(`Deleted IP access rule: ${id} (${rule.ipAddress})`);
  }

  // ============================================================================
  // IP Checking
  // ============================================================================

  /**
   * Check if an IP address is allowed
   */
  async checkIpAccess(ip: string, tenantId?: string): Promise<IpCheckResult> {
    // Get all active rules (tenant-specific and global)
    const query = this.ruleRepository
      .createQueryBuilder('rule')
      .where('rule.isActive = :isActive', { isActive: true });

    if (tenantId) {
      query.andWhere('(rule.tenantId = :tenantId OR rule.tenantId IS NULL)', { tenantId });
    } else {
      query.andWhere('rule.tenantId IS NULL');
    }

    const rules = await query.getMany();

    // Filter out expired rules
    const now = new Date();
    const activeRules = rules.filter(r => !r.expiresAt || new Date(r.expiresAt) > now);

    // Check blacklist first (deny takes precedence)
    const blacklistRules = activeRules.filter(r => r.ruleType === 'blacklist');
    for (const rule of blacklistRules) {
      if (this.ipMatchesRule(ip, rule.ipAddress)) {
        await this.recordHit(rule.id);
        return {
          allowed: false,
          matchedRule: this.toResponse(rule),
          reason: `IP ${ip} is blacklisted${rule.description ? `: ${rule.description}` : ''}`,
        };
      }
    }

    // Check whitelist
    const whitelistRules = activeRules.filter(r => r.ruleType === 'whitelist');

    // If there are whitelist rules and the IP is not in any of them, deny
    if (whitelistRules.length > 0) {
      for (const rule of whitelistRules) {
        if (this.ipMatchesRule(ip, rule.ipAddress)) {
          await this.recordHit(rule.id);
          return {
            allowed: true,
            matchedRule: this.toResponse(rule),
            reason: `IP ${ip} is whitelisted`,
          };
        }
      }

      // IP not in whitelist
      return {
        allowed: false,
        reason: `IP ${ip} is not in the whitelist`,
      };
    }

    // No restrictions apply
    return {
      allowed: true,
      reason: 'No IP restrictions configured',
    };
  }

  /**
   * Record a hit on a rule
   */
  private async recordHit(ruleId: string): Promise<void> {
    await this.ruleRepository.increment({ id: ruleId }, 'hitCount', 1);
    await this.ruleRepository.update(ruleId, { lastHitAt: new Date() });
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  /**
   * Add multiple IPs to whitelist
   */
  async bulkWhitelist(
    ips: string[],
    tenantId?: string,
    createdBy?: string,
  ): Promise<{ added: number; skipped: number; errors: string[] }> {
    return this.bulkAddRules(ips, 'whitelist', tenantId, createdBy);
  }

  /**
   * Add multiple IPs to blacklist
   */
  async bulkBlacklist(
    ips: string[],
    tenantId?: string,
    createdBy?: string,
  ): Promise<{ added: number; skipped: number; errors: string[] }> {
    return this.bulkAddRules(ips, 'blacklist', tenantId, createdBy);
  }

  private async bulkAddRules(
    ips: string[],
    ruleType: 'whitelist' | 'blacklist',
    tenantId?: string,
    createdBy?: string,
  ): Promise<{ added: number; skipped: number; errors: string[] }> {
    let added = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const ip of ips) {
      try {
        await this.createRule({
          ipAddress: ip.trim(),
          ruleType,
          tenantId,
          createdBy,
        });
        added++;
      } catch (error) {
        if (error instanceof ConflictException) {
          skipped++;
        } else {
          errors.push(`${ip}: ${(error as Error).message}`);
        }
      }
    }

    return { added, skipped, errors };
  }

  /**
   * Clear all rules of a type for a tenant
   */
  async clearRules(
    ruleType: 'whitelist' | 'blacklist',
    tenantId?: string,
  ): Promise<number> {
    const query = this.ruleRepository
      .createQueryBuilder()
      .delete()
      .where('ruleType = :ruleType', { ruleType });

    if (tenantId) {
      query.andWhere('tenantId = :tenantId', { tenantId });
    } else {
      query.andWhere('tenantId IS NULL');
    }

    const result = await query.execute();
    const deleted = result.affected || 0;

    this.logger.log(`Cleared ${deleted} ${ruleType} rules${tenantId ? ` for tenant ${tenantId}` : ''}`);
    return deleted;
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Remove expired rules
   */
  async cleanupExpiredRules(): Promise<number> {
    const result = await this.ruleRepository.delete({
      expiresAt: LessThan(new Date()),
    });

    const deleted = result.affected || 0;
    if (deleted > 0) {
      this.logger.log(`Cleaned up ${deleted} expired IP access rules`);
    }

    return deleted;
  }

  /**
   * Get statistics
   */
  async getStatistics(tenantId?: string): Promise<{
    totalRules: number;
    whitelistCount: number;
    blacklistCount: number;
    activeRules: number;
    expiredRules: number;
    totalHits: number;
    mostHitRules: IpAccessRuleResponse[];
  }> {
    const query = this.ruleRepository.createQueryBuilder('rule');

    if (tenantId) {
      query.where('rule.tenantId = :tenantId OR rule.tenantId IS NULL', { tenantId });
    }

    const rules = await query.getMany();
    const now = new Date();

    const whitelistRules = rules.filter(r => r.ruleType === 'whitelist');
    const blacklistRules = rules.filter(r => r.ruleType === 'blacklist');
    const expiredRules = rules.filter(r => r.expiresAt && new Date(r.expiresAt) < now);
    const activeRules = rules.filter(r => r.isActive && (!r.expiresAt || new Date(r.expiresAt) > now));

    const totalHits = rules.reduce((sum, r) => sum + r.hitCount, 0);

    const mostHitRules = rules
      .filter(r => r.hitCount > 0)
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 10)
      .map(r => this.toResponse(r));

    return {
      totalRules: rules.length,
      whitelistCount: whitelistRules.length,
      blacklistCount: blacklistRules.length,
      activeRules: activeRules.length,
      expiredRules: expiredRules.length,
      totalHits,
      mostHitRules,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Validate IP address or CIDR notation
   */
  private isValidIpOrCidr(ip: string): boolean {
    // IPv4 with optional CIDR
    const ipv4Regex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\/([0-9]|[1-2][0-9]|3[0-2]))?$/;

    // IPv6 (simplified check)
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(\/([0-9]|[1-9][0-9]|1[0-2][0-8]))?$/;

    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  }

  /**
   * Check if IP matches a rule (supports CIDR notation)
   */
  private ipMatchesRule(ip: string, ruleIp: string): boolean {
    try {
      // Check if rule contains CIDR notation
      if (ruleIp.includes('/')) {
        return this.isIpInCidr(ip, ruleIp);
      }
      // Exact match
      return ip === ruleIp;
    } catch {
      return false;
    }
  }

  /**
   * Check if IP is in CIDR range (simple implementation)
   */
  private isIpInCidr(ip: string, cidr: string): boolean {
    const parts = cidr.split('/');
    const range = parts[0];
    const bits = parts[1];

    if (!range || !bits) {
      return false;
    }

    const mask = parseInt(bits, 10);

    if (isNaN(mask) || mask < 0 || mask > 32) {
      return false;
    }

    const ipParts = ip.split('.').map(Number);
    const rangeParts = range.split('.').map(Number);

    if (ipParts.length !== 4 || rangeParts.length !== 4) {
      return false;
    }

    // Convert to 32-bit integers
    const ipNum = ipParts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
    const rangeNum = rangeParts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
    const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;

    return (ipNum & maskNum) === (rangeNum & maskNum);
  }

  /**
   * Convert entity to response DTO
   */
  private toResponse(rule: IpAccessRule): IpAccessRuleResponse {
    return {
      id: rule.id,
      tenantId: rule.tenantId,
      ipAddress: rule.ipAddress,
      ruleType: rule.ruleType,
      description: rule.description,
      isActive: rule.isActive,
      expiresAt: rule.expiresAt,
      hitCount: rule.hitCount,
      lastHitAt: rule.lastHitAt,
      createdAt: rule.createdAt,
      createdBy: rule.createdBy,
    };
  }
}
