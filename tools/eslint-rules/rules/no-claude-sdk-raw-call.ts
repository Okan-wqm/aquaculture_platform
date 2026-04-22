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

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

type MessageIds = 'rawAnthropicImport';
type Options = [];

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/Okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`,
);

/**
 * Package specifiers that identify the raw Anthropic SDK. Both the
 * main SDK and the edge-function variant are covered.
 */
const FORBIDDEN_SPECIFIERS = new Set([
  '@anthropic-ai/sdk',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/vertex-sdk',
]);

/**
 * File-path suffixes where the raw import IS permitted. Matched by
 * string `endsWith` so the rule works with both absolute and relative
 * ESLint filename inputs.
 */
const WRAPPER_PATH_SUFFIXES = [
  'apps/ai-service/src/agent/agent-runner.service.ts',
];

/**
 * Path substrings that indicate a test / mock / type-only context
 * where the rule does NOT apply.
 */
const EXEMPT_CONTEXT_PATTERNS: readonly RegExp[] = [
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.e2e\.ts$/,
  /\/__tests__\//,
  /\/__mocks__\//,
  /\.interface\.ts$/,
  /\.types\.ts$/,
];

function normalisePath(filename: string): string {
  // ESLint on Windows uses backslashes; normalise for suffix / regex match.
  return filename.replace(/\\/g, '/');
}

export default createRule<Options, MessageIds>({
  name: 'no-claude-sdk-raw-call',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Direct `@anthropic-ai/sdk` imports outside the designated wrapper bypass the AI safety pipeline (rate limit, token budget, content guardrails, audit, cost attribution) — ai-safety-auditor CRITICAL class.',
    },
    schema: [],
    messages: {
      rawAnthropicImport:
        'Direct `{{ specifier }}` import bypasses the AI safety pipeline (AgentRunnerService wraps rate-limit + token-budget + guardrails + audit + cost attribution). Inject AgentRunnerService and call `agentRunner.chat({...})` instead. Canonical wrapper: apps/ai-service/src/agent/agent-runner.service.ts. Reference: .claude/agents/ai-safety-auditor.md.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = normalisePath(context.getFilename());

    // Wrapper itself is exempt.
    if (WRAPPER_PATH_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return {};
    // Tests / mocks / type-only.
    if (EXEMPT_CONTEXT_PATTERNS.some((re) => re.test(filename))) return {};

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (node.source.type !== 'Literal') return;
        const specifier = node.source.value;
        if (typeof specifier !== 'string') return;
        if (!FORBIDDEN_SPECIFIERS.has(specifier)) return;

        context.report({
          node: node.source,
          messageId: 'rawAnthropicImport',
          data: { specifier },
        });
      },
    };
  },
});
