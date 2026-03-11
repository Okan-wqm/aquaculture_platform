import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { AlertRule, AlertCondition, AlertOperator, AlertSeverity } from '../database/entities/alert-rule.entity';
import { RuleEvaluatorService, EvaluationContext, EvaluationResult } from './rule-evaluator.service';

/**
 * Rule evaluation strategy
 */
export enum RuleMatchStrategy {
  FIRST_MATCH = 'FIRST_MATCH', // Return first matching rule
  ALL_MATCH = 'ALL_MATCH', // Return all matching rules
  BEST_MATCH = 'BEST_MATCH', // Return highest priority/severity match
}

/**
 * Rule evaluation request
 */
export interface RuleEvaluationRequest {
  tenantId: string;
  context: EvaluationContext;
  ruleIds?: string[];
  farmId?: string;
  pondId?: string;
  sensorId?: string;
  strategy?: RuleMatchStrategy;
}

/**
 * Rule match result
 */
export interface RuleMatch {
  rule: AlertRule;
  matchedConditions: AlertCondition[];
  severity: AlertSeverity;
  evaluationResult: EvaluationResult;
}

/**
 * Cached rules entry - stores all rules for a given cache key
 */
interface CachedRules {
  rules: AlertRule[];
  cachedAt: number;
  ttlMs: number;
}

/**
 * Rules Engine Service
 * Main orchestrator for rule evaluation and management
 */
@Injectable()
export class RulesEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RulesEngineService.name);
  private ruleCache: Map<string, CachedRules> = new Map();
  private readonly DEFAULT_CACHE_TTL_MS = 60000; // 1 minute
  private readonly EVALUATION_TIMEOUT_MS = 5000; // 5 seconds

  // PE-05: Periodic eviction of stale cache entries prevents unbounded growth.
  // The cache key space is O(tenants * farms * ponds * sensors); without
  // proactive eviction, entries for decommissioned sensors accumulate forever.
  private cacheEvictionInterval: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(AlertRule)
    private readonly ruleRepository: Repository<AlertRule>,
    private readonly ruleEvaluator: RuleEvaluatorService,
  ) {}

  onModuleInit(): void {
    // Sweep stale entries every 2 × TTL so any entry is evicted within 3 × TTL.
    this.cacheEvictionInterval = setInterval(() => {
      this.evictStaleEntries();
    }, this.DEFAULT_CACHE_TTL_MS * 2);
  }

  onModuleDestroy(): void {
    if (this.cacheEvictionInterval) {
      clearInterval(this.cacheEvictionInterval);
      this.cacheEvictionInterval = null;
    }
  }

  /** Remove all cache entries whose TTL has expired. */
  private evictStaleEntries(): void {
    const now = Date.now();
    for (const [key, cached] of this.ruleCache) {
      if (now > cached.cachedAt + cached.ttlMs) {
        this.ruleCache.delete(key);
      }
    }
  }

  /**
   * Evaluate rules for given context
   */
  async evaluateRules(request: RuleEvaluationRequest): Promise<RuleMatch[]> {
    const startTime = Date.now();

    try {
      // Get applicable rules
      const rules = await this.getApplicableRules(request);

      if (rules.length === 0) {
        this.logger.debug(`No applicable rules found for tenant ${request.tenantId}`);
        return [];
      }

      // PE-10: Evaluate all rules concurrently under a single shared timeout
      // instead of wrapping each rule in an individual setTimeout.
      // FIRST_MATCH still gets the highest-priority match from the settled results.
      const matches: RuleMatch[] = [];

      if (request.strategy === RuleMatchStrategy.FIRST_MATCH) {
        // Sequential is correct here to respect rule priority order.
        for (const rule of rules) {
          const match = await this.evaluateRuleWithTimeout(rule, request.context);
          if (match) {
            matches.push(match);
            break;
          }
        }
      } else {
        // ALL_MATCH / BEST_MATCH: evaluate all rules in parallel.
        const settled = await Promise.allSettled(
          rules.map(rule => this.evaluateRuleWithTimeout(rule, request.context)),
        );
        for (const result of settled) {
          if (result.status === 'fulfilled' && result.value) {
            matches.push(result.value);
          }
        }
      }

      // Sort by strategy
      const sortedMatches = this.sortMatchesByStrategy(matches, request.strategy);

      const duration = Date.now() - startTime;
      this.logger.debug(
        `Evaluated ${rules.length} rules in ${duration}ms, found ${matches.length} matches`,
      );

      return sortedMatches;
    } catch (error) {
      this.logger.error(`Rule evaluation failed: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  /**
   * Evaluate a single rule
   */
  async evaluateRule(rule: AlertRule, context: EvaluationContext): Promise<RuleMatch | null> {
    return this.evaluateRuleWithTimeout(rule, context);
  }

  /**
   * Get applicable rules for the request
   */
  async getApplicableRules(request: RuleEvaluationRequest): Promise<AlertRule[]> {
    // Check cache first
    const cacheKey = this.buildRuleCacheKey(request);
    const cachedRules = this.getCachedRules(cacheKey);

    if (cachedRules) {
      return cachedRules;
    }

    // Build query
    const queryBuilder = this.ruleRepository
      .createQueryBuilder('rule')
      .where('rule.tenantId = :tenantId', { tenantId: request.tenantId })
      .andWhere('rule.isActive = :isActive', { isActive: true });

    // Add optional filters
    if (request.ruleIds?.length) {
      queryBuilder.andWhere('rule.id IN (:...ruleIds)', { ruleIds: request.ruleIds });
    }

    if (request.farmId) {
      queryBuilder.andWhere('(rule.farmId = :farmId OR rule.farmId IS NULL)', { farmId: request.farmId });
    }

    if (request.pondId) {
      queryBuilder.andWhere('(rule.pondId = :pondId OR rule.pondId IS NULL)', { pondId: request.pondId });
    }

    if (request.sensorId) {
      queryBuilder.andWhere('(rule.sensorId = :sensorId OR rule.sensorId IS NULL)', { sensorId: request.sensorId });
    }

    const rules = await queryBuilder.getMany();

    // Cache results
    this.cacheRules(cacheKey, rules);

    return rules;
  }

  /**
   * Create a new rule
   */
  async createRule(rule: Partial<AlertRule>): Promise<AlertRule> {
    const newRule = this.ruleRepository.create(rule);
    const savedRule = await this.ruleRepository.save(newRule);

    // Invalidate cache for tenant
    this.invalidateTenantCache(rule.tenantId!);

    this.logger.log(`Created rule ${savedRule.id} for tenant ${savedRule.tenantId}`);
    return savedRule;
  }

  /**
   * Update a rule
   */
  async updateRule(id: string, tenantId: string, updates: Partial<AlertRule>): Promise<AlertRule> {
    const rule = await this.ruleRepository.findOne({ where: { id, tenantId } });

    if (!rule) {
      throw new Error(`Rule ${id} not found for tenant ${tenantId}`);
    }

    // Prevent tenantId from being changed via updates
    delete updates.tenantId;

    Object.assign(rule, updates);
    const savedRule = await this.ruleRepository.save(rule);

    // Invalidate cache
    this.invalidateTenantCache(rule.tenantId);

    this.logger.log(`Updated rule ${id} for tenant ${tenantId}`);
    return savedRule;
  }

  /**
   * Delete a rule
   */
  async deleteRule(id: string, tenantId: string): Promise<void> {
    const rule = await this.ruleRepository.findOne({ where: { id, tenantId } });

    if (!rule) {
      throw new Error(`Rule ${id} not found for tenant ${tenantId}`);
    }

    await this.ruleRepository.delete({ id, tenantId });

    // Invalidate cache
    this.invalidateTenantCache(rule.tenantId);

    this.logger.log(`Deleted rule ${id} for tenant ${tenantId}`);
  }

  /**
   * Toggle rule active status
   */
  async toggleRuleStatus(id: string, tenantId: string, isActive: boolean): Promise<AlertRule> {
    return this.updateRule(id, tenantId, { isActive });
  }

  /**
   * Get rule by ID
   */
  async getRuleById(id: string, tenantId: string): Promise<AlertRule | null> {
    return this.ruleRepository.findOne({ where: { id, tenantId } });
  }

  /**
   * Get rules by tenant
   */
  async getRulesByTenant(tenantId: string, includeInactive = false): Promise<AlertRule[]> {
    const where: FindOptionsWhere<AlertRule> = { tenantId };
    if (!includeInactive) {
      where.isActive = true;
    }
    return this.ruleRepository.find({ where, order: { createdAt: 'DESC' } });
  }

  /**
   * Validate rule conditions
   */
  validateRuleConditions(conditions: AlertCondition[]): string[] {
    const errors: string[] = [];

    if (!conditions || conditions.length === 0) {
      errors.push('At least one condition is required');
      return errors;
    }

    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i]!;

      if (!condition.parameter) {
        errors.push(`Condition ${i + 1}: parameter is required`);
      }

      if (!condition.operator) {
        errors.push(`Condition ${i + 1}: operator is required`);
      } else if (!Object.values(AlertOperator).includes(condition.operator)) {
        errors.push(`Condition ${i + 1}: invalid operator "${condition.operator}"`);
      }

      if (condition.threshold === undefined || condition.threshold === null) {
        errors.push(`Condition ${i + 1}: threshold is required`);
      } else if (typeof condition.threshold !== 'number' || isNaN(condition.threshold)) {
        errors.push(`Condition ${i + 1}: threshold must be a valid number`);
      }

      if (!condition.severity) {
        errors.push(`Condition ${i + 1}: severity is required`);
      } else if (!Object.values(AlertSeverity).includes(condition.severity)) {
        errors.push(`Condition ${i + 1}: invalid severity "${condition.severity}"`);
      }
    }

    return errors;
  }

  /**
   * Hot reload rules (for runtime updates)
   */
  async hotReloadRules(tenantId: string): Promise<void> {
    this.invalidateTenantCache(tenantId);
    this.logger.log(`Hot reloaded rules for tenant ${tenantId}`);
  }

  // ============================================
  // Private Methods
  // ============================================

  private async evaluateRuleWithTimeout(
    rule: AlertRule,
    context: EvaluationContext,
  ): Promise<RuleMatch | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Log at warn level with explicit "timed out" label so operators can
        // distinguish this from a legitimate non-match in logs and metrics.
        this.logger.warn(
          `Rule ${rule.id} evaluation timed out after ${this.EVALUATION_TIMEOUT_MS}ms. ` +
          'This rule is being treated as a non-match for this cycle. ' +
          'Investigate the rule complexity if this warning recurs.',
        );
        resolve(null);
      }, this.EVALUATION_TIMEOUT_MS);

      this.ruleEvaluator
        .evaluate(rule, context)
        .then((result) => {
          clearTimeout(timeout);

          if (result.matched) {
            resolve({
              rule,
              matchedConditions: result.matchedConditions,
              severity: this.getHighestSeverity(result.matchedConditions),
              evaluationResult: result,
            });
          } else {
            resolve(null);
          }
        })
        .catch((error) => {
          clearTimeout(timeout);
          this.logger.error(`Error evaluating rule ${rule.id}: ${error.message}`);
          resolve(null);
        });
    });
  }

  private getHighestSeverity(conditions: AlertCondition[]): AlertSeverity {
    const severityOrder: Record<AlertSeverity, number> = {
      [AlertSeverity.CRITICAL]: 5,
      [AlertSeverity.HIGH]: 4,
      [AlertSeverity.MEDIUM]: 3,
      [AlertSeverity.WARNING]: 2,
      [AlertSeverity.LOW]: 1,
      [AlertSeverity.INFO]: 0,
    };

    let highest = AlertSeverity.INFO;
    let highestScore = 0;

    for (const condition of conditions) {
      const score = severityOrder[condition.severity] || 0;
      if (score > highestScore) {
        highestScore = score;
        highest = condition.severity;
      }
    }

    return highest;
  }

  private sortMatchesByStrategy(
    matches: RuleMatch[],
    strategy?: RuleMatchStrategy,
  ): RuleMatch[] {
    if (!matches.length || strategy === RuleMatchStrategy.FIRST_MATCH) {
      return matches;
    }

    if (strategy === RuleMatchStrategy.BEST_MATCH) {
      // Sort by severity (CRITICAL > HIGH > MEDIUM > WARNING > LOW > INFO)
      const severityOrder: Record<AlertSeverity, number> = {
        [AlertSeverity.CRITICAL]: 5,
        [AlertSeverity.HIGH]: 4,
        [AlertSeverity.MEDIUM]: 3,
        [AlertSeverity.WARNING]: 2,
        [AlertSeverity.LOW]: 1,
        [AlertSeverity.INFO]: 0,
      };

      return [...matches].sort((a, b) => {
        return severityOrder[b.severity] - severityOrder[a.severity];
      });
    }

    return matches; // ALL_MATCH returns all
  }

  private buildRuleCacheKey(request: RuleEvaluationRequest): string {
    const parts = [
      request.tenantId,
      request.farmId || 'all',
      request.pondId || 'all',
      request.sensorId || 'all',
    ];
    return `rules:${parts.join(':')}`;
  }

  private getCachedRules(key: string): AlertRule[] | null {
    const cached = this.ruleCache.get(key);

    if (!cached) return null;

    const now = Date.now();
    if (now - cached.cachedAt > cached.ttlMs) {
      this.ruleCache.delete(key);
      return null;
    }

    return cached.rules;
  }

  private cacheRules(key: string, rules: AlertRule[]): void {
    // Cache all rules under the same key
    this.ruleCache.set(key, {
      rules,
      cachedAt: Date.now(),
      ttlMs: this.DEFAULT_CACHE_TTL_MS,
    });
  }

  private invalidateTenantCache(tenantId: string): void {
    const keysToDelete: string[] = [];

    for (const key of this.ruleCache.keys()) {
      if (key.startsWith(`rules:${tenantId}`)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.ruleCache.delete(key);
    }

    this.logger.debug(`Invalidated ${keysToDelete.length} cached rules for tenant ${tenantId}`);
  }

  /**
   * Clear all cache (for testing)
   */
  clearCache(): void {
    this.ruleCache.clear();
  }

  /**
   * Get cache stats (for monitoring)
   * Keys are hashed to avoid exposing tenant IDs in diagnostic output.
   */
  getCacheStats(): { size: number; keyCount: number } {
    return {
      size: this.ruleCache.size,
      keyCount: this.ruleCache.size,
    };
  }
}
