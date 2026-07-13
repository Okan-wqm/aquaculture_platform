/**
 * Provider-agnostic LLM abstraction (Faz 1 BYOK).
 *
 * WHY this layer exists: the agent loop must run against the tenant's OWN
 * key and the tenant's CHOSEN provider (Anthropic today, OpenAI next) without
 * the loop knowing which SDK is underneath. Previously AgentRunnerService held
 * a single process-global Anthropic client built from a platform ANTHROPIC_API_KEY
 * — structurally incompatible with per-tenant BYOK. These normalized types are
 * the single contract every provider translates to/from; the loop threads only
 * these, never an SDK-specific shape. Adding a provider = implement LlmProvider,
 * register it in LlmProviderFactory. Nothing in the loop changes (tier-1: the
 * type system makes a provider leak into the loop impossible).
 */

/** Selectable providers. Extend the union AND LlmProviderFactory together. */
export type LlmProviderId = 'anthropic' | 'openai';

/** A tool the model may call — provider-neutral (Anthropic `input_schema`,
 *  OpenAI `parameters` are both projected from `inputSchema`). */
export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmRole = 'user' | 'assistant';

export interface LlmTextBlock {
  type: 'text';
  text: string;
}

export interface LlmToolUseBlock {
  type: 'tool_use';
  /** Provider-issued call id, echoed back in the matching tool_result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

/** Blocks that may appear in a request message (what we SEND). */
export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock;

/** Blocks the model may PRODUCE. tool_result is input-only, so it is excluded. */
export type LlmResultBlock = LlmTextBlock | LlmToolUseBlock;

export interface LlmMessage {
  role: LlmRole;
  content: LlmContentBlock[];
}

export interface LlmChatParams {
  model: string;
  system: string;
  maxTokens: number;
  tools: LlmToolDefinition[];
  messages: LlmMessage[];
}

/** Normalized stop reason. Providers map their own vocabulary onto this. */
export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

/**
 * Per-class token usage. Providers that do not surface prompt-cache classes
 * (e.g. OpenAI) report cacheRead/cacheCreation as 0 — never NaN or omitted, so
 * the cost rollup gets explicit zeros. Mirrors TokenUsageBreakdown minus the
 * derived `total` (the caller sums input + output + cacheCreation — see the
 * TokenUsageBreakdown docblock in agent-runner.service.ts for the budget
 * semantics, ORPHAN-MEDIUM-380).
 */
export interface LlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface LlmChatResult {
  content: LlmResultBlock[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
}

/**
 * A resolved, decrypted per-tenant credential. Constructed only at the call
 * site from the tenant config; NEVER logged, NEVER returned to a client.
 */
export interface LlmCredential {
  provider: LlmProviderId;
  apiKey: string;
}

/**
 * One provider implementation. Stateless w.r.t. tenants — the credential is
 * passed per call, so a single provider instance serves every tenant. Any
 * SDK-client caching (keyed by credential) is the provider's own concern and
 * MUST be keyed by a hash of the key, never hold the plaintext as a map key
 * in a way that survives in a heap dump longer than necessary.
 */
export interface LlmProvider {
  readonly id: LlmProviderId;

  /** Run one model turn. Throws LlmAuthError on a rejected/invalid key so the
   *  caller can surface AI_KEY_MISSING semantics distinctly from a transient
   *  upstream failure. */
  chat(params: LlmChatParams, credential: LlmCredential): Promise<LlmChatResult>;

  /** Cheap liveness/authorization probe used when a tenant saves a key. Returns
   *  true iff the key authenticates. MUST NOT throw on an ordinary auth failure
   *  (returns false); only throws on unexpected transport errors. */
  validateCredential(credential: LlmCredential): Promise<boolean>;
}

/**
 * Thrown when a provider rejects the credential (401/permission). Distinct from
 * a generic upstream error so AgentRunnerService can map it to the
 * AI_KEY_MISSING / invalid-key user contract rather than a 5xx.
 */
export class LlmAuthError extends Error {
  constructor(
    readonly provider: LlmProviderId,
    message: string,
  ) {
    super(message);
    this.name = 'LlmAuthError';
  }
}
