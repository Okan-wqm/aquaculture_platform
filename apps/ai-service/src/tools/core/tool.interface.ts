/**
 * Core tool interfaces for the AI Agent Platform.
 * Every tool is a NestJS @Injectable() class implementing ITool.
 */

import type { AiPersonaTier, AiSpecialtyModule } from '@aquaculture/shared-contracts';

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
  /**
   * Persona tiers that may run this tool. This is ONE vocabulary shared by the
   * persona composition (a specialty bundle is filtered to the tiers listed
   * here) and the executor (which refuses a tier not listed) —
   * AISAFETY-MEDIUM-021.
   */
  requiredPermissions: readonly AiPersonaTier[];
  /** JSON Schema for the tool input (sent to Claude) */
  inputSchema: Record<string, unknown>;
  /**
   * Tenant module this tool's data belongs to — `null` for core tools. A
   * module-scoped tool is offered only by a specialty scoped to the same
   * module (RBAC-MEDIUM-016).
   */
  requiresModule: AiSpecialtyModule | null;
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
   * AISAFETY-MEDIUM-021 (hotfix): the persona's TIER (operator|manager|
   * expert|supervisor). Tools declare requiredPermissions in TIER vocabulary,
   * but userRoles carries JWT roles (TENANT_ADMIN|MODULE_USER…) — the two
   * never intersect, so every human-originated tool call was denied. The
   * executor now checks personaTier against requiredPermissions; userRoles
   * remains for the service-principal/serviceGrant path.
   */
  personaTier: AiPersonaTier | null;
  /**
   * RBAC-MEDIUM-016 (execute-time): the tool names this turn OFFERED the
   * model — the resolved profile's effective tools (bundle ∩ registry ∩ tier
   * ∩ module entitlement − tenant block list), or, for a confirmed proposal,
   * exactly the stored tool. The executor refuses any other name, so a model
   * that emits a `tool_use` for a tool it was never given (hallucination,
   * relay leniency, prompt injection through a tool result) cannot reach a
   * module-scoped or tenant-blocked tool: the offer filter is the ONLY place
   * those rules are evaluated, and this is what makes it binding. Service
   * principals authorize through `servicePrincipal.grantedToolNames` instead.
   */
  offeredToolNames: readonly string[];
  /**
   * AISAFETY-MEDIUM-017: the resolved actuation policy (persona ∧ tenant, most
   * restrictive wins). REQUIRED so the executor can never fail open — an
   * actuation tool runs autonomously only under 'allowed'. Populated by the
   * agent runner from the resolved profile; never from Claude.
   */
  actuationPolicy: ActuationPolicy;
  /**
   * SENSOR-MEDIUM-070: a first-class internal SERVICE principal. Set ONLY when a
   * trusted platform service (not a human user) drives the tool call — e.g.
   * sensor-service's channel-detection running the read-only sensor-config
   * tools. When present, the executor authorizes exactly the tools named in
   * `grantedToolNames` WITHOUT consulting user RBAC (no fabricated user roles,
   * the SENSOR-MEDIUM-070 anti-pattern). It grants read-only tools only: the
   * executor refuses any grant for an actuation (`requiresConfirmation`) tool,
   * so a service principal can never actuate. Absent for every human request.
   */
  servicePrincipal?: {
    /** Stable identity of the calling service, e.g. 'sensor-service'. */
    name: string;
    /** Exact allowlist of tool names this principal may run. */
    grantedToolNames: string[];
  };
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
  /**
   * DB-PEOPLE-MEDIUM-003: set when an actuation-class tool executed but its
   * safety-load-bearing audit row could NOT be durably written. The executor
   * surfaces the failure here (instead of swallowing it) so the runner / safety
   * layer can react — the actuation ran, but its audit trail is incomplete.
   */
  auditFailed?: boolean;
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
