# Package 24: messaging-ai-safety-injection

## Metadata
Status: PENDING
Estimated Tokens: 28K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [MSG-HIGH-031, MSG-HIGH-032, MSG-HIGH-033, MSG-HIGH-034, MSG-HIGH-035, MSG-HIGH-036]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Messaging AI integration HIGHs: (1) no instruction hierarchy (system/user/assistant role separation), (2) no output PII filter on AI responses, (3) no JSON schema validation on AI tool calls, (4) tool audit trail broken (tool invocations not logged), (5) consent mechanism does not sweep existing embeddings on opt-out, (6) custom system prompt allows injection of arbitrary instructions.

## Findings

**MSG-HIGH-031** (messaging-expert, HIGH)
AI chat integration has no instruction hierarchy. User messages and system instructions are concatenated without role separation. Prompt injection via user message can override system instructions.

**MSG-HIGH-032** (messaging-expert, HIGH)
No output PII filter on AI-generated responses. AI can echo back PII from context (employee names, national IDs, salaries) that the requesting user should not see based on their RBAC role.

**MSG-HIGH-033** (messaging-expert, HIGH)
No JSON schema validation on AI tool call arguments. Malformed tool call responses from LLM can cause runtime errors or inject unexpected data into downstream operations.

**MSG-HIGH-034** (messaging-expert, HIGH)
Tool invocations are not logged to audit trail. AI-initiated actions (data queries, calculations) have no record of what the AI was asked, what tool it called, and what result it returned.

**MSG-HIGH-035** (messaging-expert, HIGH)
Consent opt-out does not sweep existing embeddings. User revokes AI data consent but previously generated embeddings containing their messages remain in vector store.

**MSG-HIGH-036** (messaging-expert, HIGH)
Custom system prompt field allows injection of arbitrary instructions. A tenant admin can set a system prompt that overrides safety guardrails, instructs the AI to ignore RBAC, or exfiltrates data through crafted response formatting.

## Affected Files
- apps/messaging-service/src/ai/ (chat integration, tool calls, embeddings)
- apps/ai-service/src/ (if AI service is separate)

## Dependencies
None.

## Atomic Commit Plan
```
security(messaging): add AI instruction hierarchy, PII filter, tool validation, prompt injection guard

AI chat has no instruction hierarchy (prompt injection risk). No output PII
filter. No tool call JSON schema validation. Tool invocations unaudited.
Consent opt-out does not delete existing embeddings. Custom system prompt
allows safety guardrail override.

Implement instruction hierarchy with distinct system/user/assistant roles and
role-based input sanitization. Add regex-based PII filter on AI output. Add
JSON schema validation on tool call arguments. Log all tool invocations to
audit trail. Add embedding sweep on consent revocation. Validate custom system
prompts against safety guardrail allowlist.

Plan: docs/plans/2026-04-09-high-fixes/packages/24-messaging-ai-safety-injection.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-031
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-032
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-033
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-034
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-035
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-036
```

## Test Plan
- Unit test: user message cannot override system instruction role
- Unit test: AI response containing national ID is redacted
- Unit test: malformed tool call JSON is rejected
- Unit test: tool invocation creates audit log entry
- Unit test: consent revocation triggers embedding deletion
- Unit test: custom system prompt with "ignore all previous instructions" is rejected

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/ai" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
