import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull } from 'typeorm';
import {
  EscalationPolicy,
  EscalationLevel,
  OnCallSchedule,
  SuppressionWindow,
  EscalationActionType,
  NotificationChannel,
} from '../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../database/entities/alert-rule.entity';

/**
 * Policy match result
 */
export interface PolicyMatchResult {
  policy: EscalationPolicy;
  matchScore: number;
  matchReasons: string[];
}

/**
 * Policy validation result
 */
export interface PolicyValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Create policy DTO
 */
export interface CreatePolicyDto {
  tenantId: string;
  name: string;
  description?: string;
  severity: AlertSeverity[];
  levels: EscalationLevel[];
  onCallSchedule?: OnCallSchedule[];
  suppressionWindows?: SuppressionWindow[];
  repeatIntervalMinutes?: number;
  maxRepeats?: number;
  isDefault?: boolean;
  priority?: number;
  conditions?: Record<string, unknown>;
  timezone?: string;
  ruleIds?: string[];
  farmIds?: string[];
  createdBy?: string;
}

/**
 * Update policy DTO
 */
export interface UpdatePolicyDto extends Partial<CreatePolicyDto> {
  isActive?: boolean;
}

@Injectable()
export class EscalationPolicyService {
  private readonly logger = new Logger(EscalationPolicyService.name);
  private policyCache: Map<string, EscalationPolicy[]> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes
  private lastCacheUpdate: Map<string, number> = new Map();

  constructor(
    @InjectRepository(EscalationPolicy)
    private readonly policyRepository: Repository<EscalationPolicy>,
  ) {}

  /**
   * Create new escalation policy
   */
  async createPolicy(dto: CreatePolicyDto): Promise<EscalationPolicy> {
    this.logger.log(`Creating escalation policy: ${dto.name}`);

    // Validate policy
    const validation = this.validatePolicy(dto);
    if (!validation.isValid) {
      throw new ConflictException(`Invalid policy: ${validation.errors.join(', ')}`);
    }

    // If setting as default, unset other defaults
    if (dto.isDefault) {
      await this.unsetDefaultPolicies(dto.tenantId);
    }

    const policy = this.policyRepository.create({
      ...dto,
      isActive: true,
    });

    const saved = await this.policyRepository.save(policy);
    this.invalidateCache(dto.tenantId);

    return saved;
  }

  /**
   * Update escalation policy
   */
  async updatePolicy(id: string, tenantId: string, dto: UpdatePolicyDto): Promise<EscalationPolicy> {
    this.logger.log(`Updating escalation policy: ${id}`);

    const policy = await this.policyRepository.findOne({
      where: { id, tenantId },
    });

    if (!policy) {
      throw new NotFoundException(`Policy ${id} not found`);
    }

    // Validate if levels are being updated
    if (dto.levels) {
      const validation = this.validatePolicy({ ...policy, ...dto } as CreatePolicyDto);
      if (!validation.isValid) {
        throw new ConflictException(`Invalid policy: ${validation.errors.join(', ')}`);
      }
    }

    // If setting as default, unset other defaults
    if (dto.isDefault && !policy.isDefault) {
      await this.unsetDefaultPolicies(tenantId);
    }

    Object.assign(policy, dto);
    const saved = await this.policyRepository.save(policy);
    this.invalidateCache(tenantId);

    return saved;
  }

  /**
   * Delete escalation policy
   */
  async deletePolicy(id: string, tenantId: string): Promise<void> {
    this.logger.log(`Deleting escalation policy: ${id}`);

    const policy = await this.policyRepository.findOne({
      where: { id, tenantId },
    });

    if (!policy) {
      throw new NotFoundException(`Policy ${id} not found`);
    }

    if (policy.isDefault) {
      throw new ConflictException('Cannot delete default policy');
    }

    await this.policyRepository.remove(policy);
    this.invalidateCache(tenantId);
  }

  /**
   * Get policy by ID
   */
  async getPolicy(id: string, tenantId: string): Promise<EscalationPolicy> {
    const policy = await this.policyRepository.findOne({
      where: { id, tenantId },
    });

    if (!policy) {
      throw new NotFoundException(`Policy ${id} not found`);
    }

    return policy;
  }

  /**
   * Get all policies for tenant
   */
  async getPolicies(tenantId: string, activeOnly = true): Promise<EscalationPolicy[]> {
    // Check cache
    const cached = this.getCachedPolicies(tenantId);
    if (cached) {
      return activeOnly ? cached.filter(p => p.isActive) : cached;
    }

    const policies = await this.policyRepository.find({
      where: { tenantId },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });

    this.setCachedPolicies(tenantId, policies);

    return activeOnly ? policies.filter(p => p.isActive) : policies;
  }

  /**
   * Get default policy for tenant
   */
  async getDefaultPolicy(tenantId: string): Promise<EscalationPolicy | null> {
    const policies = await this.getPolicies(tenantId);
    return policies.find(p => p.isDefault) || null;
  }

  /**
   * Find matching policy for alert
   */
  async findMatchingPolicy(
    tenantId: string,
    severity: AlertSeverity,
    ruleId?: string,
    farmId?: string,
  ): Promise<EscalationPolicy | null> {
    const policies = await this.getPolicies(tenantId);

    const matches: PolicyMatchResult[] = [];

    for (const policy of policies) {
      if (!policy.appliesTo(severity, ruleId, farmId)) {
        continue;
      }

      const matchScore = this.calculateMatchScore(policy, severity, ruleId, farmId);
      matches.push({
        policy,
        matchScore,
        matchReasons: this.getMatchReasons(policy, severity, ruleId, farmId),
      });
    }

    if (matches.length === 0) {
      return this.getDefaultPolicy(tenantId);
    }

    // Sort by score (descending) then priority (descending)
    matches.sort((a, b) => {
      if (b.matchScore !== a.matchScore) {
        return b.matchScore - a.matchScore;
      }
      return b.policy.priority - a.policy.priority;
    });

    return matches[0]!.policy;
  }

  /**
   * Calculate policy match score
   */
  calculateMatchScore(
    policy: EscalationPolicy,
    severity: AlertSeverity,
    ruleId?: string,
    farmId?: string,
  ): number {
    let score = 0;

    // Severity match
    if (policy.severity.includes(severity)) {
      score += 10;
    }

    // Specific rule match
    if (policy.ruleIds?.length && ruleId && policy.ruleIds.includes(ruleId)) {
      score += 30;
    }

    // Specific farm match
    if (policy.farmIds?.length && farmId && policy.farmIds.includes(farmId)) {
      score += 20;
    }

    // Priority bonus
    score += policy.priority;

    return score;
  }

  /**
   * Get reasons for policy match
   */
  getMatchReasons(
    policy: EscalationPolicy,
    severity: AlertSeverity,
    ruleId?: string,
    farmId?: string,
  ): string[] {
    const reasons: string[] = [];

    if (policy.severity.includes(severity)) {
      reasons.push(`Severity ${severity} matches`);
    }

    if (policy.ruleIds?.includes(ruleId!)) {
      reasons.push(`Rule ${ruleId} specifically configured`);
    }

    if (policy.farmIds?.includes(farmId!)) {
      reasons.push(`Farm ${farmId} specifically configured`);
    }

    if (policy.isDefault) {
      reasons.push('Default policy');
    }

    return reasons;
  }

  /**
   * Validate policy configuration
   */
  validatePolicy(dto: CreatePolicyDto | UpdatePolicyDto): PolicyValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Name validation
    if ('name' in dto && (!dto.name || dto.name.trim().length === 0)) {
      errors.push('Policy name is required');
    }

    // Severity validation
    if ('severity' in dto) {
      if (!dto.severity || dto.severity.length === 0) {
        errors.push('At least one severity level is required');
      }
    }

    // Levels validation
    if ('levels' in dto && dto.levels) {
      if (dto.levels.length === 0) {
        errors.push('At least one escalation level is required');
      } else {
        // Check level numbers are sequential starting from 1
        const levelNumbers = dto.levels.map(l => l.level).sort((a, b) => a - b);
        for (let i = 0; i < levelNumbers.length; i++) {
          if (levelNumbers[i] !== i + 1) {
            errors.push('Escalation levels must be sequential starting from 1');
            break;
          }
        }

        // Check each level configuration
        for (const level of dto.levels) {
          if (!level.name || level.name.trim().length === 0) {
            errors.push(`Level ${level.level}: Name is required`);
          }

          if (level.timeoutMinutes < 0) {
            errors.push(`Level ${level.level}: Timeout must be non-negative`);
          }

          if (!level.notifyUserIds || level.notifyUserIds.length === 0) {
            warnings.push(`Level ${level.level}: No users configured for notification`);
          }

          if (!level.channels || level.channels.length === 0) {
            errors.push(`Level ${level.level}: At least one notification channel is required`);
          }
        }
      }
    }

    // Repeat interval validation
    if ('repeatIntervalMinutes' in dto && dto.repeatIntervalMinutes !== undefined) {
      if (dto.repeatIntervalMinutes < 1) {
        errors.push('Repeat interval must be at least 1 minute');
      }
    }

    // Max repeats validation
    if ('maxRepeats' in dto && dto.maxRepeats !== undefined) {
      if (dto.maxRepeats < 0) {
        errors.push('Max repeats must be non-negative');
      }
    }

    // On-call schedule validation
    if ('onCallSchedule' in dto && dto.onCallSchedule) {
      for (const schedule of dto.onCallSchedule) {
        if (schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) {
          errors.push('Day of week must be between 0 and 6');
        }

        if (!this.isValidTimeFormat(schedule.startTime) || !this.isValidTimeFormat(schedule.endTime)) {
          errors.push('Time must be in HH:mm format');
        }

        if (!schedule.userId) {
          errors.push('On-call user ID is required');
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Add suppression window to policy
   */
  async addSuppressionWindow(
    policyId: string,
    tenantId: string,
    window: SuppressionWindow,
  ): Promise<EscalationPolicy> {
    const policy = await this.getPolicy(policyId, tenantId);

    if (!policy.suppressionWindows) {
      policy.suppressionWindows = [];
    }

    policy.suppressionWindows.push(window);
    const saved = await this.policyRepository.save(policy);
    this.invalidateCache(tenantId);

    return saved;
  }

  /**
   * Remove suppression window from policy
   */
  async removeSuppressionWindow(
    policyId: string,
    tenantId: string,
    windowId: string,
  ): Promise<EscalationPolicy> {
    const policy = await this.getPolicy(policyId, tenantId);

    if (!policy.suppressionWindows) {
      throw new NotFoundException(`Suppression window ${windowId} not found`);
    }

    const index = policy.suppressionWindows.findIndex(w => w.id === windowId);
    if (index === -1) {
      throw new NotFoundException(`Suppression window ${windowId} not found`);
    }

    policy.suppressionWindows.splice(index, 1);
    const saved = await this.policyRepository.save(policy);
    this.invalidateCache(tenantId);

    return saved;
  }

  /**
   * Update on-call schedule
   */
  async updateOnCallSchedule(
    policyId: string,
    tenantId: string,
    schedule: OnCallSchedule[],
  ): Promise<EscalationPolicy> {
    const policy = await this.getPolicy(policyId, tenantId);

    policy.onCallSchedule = schedule;
    const saved = await this.policyRepository.save(policy);
    this.invalidateCache(tenantId);

    return saved;
  }

  /**
   * Get current on-call user for policy
   */
  async getCurrentOnCallUser(policyId: string, tenantId: string, date?: Date): Promise<string | null> {
    const policy = await this.getPolicy(policyId, tenantId);
    return policy.getCurrentOnCall(date) || null;
  }

  /**
   * Check if currently in suppression window
   */
  async isInSuppressionWindow(policyId: string, tenantId: string, date?: Date): Promise<boolean> {
    const policy = await this.getPolicy(policyId, tenantId);
    return policy.isInSuppressionWindow(date);
  }

  /**
   * Clone policy
   */
  async clonePolicy(id: string, tenantId: string, newName: string): Promise<EscalationPolicy> {
    const source = await this.getPolicy(id, tenantId);

    const cloned = this.policyRepository.create({
      ...source,
      id: undefined,
      name: newName,
      isDefault: false,
      createdAt: undefined,
      updatedAt: undefined,
    });

    const saved = await this.policyRepository.save(cloned);
    this.invalidateCache(tenantId);

    return saved;
  }

  /**
   * Get policies by severity
   */
  async getPoliciesBySeverity(tenantId: string, severity: AlertSeverity): Promise<EscalationPolicy[]> {
    const policies = await this.getPolicies(tenantId);
    return policies.filter(p => p.severity.includes(severity));
  }

  /**
   * Unset default policies for tenant
   */
  private async unsetDefaultPolicies(tenantId: string): Promise<void> {
    await this.policyRepository.update(
      { tenantId, isDefault: true },
      { isDefault: false },
    );
  }

  /**
   * Validate time format HH:mm
   */
  private isValidTimeFormat(time: string): boolean {
    const regex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    return regex.test(time);
  }

  /**
   * Cache management
   */
  private getCachedPolicies(tenantId: string): EscalationPolicy[] | null {
    const lastUpdate = this.lastCacheUpdate.get(tenantId);
    if (!lastUpdate || Date.now() - lastUpdate > this.cacheTTL) {
      return null;
    }
    return this.policyCache.get(tenantId) || null;
  }

  private setCachedPolicies(tenantId: string, policies: EscalationPolicy[]): void {
    this.policyCache.set(tenantId, policies);
    this.lastCacheUpdate.set(tenantId, Date.now());
  }

  private invalidateCache(tenantId: string): void {
    this.policyCache.delete(tenantId);
    this.lastCacheUpdate.delete(tenantId);
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.policyCache.clear();
    this.lastCacheUpdate.clear();
  }
}
