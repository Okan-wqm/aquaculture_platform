import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UUID_PATTERN } from '@platform/event-contracts';
import {
  EscalationPolicy,
  EscalationLevel,
  OnCallSchedule,
} from '../database/entities/escalation-policy.entity';
import type { NewSuppressionWindow } from '../database/entities/suppression-window';
import { AlertSeverity } from '../database/entities/alert-rule.entity';
import { ensureDefaultEscalationPolicy } from './default-escalation-policy';

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
  /** Stamped with id/creator/admin flag by EscalationPolicyWriter. */
  suppressionWindows?: NewSuppressionWindow[];
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
 * Update policy DTO. Suppression windows change only through their own write
 * paths (which stamp the creator's role), never through a plain update.
 */
export interface UpdatePolicyDto
  extends Partial<Omit<CreatePolicyDto, 'tenantId' | 'suppressionWindows' | 'createdBy'>> {
  isActive?: boolean;
}

/** The fields `validatePolicy` checks (a full policy, a create or an update DTO). */
export type PolicyValidationInput = Partial<
  Pick<
    CreatePolicyDto,
    'name' | 'severity' | 'levels' | 'onCallSchedule' | 'repeatIntervalMinutes' | 'maxRepeats'
  >
>;

const USER_ID = new RegExp(UUID_PATTERN);

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

    let policies = await this.loadPolicies(tenantId);

    // POINT-OF-USE ENSURE (ALERT-CRITICAL-004): a tenant with no policy at all
    // gets its default right here, in its own tenant context, before anything
    // tries to escalate — so an alarm that arrives before the provisioning
    // event or the periodic reconcile has run still reaches a person.
    if (policies.length === 0) {
      const outcome = await ensureDefaultEscalationPolicy(this.policyRepository.manager, tenantId);
      if (outcome === 'created') {
        this.logger.log(`Seeded default escalation policy for tenant ${tenantId} at point of use`);
      }
      policies = await this.loadPolicies(tenantId);
    }

    this.setCachedPolicies(tenantId, policies);

    return activeOnly ? policies.filter(p => p.isActive) : policies;
  }

  private loadPolicies(tenantId: string): Promise<EscalationPolicy[]> {
    return this.policyRepository.find({
      where: { tenantId },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
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
      // A policy's severity list is its contract: the default policy is
      // already a candidate above for every severity it covers, and falling
      // back to it for a severity it does NOT list (the old behaviour) would
      // page CRITICAL recipients for INFO noise.
      return null;
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
  validatePolicy(dto: PolicyValidationInput): PolicyValidationResult {
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

          // V-S1b-6: an explicit recipient must be a user id — free text names
          // nobody and used to be dropped silently at delivery time.
          const malformed = level.notifyUserIds.filter((id) => !USER_ID.test(id));
          if (malformed.length > 0) {
            errors.push(`Level ${level.level}: notifyUserIds must be user ids`);
          }

          // A level that pages nobody is a silent alarm: it needs explicit
          // users, a role target, or an on-call schedule (ALERT-CRITICAL-004).
          const hasUsers = level.notifyUserIds.length > 0;
          const hasRoles = (level.notifyRoles ?? []).length > 0;
          const hasOnCall = (dto.onCallSchedule ?? []).length > 0;
          if (!hasUsers && !hasRoles && !hasOnCall) {
            errors.push(
              `Level ${level.level}: at least one recipient (user, role or on-call schedule) is required`,
            );
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

        if (!schedule.userId || !USER_ID.test(schedule.userId)) {
          errors.push('On-call user ID must be a user id');
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
   * Get current on-call user for policy
   */
  async getCurrentOnCallUser(policyId: string, tenantId: string, date?: Date): Promise<string | null> {
    const policy = await this.getPolicy(policyId, tenantId);
    return policy.getCurrentOnCall(date) || null;
  }

  /**
   * Get policies by severity
   */
  async getPoliciesBySeverity(tenantId: string, severity: AlertSeverity): Promise<EscalationPolicy[]> {
    const policies = await this.getPolicies(tenantId);
    return policies.filter(p => p.severity.includes(severity));
  }

  // PE-12: Regex promoted to a static constant to avoid re-evaluation on every call.
  private static readonly TIME_FORMAT_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

  /**
   * Validate time format HH:mm
   */
  private isValidTimeFormat(time: string): boolean {
    return EscalationPolicyService.TIME_FORMAT_REGEX.test(time);
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

  /** Drop the tenant's cached policies (after a write this process did not make itself). */
  invalidateCache(tenantId: string): void {
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
