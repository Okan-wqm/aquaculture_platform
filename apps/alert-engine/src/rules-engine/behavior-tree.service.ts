/**
 * Behavior Tree Service
 *
 * Implements behavior tree pattern for complex decision-making in alert rules.
 * Supports composite nodes (sequence, selector, parallel), decorators (inverter,
 * repeater, retry, timeout), and leaf nodes (action, condition).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Status of a behavior tree node execution
 */
export enum NodeStatus {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  RUNNING = 'RUNNING',
}

/**
 * Types of behavior tree nodes
 */
export enum NodeType {
  // Composite nodes
  SEQUENCE = 'SEQUENCE',
  SELECTOR = 'SELECTOR',
  PARALLEL = 'PARALLEL',

  // Decorator nodes
  INVERTER = 'INVERTER',
  REPEATER = 'REPEATER',
  RETRY = 'RETRY',
  TIMEOUT = 'TIMEOUT',
  SUCCEEDER = 'SUCCEEDER',
  FAILER = 'FAILER',

  // Leaf nodes
  ACTION = 'ACTION',
  CONDITION = 'CONDITION',
}

/**
 * Base behavior tree node interface
 */
export interface BehaviorNode {
  id: string;
  type: NodeType;
  name: string;
  children?: BehaviorNode[];

  // Decorator properties
  maxRetries?: number;
  repeatCount?: number;
  timeoutMs?: number;

  // Leaf node properties
  actionId?: string;
  conditionId?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Execution context passed through the tree
 */
export interface ExecutionContext {
  data: Record<string, unknown>;
  variables: Map<string, unknown>;
  startTime: number;
  nodeResults: Map<string, NodeStatus>;
  metadata: Record<string, unknown>;
}

/**
 * Result of a node execution
 */
export interface NodeResult {
  status: NodeStatus;
  data?: unknown;
  error?: string;
  executionTimeMs: number;
}

/**
 * Behavior tree definition
 */
export interface BehaviorTree {
  id: string;
  name: string;
  description?: string;
  version: string;
  root: BehaviorNode;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Action handler function type
 */
export type ActionHandler = (
  context: ExecutionContext,
  parameters: Record<string, unknown>,
) => Promise<NodeResult>;

/**
 * Condition handler function type
 */
export type ConditionHandler = (
  context: ExecutionContext,
  parameters: Record<string, unknown>,
) => Promise<boolean>;

/**
 * Execution statistics
 */
export interface ExecutionStats {
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  runningCount: number;
  averageExecutionTimeMs: number;
  lastExecutionTime: Date | null;
}

@Injectable()
export class BehaviorTreeService implements OnModuleInit {
  private readonly logger = new Logger(BehaviorTreeService.name);

  private readonly trees = new Map<string, BehaviorTree>();
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly conditionHandlers = new Map<string, ConditionHandler>();
  private readonly executionStats = new Map<string, ExecutionStats>();

  // Built-in action/condition IDs
  private static readonly BUILTIN_ACTIONS = [
    'log',
    'setVariable',
    'clearVariable',
    'emit',
    'wait',
  ];

  private static readonly BUILTIN_CONDITIONS = [
    'equals',
    'notEquals',
    'greaterThan',
    'lessThan',
    'contains',
    'matches',
    'exists',
    'isEmpty',
  ];

  constructor(private readonly eventEmitter: EventEmitter2) {}

  onModuleInit(): void {
    this.registerBuiltinHandlers();
    this.logger.log('BehaviorTreeService initialized with built-in handlers');
  }

  /**
   * Register built-in action and condition handlers
   */
  private registerBuiltinHandlers(): void {
    // Built-in actions
    this.registerAction('log', async (context, params) => {
      const start = Date.now();
      const message = params.message as string;
      const level = (params.level as string) || 'info';

      const logMethod = level === 'debug' ? this.logger.debug.bind(this.logger)
        : level === 'warn' ? this.logger.warn.bind(this.logger)
        : level === 'error' ? this.logger.error.bind(this.logger)
        : this.logger.log.bind(this.logger);
      logMethod(`[BT] ${message}`, { context: context.data });

      return {
        status: NodeStatus.SUCCESS,
        executionTimeMs: Date.now() - start,
      };
    });

    this.registerAction('setVariable', async (context, params) => {
      const start = Date.now();
      const name = params.name as string;
      const value = params.value;

      context.variables.set(name, value);

      return {
        status: NodeStatus.SUCCESS,
        data: { [name]: value },
        executionTimeMs: Date.now() - start,
      };
    });

    this.registerAction('clearVariable', async (context, params) => {
      const start = Date.now();
      const name = params.name as string;

      context.variables.delete(name);

      return {
        status: NodeStatus.SUCCESS,
        executionTimeMs: Date.now() - start,
      };
    });

    this.registerAction('emit', async (context, params) => {
      const start = Date.now();
      const event = params.event as string;
      const payload = params.payload || context.data;

      this.eventEmitter.emit(event, payload);

      return {
        status: NodeStatus.SUCCESS,
        data: { event, payload },
        executionTimeMs: Date.now() - start,
      };
    });

    this.registerAction('wait', async (context, params) => {
      const start = Date.now();
      const durationMs = (params.durationMs as number) || 1000;

      await new Promise(resolve => setTimeout(resolve, durationMs));

      return {
        status: NodeStatus.SUCCESS,
        data: { waitedMs: durationMs },
        executionTimeMs: Date.now() - start,
      };
    });

    // Built-in conditions
    this.registerCondition('equals', async (context, params) => {
      const left = this.resolveValue(params.left, context);
      const right = this.resolveValue(params.right, context);
      return left === right;
    });

    this.registerCondition('notEquals', async (context, params) => {
      const left = this.resolveValue(params.left, context);
      const right = this.resolveValue(params.right, context);
      return left !== right;
    });

    this.registerCondition('greaterThan', async (context, params) => {
      const left = this.resolveValue(params.left, context) as number;
      const right = this.resolveValue(params.right, context) as number;
      return left > right;
    });

    this.registerCondition('lessThan', async (context, params) => {
      const left = this.resolveValue(params.left, context) as number;
      const right = this.resolveValue(params.right, context) as number;
      return left < right;
    });

    this.registerCondition('contains', async (context, params) => {
      const haystack = this.resolveValue(params.haystack, context);
      const needle = this.resolveValue(params.needle, context);

      if (Array.isArray(haystack)) {
        return haystack.includes(needle);
      }
      if (typeof haystack === 'string') {
        return haystack.includes(String(needle));
      }
      return false;
    });

    this.registerCondition('matches', async (context, params) => {
      const value = String(this.resolveValue(params.value, context));
      const pattern = params.pattern as string;
      const regex = new RegExp(pattern);
      return regex.test(value);
    });

    this.registerCondition('exists', async (context, params) => {
      const path = params.path as string;
      const value = this.getNestedValue(context.data, path);
      return value !== undefined && value !== null;
    });

    this.registerCondition('isEmpty', async (context, params) => {
      const value = this.resolveValue(params.value, context);

      if (value === null || value === undefined) return true;
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === 'string') return value.length === 0;
      if (typeof value === 'object') return Object.keys(value).length === 0;
      return false;
    });
  }

  /**
   * Resolve a value that might be a variable reference
   */
  private resolveValue(value: unknown, context: ExecutionContext): unknown {
    if (typeof value === 'string' && value.startsWith('$')) {
      const varName = value.substring(1);
      if (context.variables.has(varName)) {
        return context.variables.get(varName);
      }
      return this.getNestedValue(context.data, varName);
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
   * Register a behavior tree
   */
  registerTree(tree: BehaviorTree): void {
    this.validateTree(tree);
    this.trees.set(tree.id, tree);
    this.executionStats.set(tree.id, {
      totalExecutions: 0,
      successCount: 0,
      failureCount: 0,
      runningCount: 0,
      averageExecutionTimeMs: 0,
      lastExecutionTime: null,
    });
    this.logger.log(`Registered behavior tree: ${tree.name} (${tree.id})`);
  }

  /**
   * Unregister a behavior tree
   */
  unregisterTree(treeId: string): boolean {
    const deleted = this.trees.delete(treeId);
    if (deleted) {
      this.executionStats.delete(treeId);
      this.logger.log(`Unregistered behavior tree: ${treeId}`);
    }
    return deleted;
  }

  /**
   * Get a registered behavior tree
   */
  getTree(treeId: string): BehaviorTree | undefined {
    return this.trees.get(treeId);
  }

  /**
   * Get all registered behavior trees
   */
  getAllTrees(): BehaviorTree[] {
    return Array.from(this.trees.values());
  }

  /**
   * Register a custom action handler
   */
  registerAction(actionId: string, handler: ActionHandler): void {
    if (this.actionHandlers.has(actionId)) {
      this.logger.warn(`Overwriting existing action handler: ${actionId}`);
    }
    this.actionHandlers.set(actionId, handler);
    this.logger.debug(`Registered action handler: ${actionId}`);
  }

  /**
   * Register a custom condition handler
   */
  registerCondition(conditionId: string, handler: ConditionHandler): void {
    if (this.conditionHandlers.has(conditionId)) {
      this.logger.warn(`Overwriting existing condition handler: ${conditionId}`);
    }
    this.conditionHandlers.set(conditionId, handler);
    this.logger.debug(`Registered condition handler: ${conditionId}`);
  }

  /**
   * Execute a behavior tree
   */
  async execute(
    treeId: string,
    data: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Promise<NodeResult> {
    const tree = this.trees.get(treeId);
    if (!tree) {
      throw new Error(`Behavior tree not found: ${treeId}`);
    }

    const context: ExecutionContext = {
      data,
      variables: new Map(),
      startTime: Date.now(),
      nodeResults: new Map(),
      metadata: metadata || {},
    };

    const startTime = Date.now();

    try {
      const result = await this.executeNode(tree.root, context);

      this.updateStats(treeId, result.status, Date.now() - startTime);

      this.eventEmitter.emit('behavior-tree.executed', {
        treeId,
        treeName: tree.name,
        status: result.status,
        executionTimeMs: result.executionTimeMs,
        data,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error executing behavior tree ${treeId}: ${errorMessage}`);

      this.updateStats(treeId, NodeStatus.FAILURE, Date.now() - startTime);

      return {
        status: NodeStatus.FAILURE,
        error: errorMessage,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a single node in the behavior tree
   */
  private async executeNode(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    try {
      let result: NodeResult;

      switch (node.type) {
        // Composite nodes
        case NodeType.SEQUENCE:
          result = await this.executeSequence(node, context);
          break;
        case NodeType.SELECTOR:
          result = await this.executeSelector(node, context);
          break;
        case NodeType.PARALLEL:
          result = await this.executeParallel(node, context);
          break;

        // Decorator nodes
        case NodeType.INVERTER:
          result = await this.executeInverter(node, context);
          break;
        case NodeType.REPEATER:
          result = await this.executeRepeater(node, context);
          break;
        case NodeType.RETRY:
          result = await this.executeRetry(node, context);
          break;
        case NodeType.TIMEOUT:
          result = await this.executeTimeout(node, context);
          break;
        case NodeType.SUCCEEDER:
          result = await this.executeSucceeder(node, context);
          break;
        case NodeType.FAILER:
          result = await this.executeFailer(node, context);
          break;

        // Leaf nodes
        case NodeType.ACTION:
          result = await this.executeAction(node, context);
          break;
        case NodeType.CONDITION:
          result = await this.executeCondition(node, context);
          break;

        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }

      context.nodeResults.set(node.id, result.status);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.nodeResults.set(node.id, NodeStatus.FAILURE);

      return {
        status: NodeStatus.FAILURE,
        error: errorMessage,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute SEQUENCE node - all children must succeed
   */
  private async executeSequence(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      return { status: NodeStatus.SUCCESS, executionTimeMs: 0 };
    }

    for (const child of node.children) {
      const result = await this.executeNode(child, context);

      if (result.status === NodeStatus.FAILURE) {
        return {
          status: NodeStatus.FAILURE,
          error: `Sequence failed at node: ${child.name}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      if (result.status === NodeStatus.RUNNING) {
        return {
          status: NodeStatus.RUNNING,
          executionTimeMs: Date.now() - startTime,
        };
      }
    }

    return {
      status: NodeStatus.SUCCESS,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute SELECTOR node - first child to succeed wins
   */
  private async executeSelector(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      return { status: NodeStatus.FAILURE, executionTimeMs: 0 };
    }

    for (const child of node.children) {
      const result = await this.executeNode(child, context);

      if (result.status === NodeStatus.SUCCESS) {
        return {
          status: NodeStatus.SUCCESS,
          data: result.data,
          executionTimeMs: Date.now() - startTime,
        };
      }

      if (result.status === NodeStatus.RUNNING) {
        return {
          status: NodeStatus.RUNNING,
          executionTimeMs: Date.now() - startTime,
        };
      }
    }

    return {
      status: NodeStatus.FAILURE,
      error: 'All selector children failed',
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute PARALLEL node - run all children concurrently
   */
  private async executeParallel(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      return { status: NodeStatus.SUCCESS, executionTimeMs: 0 };
    }

    const results = await Promise.all(
      node.children.map(child => this.executeNode(child, context)),
    );

    const failureCount = results.filter(r => r.status === NodeStatus.FAILURE).length;
    const runningCount = results.filter(r => r.status === NodeStatus.RUNNING).length;
    const successCount = results.filter(r => r.status === NodeStatus.SUCCESS).length;

    // Default policy: all must succeed
    const successThreshold = node.parameters?.successThreshold as number ?? node.children.length;
    const failureThreshold = node.parameters?.failureThreshold as number ?? 1;

    if (failureCount >= failureThreshold) {
      return {
        status: NodeStatus.FAILURE,
        error: `Parallel node failed: ${failureCount} failures`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    if (successCount >= successThreshold) {
      return {
        status: NodeStatus.SUCCESS,
        data: { successCount, failureCount, runningCount },
        executionTimeMs: Date.now() - startTime,
      };
    }

    if (runningCount > 0) {
      return {
        status: NodeStatus.RUNNING,
        executionTimeMs: Date.now() - startTime,
      };
    }

    return {
      status: NodeStatus.FAILURE,
      error: 'Parallel node did not meet success threshold',
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute INVERTER decorator - inverts child result
   */
  private async executeInverter(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      throw new Error('Inverter node requires exactly one child');
    }

    const result = await this.executeNode(node.children[0]!, context);

    if (result.status === NodeStatus.RUNNING) {
      return result;
    }

    return {
      status: result.status === NodeStatus.SUCCESS ? NodeStatus.FAILURE : NodeStatus.SUCCESS,
      data: result.data,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute REPEATER decorator - repeats child N times
   */
  private async executeRepeater(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      throw new Error('Repeater node requires exactly one child');
    }

    const repeatCount = node.repeatCount ?? 1;
    let lastResult: NodeResult | null = null;

    for (let i = 0; i < repeatCount; i++) {
      lastResult = await this.executeNode(node.children[0]!, context);

      if (lastResult.status === NodeStatus.FAILURE) {
        return {
          status: NodeStatus.FAILURE,
          error: `Repeater failed at iteration ${i + 1}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      if (lastResult.status === NodeStatus.RUNNING) {
        return {
          status: NodeStatus.RUNNING,
          executionTimeMs: Date.now() - startTime,
        };
      }
    }

    return {
      status: NodeStatus.SUCCESS,
      data: { iterations: repeatCount },
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute RETRY decorator - retries child on failure
   */
  private async executeRetry(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      throw new Error('Retry node requires exactly one child');
    }

    const maxRetries = node.maxRetries ?? 3;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.executeNode(node.children[0]!, context);

      if (result.status === NodeStatus.SUCCESS) {
        return {
          status: NodeStatus.SUCCESS,
          data: { attempts: attempt + 1, ...(result.data as object || {}) },
          executionTimeMs: Date.now() - startTime,
        };
      }

      if (result.status === NodeStatus.RUNNING) {
        return {
          status: NodeStatus.RUNNING,
          executionTimeMs: Date.now() - startTime,
        };
      }

      lastError = result.error;

      // Wait before retrying (exponential backoff)
      if (attempt < maxRetries) {
        const delay = Math.min(100 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return {
      status: NodeStatus.FAILURE,
      error: `Retry exhausted after ${maxRetries + 1} attempts: ${lastError}`,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute TIMEOUT decorator - fails if child takes too long
   */
  private async executeTimeout(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.children || node.children.length === 0) {
      throw new Error('Timeout node requires exactly one child');
    }

    const timeoutMs = node.timeoutMs ?? 5000;

    const timeoutPromise = new Promise<NodeResult>(resolve => {
      setTimeout(() => {
        resolve({
          status: NodeStatus.FAILURE,
          error: `Timeout after ${timeoutMs}ms`,
          executionTimeMs: timeoutMs,
        });
      }, timeoutMs);
    });

    const executionPromise = this.executeNode(node.children[0]!, context);

    return Promise.race([executionPromise, timeoutPromise]);
  }

  /**
   * Execute SUCCEEDER decorator - always returns success
   */
  private async executeSucceeder(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (node.children && node.children.length > 0) {
      await this.executeNode(node.children[0]!, context);
    }

    return {
      status: NodeStatus.SUCCESS,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute FAILER decorator - always returns failure
   */
  private async executeFailer(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (node.children && node.children.length > 0) {
      await this.executeNode(node.children[0]!, context);
    }

    return {
      status: NodeStatus.FAILURE,
      error: 'Failer node',
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute ACTION leaf node
   */
  private async executeAction(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.actionId) {
      throw new Error(`Action node ${node.id} missing actionId`);
    }

    const handler = this.actionHandlers.get(node.actionId);
    if (!handler) {
      throw new Error(`Action handler not found: ${node.actionId}`);
    }

    try {
      const result = await handler(context, node.parameters || {});
      return {
        ...result,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: NodeStatus.FAILURE,
        error: `Action ${node.actionId} failed: ${errorMessage}`,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute CONDITION leaf node
   */
  private async executeCondition(
    node: BehaviorNode,
    context: ExecutionContext,
  ): Promise<NodeResult> {
    const startTime = Date.now();

    if (!node.conditionId) {
      throw new Error(`Condition node ${node.id} missing conditionId`);
    }

    const handler = this.conditionHandlers.get(node.conditionId);
    if (!handler) {
      throw new Error(`Condition handler not found: ${node.conditionId}`);
    }

    try {
      const result = await handler(context, node.parameters || {});
      return {
        status: result ? NodeStatus.SUCCESS : NodeStatus.FAILURE,
        data: { conditionResult: result },
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: NodeStatus.FAILURE,
        error: `Condition ${node.conditionId} failed: ${errorMessage}`,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Validate a behavior tree structure
   */
  validateTree(tree: BehaviorTree): void {
    if (!tree.id) {
      throw new Error('Behavior tree must have an id');
    }
    if (!tree.name) {
      throw new Error('Behavior tree must have a name');
    }
    if (!tree.root) {
      throw new Error('Behavior tree must have a root node');
    }

    this.validateNode(tree.root, new Set());
  }

  /**
   * Validate a single node
   */
  private validateNode(node: BehaviorNode, visitedIds: Set<string>): void {
    if (!node.id) {
      throw new Error('Node must have an id');
    }
    if (visitedIds.has(node.id)) {
      throw new Error(`Duplicate node id: ${node.id}`);
    }
    visitedIds.add(node.id);

    if (!node.type) {
      throw new Error(`Node ${node.id} must have a type`);
    }
    if (!node.name) {
      throw new Error(`Node ${node.id} must have a name`);
    }

    // Validate based on node type
    switch (node.type) {
      case NodeType.SEQUENCE:
      case NodeType.SELECTOR:
      case NodeType.PARALLEL:
        if (!node.children || node.children.length === 0) {
          this.logger.warn(`Composite node ${node.id} has no children`);
        }
        break;

      case NodeType.INVERTER:
      case NodeType.REPEATER:
      case NodeType.RETRY:
      case NodeType.TIMEOUT:
      case NodeType.SUCCEEDER:
      case NodeType.FAILER:
        if (!node.children || node.children.length !== 1) {
          throw new Error(`Decorator node ${node.id} must have exactly one child`);
        }
        break;

      case NodeType.ACTION:
        if (!node.actionId) {
          throw new Error(`Action node ${node.id} must have an actionId`);
        }
        break;

      case NodeType.CONDITION:
        if (!node.conditionId) {
          throw new Error(`Condition node ${node.id} must have a conditionId`);
        }
        break;
    }

    // Recursively validate children
    if (node.children) {
      for (const child of node.children) {
        this.validateNode(child, visitedIds);
      }
    }
  }

  /**
   * Update execution statistics
   */
  private updateStats(
    treeId: string,
    status: NodeStatus,
    executionTimeMs: number,
  ): void {
    const stats = this.executionStats.get(treeId);
    if (!stats) return;

    stats.totalExecutions++;
    stats.lastExecutionTime = new Date();

    switch (status) {
      case NodeStatus.SUCCESS:
        stats.successCount++;
        break;
      case NodeStatus.FAILURE:
        stats.failureCount++;
        break;
      case NodeStatus.RUNNING:
        stats.runningCount++;
        break;
    }

    // Update average execution time
    stats.averageExecutionTimeMs =
      (stats.averageExecutionTimeMs * (stats.totalExecutions - 1) + executionTimeMs) /
      stats.totalExecutions;
  }

  /**
   * Get execution statistics for a tree
   */
  getStats(treeId: string): ExecutionStats | undefined {
    return this.executionStats.get(treeId);
  }

  /**
   * Get all execution statistics
   */
  getAllStats(): Map<string, ExecutionStats> {
    return new Map(this.executionStats);
  }

  /**
   * Create a behavior tree from JSON
   */
  createTreeFromJson(json: string | object): BehaviorTree {
    const data = typeof json === 'string' ? JSON.parse(json) : json;

    const tree: BehaviorTree = {
      id: data.id,
      name: data.name,
      description: data.description,
      version: data.version || '1.0.0',
      root: data.root,
      createdAt: new Date(data.createdAt || Date.now()),
      updatedAt: new Date(data.updatedAt || Date.now()),
    };

    this.validateTree(tree);
    return tree;
  }

  /**
   * Export a behavior tree to JSON
   */
  exportTreeToJson(treeId: string): string {
    const tree = this.trees.get(treeId);
    if (!tree) {
      throw new Error(`Behavior tree not found: ${treeId}`);
    }
    return JSON.stringify(tree, null, 2);
  }

  /**
   * Clone a behavior tree with a new ID
   */
  cloneTree(treeId: string, newId: string, newName?: string): BehaviorTree {
    const original = this.trees.get(treeId);
    if (!original) {
      throw new Error(`Behavior tree not found: ${treeId}`);
    }

    const cloned: BehaviorTree = {
      ...JSON.parse(JSON.stringify(original)),
      id: newId,
      name: newName || `${original.name} (Copy)`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Regenerate node IDs
    this.regenerateNodeIds(cloned.root, new Map());

    return cloned;
  }

  /**
   * Regenerate node IDs to avoid conflicts
   */
  private regenerateNodeIds(
    node: BehaviorNode,
    idMap: Map<string, string>,
  ): void {
    const oldId = node.id;
    const newId = `${node.type.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    idMap.set(oldId, newId);
    node.id = newId;

    if (node.children) {
      for (const child of node.children) {
        this.regenerateNodeIds(child, idMap);
      }
    }
  }
}
