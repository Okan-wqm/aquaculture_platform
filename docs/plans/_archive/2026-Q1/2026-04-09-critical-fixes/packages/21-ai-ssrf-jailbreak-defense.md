# Package 21: ai-ssrf-jailbreak-defense

## Metadata
Status: IMPLEMENTED
Implemented: 2026-04-09
Estimated Tokens: 8K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [MSG-CRITICAL-029, MSG-CRITICAL-030]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two AI integration security defects: (1) the AI chat bridge makes outbound HTTP requests (to LLM APIs, knowledge bases, tool endpoints) without DNS rebinding defense -- an attacker can use DNS rebinding to redirect the AI service to internal endpoints after the initial DNS resolution passes validation; (2) no input filter exists for prompt injection / jailbreak attacks (OWASP LLM Top 10 LLM01:2025), meaning users can manipulate the AI assistant into revealing system prompts, accessing other tenants' data via tool calls, or executing unintended actions.

## Findings
- **MSG-CRITICAL-029**: AI SSRF no DNS rebinding defense
  - File: `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts` (~14.9K chars)
  - Outbound HTTP calls to tool/knowledge endpoints lack IP pinning after DNS resolution
  - Root cause: same SSRF pattern as PLAT-CRITICAL-006 but in AI service context

- **MSG-CRITICAL-030**: No jailbreak input filter (OWASP LLM01:2025)
  - File: `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts`
  - User messages passed directly to LLM without prompt injection detection
  - Root cause: AI integration focused on functionality, not adversarial input handling

## Affected Files
- `/var/aqua-saas/apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts` (~14.9K chars)

## Dependencies
None. However, the SSRF defense pattern should be consistent with Package 16 (webhook SSRF). Executor should reference Package 16's implementation if completed first.

## Atomic Commit Plan
```
security(messaging): add DNS rebinding defense and jailbreak input filter to AI chat bridge

1. ai-chat-bridge.service.ts: add DNS resolution + IP pinning for all
   outbound HTTP requests to tool/knowledge endpoints. Reject private/
   loopback/link-local IP ranges. Same defense as notification-dispatcher.
2. ai-chat-bridge.service.ts: add input sanitization layer before LLM
   call: detect common prompt injection patterns (instruction override,
   system prompt extraction, role confusion), log suspicious inputs,
   reject or sanitize based on risk score. Use OWASP LLM01:2025 patterns.
3. Add tenant isolation assertion: verify tool call responses do not
   contain data from other tenants (tenantId must match in all retrieved
   context documents).

Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-029
Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-030
Plan: docs/plans/2026-04-09-critical-fixes/packages/21-ai-ssrf-jailbreak-defense.md
```

## Test Plan
- Unit test: outbound HTTP to internal IP -- rejected
- Unit test: DNS rebinding attempt (first resolve public, second resolve private) -- rejected
- Unit test: prompt injection patterns detected and logged
- Unit test: system prompt extraction attempt -- blocked
- Unit test: normal user message -- passes through unmodified
- Unit test: tool call response with mismatched tenantId -- rejected

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/ai" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
