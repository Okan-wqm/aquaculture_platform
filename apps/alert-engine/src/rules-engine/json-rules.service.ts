/**
 * JSON Rules Engine Service
 *
 * Implements a JSON-based rules engine for declarative rule definitions.
 * Supports complex conditions, operators, and rule composition similar
 * to json-rules-engine library patterns.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Operators for condition evaluation
 */
export enum RuleOperator {
  // Comparison
  EQUAL = 'equal',
  NOT_EQUAL = 'notEqual',
  LESS_THAN = 'lessThan',
  LESS_THAN_INCLUSIVE = 'lessThanInclusive',
  GREATER_THAN = 'greaterThan',
  GREATER_THAN_INCLUSIVE = 'greaterThanInclusive',

  // String
  CONTAINS = 'contains',
  NOT_CONTAINS = 'notContains',
  STARTS_WITH = 'startsWith',
  ENDS_WITH = 'endsWith',
  MATCHES = 'matches',

  // Array
  IN = 'in',
  NOT_IN = 'notIn',
  CONTAINS_ALL = 'containsAll',
  CONTAINS_ANY = 'containsAny',

  // Existence
  EXISTS = 'exists',
  NOT_EXISTS = 'notExists',
  IS_NULL = 'isNull',
  IS_NOT_NULL = 'isNotNull',
  IS_EMPTY = 'isEmpty',
  IS_NOT_EMPTY = 'isNotEmpty',

  // Type
  IS_TYPE = 'isType',

  // Date
  DATE_BEFORE = 'dateBefore',
  DATE_AFTER = 'dateAfter',
  DATE_BETWEEN = 'dateBetween',

  // Range
  BETWEEN = 'between',
  NOT_BETWEEN = 'notBetween',
}

/**
 * Condition in a rule
 */
export interface RuleCondition {
  fact: string;
  operator: RuleOperator;
  value: unknown;
  path?: string; // JSON path for nested properties
  params?: Record<string, unknown>;
}

/**
 * Condition group with logical operator
 */
export interface ConditionGroup {
  all?: Array<RuleCondition | ConditionGroup>;
  any?: Array<RuleCondition | ConditionGroup>;
  not?: RuleCondition | ConditionGroup;
}

/**
 * Event emitted when a rule triggers
 */
export interface RuleEvent {
  type: string;
  params?: Record<string, unknown>;
}

/**
 * Rule action to execute
 */
export interface RuleAction {
  type: string;
  params?: Record<string, unknown>;
}

/**
 * Complete rule definition
 */
export interface JsonRule {
  id: string;
  name: string;
  description?: string;
  priority: number; // Higher = evaluated first
  conditions: ConditionGroup;
  event: RuleEvent;
  actions?: RuleAction[];
  enabled: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fact definition with resolver
 */
export interface FactDefinition {
  id: string;
  description?: string;
  resolver?: (params: Record<string, unknown>, almanac: Almanac) => Promise<unknown>;
  cacheable: boolean;
  cacheTimeMs?: number;
}

/**
 * Almanac for fact resolution
 */
export interface Almanac {
  facts: Map<string, unknown>;
  params: Record<string, unknown>;
  addFact(factId: string, value: unknown): void;
  getFact(factId: string): unknown;
  resolveFact(factId: string): Promise<unknown>;
}

/**
 * Result of rule evaluation
 */
export interface RuleResult {
  ruleId: string;
  ruleName: string;
  triggered: boolean;
  event?: RuleEvent;
  actions?: RuleAction[];
  conditions: {
    all?: ConditionResult[];
    any?: ConditionResult[];
    not?: ConditionResult;
  };
  evaluationTimeMs: number;
}

/**
 * Result of condition evaluation
 */
export interface ConditionResult {
  fact: string;
  operator: RuleOperator;
  value: unknown;
  factValue: unknown;
  result: boolean;
}

/**
 * Engine run result
 */
export interface EngineResult {
  events: RuleEvent[];
  actions: RuleAction[];
  results: RuleResult[];
  failedRules: string[];
  totalRules: number;
  triggeredRules: number;
  evaluationTimeMs: number;
}

/**
 * Action handler function type
 */
export type ActionHandler = (
  action: RuleAction,
  almanac: Almanac,
  event: RuleEvent,
) => Promise<void>;

@Injectable()
export class JsonRulesService implements OnModuleInit {
  private readonly logger = new Logger(JsonRulesService.name);

  private readonly rules = new Map<string, JsonRule>();
  private readonly facts = new Map<string, FactDefinition>();
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly factCache = new Map<string, { value: unknown; expiresAt: number }>();

  // Custom operators
  private readonly customOperators = new Map<
    string,
    (factValue: unknown, ruleValue: unknown, params?: Record<string, unknown>) => boolean
  >();

  constructor(private readonly eventEmitter: EventEmitter2) {}

  onModuleInit(): void {
    this.registerBuiltinActions();
    this.logger.log('JsonRulesService initialized');
  }

  /**
   * Register built-in action handlers
   */
  private registerBuiltinActions(): void {
    this.registerActionHandler('log', async (action, almanac) => {
      const level = (action.params?.level as string) || 'info';
      const message = action.params?.message as string;
      const logMethod = level === 'debug' ? this.logger.debug.bind(this.logger)
        : level === 'warn' ? this.logger.warn.bind(this.logger)
        : level === 'error' ? this.logger.error.bind(this.logger)
        : this.logger.log.bind(this.logger);
      logMethod(`[Rule Action] ${message}`, { facts: Object.fromEntries(almanac.facts) });
    });

    this.registerActionHandler('emit', async (action, almanac, event) => {
      const eventName = action.params?.event as string || event.type;
      const payload = action.params?.payload || event.params;
      this.eventEmitter.emit(eventName, payload);
    });

    this.registerActionHandler('setFact', async (action, almanac) => {
      const factId = action.params?.factId as string;
      const value = action.params?.value;
      almanac.addFact(factId, value);
    });
  }

  /**
   * Add a rule to the engine
   */
  addRule(rule: JsonRule): void {
    this.validateRule(rule);
    this.rules.set(rule.id, rule);
    this.logger.debug(`Added rule: ${rule.name} (${rule.id})`);
  }

  /**
   * Remove a rule from the engine
   */
  removeRule(ruleId: string): boolean {
    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      this.logger.debug(`Removed rule: ${ruleId}`);
    }
    return deleted;
  }

  /**
   * Get a rule by ID
   */
  getRule(ruleId: string): JsonRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Get all rules
   */
  getAllRules(): JsonRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Update a rule
   */
  updateRule(ruleId: string, updates: Partial<JsonRule>): JsonRule {
    const existing = this.rules.get(ruleId);
    if (!existing) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    const updated: JsonRule = {
      ...existing,
      ...updates,
      id: ruleId, // Prevent ID change
      updatedAt: new Date(),
    };

    this.validateRule(updated);
    this.rules.set(ruleId, updated);
    return updated;
  }

  /**
   * Register a fact definition
   */
  registerFact(fact: FactDefinition): void {
    this.facts.set(fact.id, fact);
    this.logger.debug(`Registered fact: ${fact.id}`);
  }

  /**
   * Register an action handler
   */
  registerActionHandler(type: string, handler: ActionHandler): void {
    this.actionHandlers.set(type, handler);
    this.logger.debug(`Registered action handler: ${type}`);
  }

  /**
   * Register a custom operator
   */
  registerOperator(
    name: string,
    evaluator: (factValue: unknown, ruleValue: unknown, params?: Record<string, unknown>) => boolean,
  ): void {
    this.customOperators.set(name, evaluator);
    this.logger.debug(`Registered custom operator: ${name}`);
  }

  /**
   * Run the rules engine with given facts
   */
  async run(factsInput: Record<string, unknown>): Promise<EngineResult> {
    const startTime = Date.now();
    const almanac = this.createAlmanac(factsInput);

    const events: RuleEvent[] = [];
    const actions: RuleAction[] = [];
    const results: RuleResult[] = [];
    const failedRules: string[] = [];

    // Sort rules by priority (higher first)
    const sortedRules = Array.from(this.rules.values())
      .filter(rule => rule.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      try {
        const result = await this.evaluateRule(rule, almanac);
        results.push(result);

        if (result.triggered) {
          if (result.event) {
            events.push(result.event);
          }
          if (result.actions) {
            actions.push(...result.actions);
          }

          // Execute actions
          await this.executeActions(result.actions || [], almanac, result.event!);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error evaluating rule ${rule.id}: ${errorMessage}`);
        failedRules.push(rule.id);
      }
    }

    const evaluationTimeMs = Date.now() - startTime;

    this.eventEmitter.emit('json-rules.completed', {
      totalRules: sortedRules.length,
      triggeredRules: events.length,
      failedRules: failedRules.length,
      evaluationTimeMs,
    });

    return {
      events,
      actions,
      results,
      failedRules,
      totalRules: sortedRules.length,
      triggeredRules: events.length,
      evaluationTimeMs,
    };
  }

  /**
   * Evaluate a single rule
   */
  private async evaluateRule(rule: JsonRule, almanac: Almanac): Promise<RuleResult> {
    const startTime = Date.now();

    const conditionResults = await this.evaluateConditionGroup(rule.conditions, almanac);
    const triggered = this.isConditionGroupSatisfied(conditionResults);

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      triggered,
      event: triggered ? rule.event : undefined,
      actions: triggered ? rule.actions : undefined,
      conditions: conditionResults,
      evaluationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Evaluate a condition group
   */
  private async evaluateConditionGroup(
    group: ConditionGroup,
    almanac: Almanac,
  ): Promise<{ all?: ConditionResult[]; any?: ConditionResult[]; not?: ConditionResult }> {
    const result: { all?: ConditionResult[]; any?: ConditionResult[]; not?: ConditionResult } = {};

    if (group.all) {
      result.all = [];
      for (const condition of group.all) {
        if (this.isConditionGroup(condition)) {
          // Nested group - flatten for result
          const nested = await this.evaluateConditionGroup(condition, almanac);
          const nestedResult: ConditionResult = {
            fact: 'nested_group',
            operator: RuleOperator.EQUAL,
            value: true,
            factValue: this.isConditionGroupSatisfied(nested),
            result: this.isConditionGroupSatisfied(nested),
          };
          result.all.push(nestedResult);
        } else {
          const condResult = await this.evaluateCondition(condition as RuleCondition, almanac);
          result.all.push(condResult);
        }
      }
    }

    if (group.any) {
      result.any = [];
      for (const condition of group.any) {
        if (this.isConditionGroup(condition)) {
          const nested = await this.evaluateConditionGroup(condition, almanac);
          const nestedResult: ConditionResult = {
            fact: 'nested_group',
            operator: RuleOperator.EQUAL,
            value: true,
            factValue: this.isConditionGroupSatisfied(nested),
            result: this.isConditionGroupSatisfied(nested),
          };
          result.any.push(nestedResult);
        } else {
          const condResult = await this.evaluateCondition(condition as RuleCondition, almanac);
          result.any.push(condResult);
        }
      }
    }

    if (group.not) {
      if (this.isConditionGroup(group.not)) {
        const nested = await this.evaluateConditionGroup(group.not, almanac);
        result.not = {
          fact: 'nested_group',
          operator: RuleOperator.EQUAL,
          value: true,
          factValue: !this.isConditionGroupSatisfied(nested),
          result: !this.isConditionGroupSatisfied(nested),
        };
      } else {
        const condResult = await this.evaluateCondition(group.not as RuleCondition, almanac);
        result.not = {
          ...condResult,
          result: !condResult.result,
        };
      }
    }

    return result;
  }

  /**
   * Check if an object is a condition group
   */
  private isConditionGroup(obj: unknown): obj is ConditionGroup {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    return 'all' in o || 'any' in o || 'not' in o;
  }

  /**
   * Check if a condition group is satisfied
   */
  private isConditionGroupSatisfied(
    results: { all?: ConditionResult[]; any?: ConditionResult[]; not?: ConditionResult },
  ): boolean {
    // Check ALL conditions (must all be true)
    if (results.all && results.all.length > 0) {
      const allSatisfied = results.all.every(r => r.result);
      if (!allSatisfied) return false;
    }

    // Check ANY conditions (at least one must be true)
    if (results.any && results.any.length > 0) {
      const anySatisfied = results.any.some(r => r.result);
      if (!anySatisfied) return false;
    }

    // Check NOT condition (must be true, which means original was false)
    if (results.not) {
      if (!results.not.result) return false;
    }

    return true;
  }

  /**
   * Evaluate a single condition
   */
  private async evaluateCondition(
    condition: RuleCondition,
    almanac: Almanac,
  ): Promise<ConditionResult> {
    const factValue = await this.resolveFact(condition.fact, condition.path, almanac);
    const result = this.evaluateOperator(
      factValue,
      condition.operator,
      condition.value,
      condition.params,
    );

    return {
      fact: condition.fact,
      operator: condition.operator,
      value: condition.value,
      factValue,
      result,
    };
  }

  /**
   * Resolve a fact value
   */
  private async resolveFact(
    factId: string,
    path: string | undefined,
    almanac: Almanac,
  ): Promise<unknown> {
    // Check if fact is already in almanac
    let value = almanac.getFact(factId);

    if (value === undefined) {
      // Check cache
      const cached = this.factCache.get(factId);
      if (cached && cached.expiresAt > Date.now()) {
        value = cached.value;
        almanac.addFact(factId, value);
      } else {
        // Resolve fact
        const factDef = this.facts.get(factId);
        if (factDef?.resolver) {
          value = await factDef.resolver(almanac.params, almanac);

          // Cache if cacheable
          if (factDef.cacheable) {
            this.factCache.set(factId, {
              value,
              expiresAt: Date.now() + (factDef.cacheTimeMs || 60000),
            });
          }
        }
        almanac.addFact(factId, value);
      }
    }

    // Apply JSON path if specified
    if (path && value !== undefined && value !== null) {
      value = this.getNestedValue(value as Record<string, unknown>, path);
    }

    return value;
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce((current: unknown, key) => {
      if (current && typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  /**
   * Evaluate an operator
   */
  private evaluateOperator(
    factValue: unknown,
    operator: RuleOperator | string,
    ruleValue: unknown,
    params?: Record<string, unknown>,
  ): boolean {
    // Check for custom operator
    const customOp = this.customOperators.get(operator);
    if (customOp) {
      return customOp(factValue, ruleValue, params);
    }

    switch (operator) {
      case RuleOperator.EQUAL:
        return factValue === ruleValue;

      case RuleOperator.NOT_EQUAL:
        return factValue !== ruleValue;

      case RuleOperator.LESS_THAN:
        return Number(factValue) < Number(ruleValue);

      case RuleOperator.LESS_THAN_INCLUSIVE:
        return Number(factValue) <= Number(ruleValue);

      case RuleOperator.GREATER_THAN:
        return Number(factValue) > Number(ruleValue);

      case RuleOperator.GREATER_THAN_INCLUSIVE:
        return Number(factValue) >= Number(ruleValue);

      case RuleOperator.CONTAINS:
        if (typeof factValue === 'string') {
          return factValue.includes(String(ruleValue));
        }
        if (Array.isArray(factValue)) {
          return factValue.includes(ruleValue);
        }
        return false;

      case RuleOperator.NOT_CONTAINS:
        if (typeof factValue === 'string') {
          return !factValue.includes(String(ruleValue));
        }
        if (Array.isArray(factValue)) {
          return !factValue.includes(ruleValue);
        }
        return true;

      case RuleOperator.STARTS_WITH:
        return String(factValue).startsWith(String(ruleValue));

      case RuleOperator.ENDS_WITH:
        return String(factValue).endsWith(String(ruleValue));

      case RuleOperator.MATCHES:
        return new RegExp(String(ruleValue)).test(String(factValue));

      case RuleOperator.IN:
        if (Array.isArray(ruleValue)) {
          return ruleValue.includes(factValue);
        }
        return false;

      case RuleOperator.NOT_IN:
        if (Array.isArray(ruleValue)) {
          return !ruleValue.includes(factValue);
        }
        return true;

      case RuleOperator.CONTAINS_ALL:
        if (Array.isArray(factValue) && Array.isArray(ruleValue)) {
          return ruleValue.every(v => factValue.includes(v));
        }
        return false;

      case RuleOperator.CONTAINS_ANY:
        if (Array.isArray(factValue) && Array.isArray(ruleValue)) {
          return ruleValue.some(v => factValue.includes(v));
        }
        return false;

      case RuleOperator.EXISTS:
        return factValue !== undefined;

      case RuleOperator.NOT_EXISTS:
        return factValue === undefined;

      case RuleOperator.IS_NULL:
        return factValue === null;

      case RuleOperator.IS_NOT_NULL:
        return factValue !== null;

      case RuleOperator.IS_EMPTY:
        if (factValue === null || factValue === undefined) return true;
        if (typeof factValue === 'string') return factValue.length === 0;
        if (Array.isArray(factValue)) return factValue.length === 0;
        if (typeof factValue === 'object') return Object.keys(factValue).length === 0;
        return false;

      case RuleOperator.IS_NOT_EMPTY:
        if (factValue === null || factValue === undefined) return false;
        if (typeof factValue === 'string') return factValue.length > 0;
        if (Array.isArray(factValue)) return factValue.length > 0;
        if (typeof factValue === 'object') return Object.keys(factValue).length > 0;
        return true;

      case RuleOperator.IS_TYPE:
        return typeof factValue === ruleValue;

      case RuleOperator.DATE_BEFORE:
        return new Date(factValue as string).getTime() < new Date(ruleValue as string).getTime();

      case RuleOperator.DATE_AFTER:
        return new Date(factValue as string).getTime() > new Date(ruleValue as string).getTime();

      case RuleOperator.DATE_BETWEEN: {
        const dateValue = new Date(factValue as string).getTime();
        const [start, end] = ruleValue as [string, string];
        return dateValue >= new Date(start).getTime() && dateValue <= new Date(end).getTime();
      }

      case RuleOperator.BETWEEN: {
        const numValue = Number(factValue);
        const [min, max] = ruleValue as [number, number];
        return numValue >= min && numValue <= max;
      }

      case RuleOperator.NOT_BETWEEN: {
        const numValue = Number(factValue);
        const [min, max] = ruleValue as [number, number];
        return numValue < min || numValue > max;
      }

      default:
        this.logger.warn(`Unknown operator: ${operator}`);
        return false;
    }
  }

  /**
   * Execute actions for a triggered rule
   */
  private async executeActions(
    actions: RuleAction[],
    almanac: Almanac,
    event: RuleEvent,
  ): Promise<void> {
    for (const action of actions) {
      const handler = this.actionHandlers.get(action.type);
      if (handler) {
        try {
          await handler(action, almanac, event);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error executing action ${action.type}: ${errorMessage}`);
        }
      } else {
        this.logger.warn(`No handler found for action type: ${action.type}`);
      }
    }
  }

  /**
   * Create an almanac for fact resolution
   */
  private createAlmanac(facts: Record<string, unknown>): Almanac {
    const factsMap = new Map<string, unknown>(Object.entries(facts));
    const self = this;

    return {
      facts: factsMap,
      params: facts,

      addFact(factId: string, value: unknown): void {
        factsMap.set(factId, value);
      },

      getFact(factId: string): unknown {
        return factsMap.get(factId);
      },

      async resolveFact(factId: string): Promise<unknown> {
        return self.resolveFact(factId, undefined, this);
      },
    };
  }

  /**
   * Validate a rule definition
   */
  private validateRule(rule: JsonRule): void {
    if (!rule.id) {
      throw new Error('Rule must have an id');
    }
    if (!rule.name) {
      throw new Error('Rule must have a name');
    }
    if (!rule.conditions) {
      throw new Error('Rule must have conditions');
    }
    if (!rule.event) {
      throw new Error('Rule must have an event');
    }
    if (rule.priority === undefined || rule.priority === null) {
      throw new Error('Rule must have a priority');
    }

    this.validateConditionGroup(rule.conditions);
  }

  /**
   * Validate a condition group
   */
  private validateConditionGroup(group: ConditionGroup): void {
    if (!group.all && !group.any && !group.not) {
      throw new Error('Condition group must have at least one of: all, any, not');
    }

    if (group.all) {
      for (const condition of group.all) {
        if (this.isConditionGroup(condition)) {
          this.validateConditionGroup(condition);
        } else {
          this.validateCondition(condition as RuleCondition);
        }
      }
    }

    if (group.any) {
      for (const condition of group.any) {
        if (this.isConditionGroup(condition)) {
          this.validateConditionGroup(condition);
        } else {
          this.validateCondition(condition as RuleCondition);
        }
      }
    }

    if (group.not) {
      if (this.isConditionGroup(group.not)) {
        this.validateConditionGroup(group.not);
      } else {
        this.validateCondition(group.not as RuleCondition);
      }
    }
  }

  /**
   * Validate a single condition
   */
  private validateCondition(condition: RuleCondition): void {
    if (!condition.fact) {
      throw new Error('Condition must have a fact');
    }
    if (!condition.operator) {
      throw new Error('Condition must have an operator');
    }
  }

  /**
   * Create a rule from JSON
   */
  createRuleFromJson(json: string | object): JsonRule {
    const data = typeof json === 'string' ? JSON.parse(json) : json;

    const rule: JsonRule = {
      id: data.id,
      name: data.name,
      description: data.description,
      priority: data.priority ?? 1,
      conditions: data.conditions,
      event: data.event,
      actions: data.actions,
      enabled: data.enabled ?? true,
      tags: data.tags,
      metadata: data.metadata,
      createdAt: new Date(data.createdAt || Date.now()),
      updatedAt: new Date(data.updatedAt || Date.now()),
    };

    this.validateRule(rule);
    return rule;
  }

  /**
   * Export a rule to JSON
   */
  exportRuleToJson(ruleId: string): string {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    return JSON.stringify(rule, null, 2);
  }

  /**
   * Clear the fact cache
   */
  clearCache(): void {
    this.factCache.clear();
    this.logger.debug('Fact cache cleared');
  }

  /**
   * Get rules by tag
   */
  getRulesByTag(tag: string): JsonRule[] {
    return Array.from(this.rules.values()).filter(rule => rule.tags?.includes(tag));
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
      rule.updatedAt = new Date();
      this.logger.debug(`Rule ${ruleId} ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Bulk load rules
   */
  loadRules(rules: JsonRule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
    this.logger.log(`Loaded ${rules.length} rules`);
  }

  /**
   * Export all rules
   */
  exportAllRules(): string {
    return JSON.stringify(Array.from(this.rules.values()), null, 2);
  }
}
