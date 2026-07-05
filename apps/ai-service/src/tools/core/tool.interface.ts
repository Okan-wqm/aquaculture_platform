/**
 * Core tool interfaces for the AI Agent Platform.
 * Every tool is a NestJS @Injectable() class implementing ITool.
 */

/** Tool category for grouping and filtering */
export type ToolCategory =
  | 'water_chemistry'
  | 'growth_analytics'
  | 'feed_management'
  | 'risk_assessment'
  | 'sensor_query'
  | 'farm_query'
  | 'actuation'
  | 'reporting';

/** Where the tool can execute */
export type ToolRuntime = 'cloud' | 'edge' | 'both';

/** Tool metadata - sent to Claude as tool definition */
export interface ToolMetadata {
  /** Snake_case tool name (e.g., 'calculate_ammonia_toxicity') */
  name: string;
  /** Description sent to Claude (should explain what the tool does, inputs, outputs) */
  description: string;
  /** Tool category for filtering */
  category: ToolCategory;
  /** Where this tool can execute */
  runtime: ToolRuntime;
  /** Required user roles to use this tool (e.g., ['operator', 'manager', 'expert']) */
  requiredPermissions: string[];
  /** JSON Schema for the tool input (sent to Claude) */
  inputSchema: Record<string, unknown>;
  /** Billing module required (e.g., 'ai_basic', 'ai_pro') - null for free tools */
  requiresModule: string | null;
  /** Whether this tool requires human confirmation before execution (actuation safety) */
  requiresConfirmation: boolean;
}

/** The tenant/persona actuation policy resolved for this run. */
export type ActuationPolicy = 'blocked' | 'confirm_required' | 'allowed';

/** Context passed to every tool execution - populated from JWT, never from Claude */
export interface ToolExecutionContext {
  tenantId: string;
  schemaName: string;
  userId: string;
  userRoles: string[];
  /** Correlation ID for distributed tracing */
  correlationId: string;
  /** The agent persona executing this tool */
  persona: string;
  /**
   * AISAFETY-MEDIUM-017: the resolved actuation policy (persona ∧ tenant, most
   * restrictive wins). REQUIRED so the executor can never fail open — an
   * actuation tool runs autonomously only under 'allowed'. Populated by the
   * agent runner from the resolved profile; never from Claude.
   */
  actuationPolicy: ActuationPolicy;
}

/** Result wrapper for tool execution */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Whether this result should be cached */
  cacheable: boolean;
  /** Cache TTL in seconds (if cacheable) */
  cacheTtlSeconds?: number;
  /**
   * AISAFETY-MEDIUM-017: set when an actuation tool was NOT executed because it
   * needs human confirmation (the tool did not run). Lets the runner/UI render
   * a confirmation prompt rather than treat it as a plain failure. The full
   * propose→confirm→execute round-trip is Faz 6; this flag is its seam.
   */
  requiresConfirmation?: boolean;
}

/** Core tool interface - every tool must implement this */
export interface ITool<TInput = unknown, TOutput = unknown> {
  /** Get tool metadata for registry and Claude */
  getMetadata(): ToolMetadata;
  /** Validate input before execution */
  validate(input: TInput): Promise<{ valid: boolean; errors?: string[] }>;
  /** Execute the tool */
  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

// WHY no TOOL_PROVIDERS token here anymore (FAZ0-BOOT-01): the previous
// `Symbol('TOOL_PROVIDERS')` design assumed Angular-style `multi: true`
// providers, which NestJS does not have — every module-level
// `{ provide: TOOL_PROVIDERS, useExisting: X }` silently LOST to the
// registry module's own `useValue: []`, so the registry always booted with
// ZERO tools. Discovery is now automatic: any @Injectable() provider
// decorated with @Tool() is found via DiscoveryService at startup
// (see ToolRegistryService). Registering a new tool = declare the class as
// a provider in any module + decorate it. Nothing else.
