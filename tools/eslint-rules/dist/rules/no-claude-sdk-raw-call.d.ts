/**
 * no-claude-sdk-raw-call — enforces ai-safety-auditor's "Anthropic SDK
 * through the designated wrapper only" invariant.
 *
 * Direct `@anthropic-ai/sdk` use bypasses the AI service's safety
 * pipeline: rate limiting (RateLimitService), monthly token budget
 * (TokenBudgetService), content / PII guardrails (AiSafetyMiddleware),
 * conversation persistence + audit (ConversationService), tenant-scoped
 * tool gating (AgentProfileService + ToolExecutorService), and the
 * cost-attribution stream fed into tenant billing. Calling
 * `new Anthropic(...).messages.create(...)` directly from a handler or
 * module means every one of those layers is silently skipped — the
 * ai-safety-auditor invariant classifies this as CRITICAL.
 *
 * Rule mechanics (import-level, not call-site):
 *   - Forbid `import ... from '@anthropic-ai/sdk'` in any file except
 *     the single designated wrapper path
 *     (apps/ai-service/src/agent/agent-runner.service.ts) plus its
 *     immediate type-only companions.
 *   - Import-based enforcement is stronger than call-site: it catches
 *     `new Anthropic(...)`, `Anthropic.Client`, stream APIs, tool-use
 *     helpers, and every other shape of direct SDK use in one rule.
 *
 * Exemption list (case-sensitive on resolved path; the glob in
 * .eslintrc.json is the outer fence, this in-rule check is belt-and-
 * suspenders for when someone refactors the glob):
 *
 *   - apps/ai-service/src/agent/agent-runner.service.ts  — canonical
 *     wrapper, calls the SDK behind the full safety stack.
 *   - apps/ai-service/src/**\/*.interface.ts              — type-only
 *     imports (Anthropic.Messages.MessageParam etc) don't hit runtime.
 *   - Test files                                         — mocks stub
 *     the SDK surface.
 *
 * When you need AI in a new place:
 *   1. Inject AgentRunnerService.
 *   2. Call `agentRunner.chat({ message, persona, tenantId, userId, ... })`.
 *   3. Do NOT add a second `new Anthropic()`.
 *
 * Progressive rollout: severity "warn" initially; promotes to "error"
 * once the Claude Code SDK sister rule for `@anthropic-ai/claude-code`
 * SDK lands (sibling Phase 2 deliverable).
 *
 * Refs:
 *  - docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2
 *  - .claude/agents/ai-safety-auditor.md (Anthropic
 *    SDK wrapper requirement)
 *  - apps/ai-service/src/agent/agent-runner.service.ts (canonical wrapper)
 */
import { ESLintUtils } from '@typescript-eslint/utils';
declare const _default: ESLintUtils.RuleModule<"rawAnthropicImport", [], ESLintUtils.RuleListener>;
export default _default;
//# sourceMappingURL=no-claude-sdk-raw-call.d.ts.map