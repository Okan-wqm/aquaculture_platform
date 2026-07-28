# Layer-1 AI — Anthropic SDK + API patterns

**Audience:** ai-expert, ai-safety-expert, ai-service domain reviewers, cost-attribution reviewers, any agent reviewing `apps/ai-service/**`, `.claude/skills/**`, or orchestrator-dispatch code.
**Anchor:** `@anthropic-ai/sdk@^0.93.0` (root `package.json`), Claude Sonnet 4.6 + Haiku 4.5 + Opus 4.7 (default model routing per workload), as of 2026-07-27.

Depends on: `layer-1-nestjs.md` (guards, interceptors, CQRS), `layer-2-patterns.md` (outbox, tenant isolation). Applies to: `apps/ai-service/src/agent/`, `apps/ai-service/src/chat/`, `apps/ai-service/src/cost/`, `apps/ai-service/src/safety/`, `apps/ai-service/src/tools/`.

## SDK-only wrapper — never raw HTTP

- **Canonical entrypoint** — `apps/ai-service/src/agent/agent-runner.service.ts`. All Anthropic calls route through the SDK (`Anthropic.messages.create(...)`). Raw `fetch('https://api.anthropic.com/...')` is banned by the ESLint rule `tools/eslint-rules/rules/no-claude-sdk-raw-call.ts` (W7 deliverable).
- **Why the wrapper** — retry + backoff + rate-limit header parsing + tool-use loop + cost accounting live in ONE place. Raw HTTP calls bypass all of this. Treat a bare `fetch` as CRITICAL.
- **Model selection** — pass `model` explicitly from `profile.persona.model`; never hard-code `'claude-sonnet-4-6'`. Tenant persona config drives model choice (Opus for complex reasoning, Sonnet for default, Haiku for classification).

## Prompt caching (cost kill-switch)

- **`cache_control: { type: 'ephemeral' }`** on system prompt blocks > ~1000 tokens. First call pays full price; subsequent calls within 5 min pay 10% (write) / 0.1x (read).
- **Cache breakpoints** — up to 4 per request. Placement matters: cache the stable prefix (system prompt + long tool definitions), vary the tail (user message). Inverting the order defeats the cache.
- **Persona system prompts** — `profile.persona.systemPrompt` is the primary cache target. Tenant-specific persona strings >1k tokens MUST be cached; without caching an ai-service ingesting sensor summaries burns $$$ on duplicate prefix tokens.
- **Cache-hit verification** — `response.usage.cache_read_input_tokens` + `cache_creation_input_tokens`. Cost attribution (`apps/ai-service/src/cost/`) MUST log both; under-reporting cache hits in tenant bills is a finance correctness bug.

## Tool use (function calling)

- **Canonical loop** — single `messages.create` returns `content: [{ type: 'tool_use', id, name, input }, ...]`. Execute each tool, append results as `{ type: 'tool_result', tool_use_id: id, content: ... }`, call `messages.create` again. Repeat until the assistant returns a `text`-only response.
- **Tool-use ID discipline** — every `tool_use.id` MUST appear in exactly one `tool_result.tool_use_id` on the next turn. Missing one crashes the API with 400. See `apps/ai-service/src/agent/agent-runner.service.ts` — the loop tracks pending tool_use blocks and asserts 1:1 pairing before the next round-trip.
- **Tool definitions** — shaped per Anthropic's `Tool` interface. Field `input_schema` is JSON Schema Draft 7; the same schemas validate tenant-declared tools at registration (`apps/ai-service/src/tools/`). Invalid schemas rejected at startup, not runtime.
- **Parallel tool use** — the SDK surfaces this as multiple `tool_use` blocks in a single assistant turn. Execute in parallel (`Promise.all`) to avoid linear-chain latency; our agent runner already does this.

## Streaming + backpressure

- **`messages.stream(...)`** — returns an async iterator of SSE events. Use for user-facing chat where first-byte latency matters (<200ms to first token).
- **Backpressure** — if the downstream (WebSocket to client) slows, the SDK iterator will buffer. For multi-minute streams this is an OOM vector. Pattern: wrap the iterator in a bounded async queue (default 64 events); when full, drop _interim_ events (usage updates), never the `text_delta` blocks.
- **Abort handling** — `AbortSignal` is the correct cancellation primitive (do NOT rely on socket close alone). Downstream disconnect must abort the SDK call so Anthropic stops billing tokens. `apps/ai-service/src/chat/` must pass the request-scoped AbortController into every `stream()` call.
- **Fan-out** — one user request → one Anthropic stream. Do NOT fan out a single stream to multiple consumers; each consumer needs its own call. Sharing a stream corrupts the tool-use loop state.

## Context-window budgeting

- **Default context** — Sonnet 4.6 / Opus 4.7 = 200k; Haiku 4.5 = 200k; `claude-opus-4-7[1m]` variant = 1M (at ~2x cost). Match model to actual context need; do NOT default to 1M because bigger is safer — it is strictly more expensive per cache miss.
- **Token counting** — use `messages.countTokens(...)` for pre-call budgeting, not `encoding_for_model`-style client libs. The SDK call returns the authoritative count.
- **Conversation trim strategy** — prefer tool-result summarization over raw turn truncation. A system-prompt "summarize prior tool calls older than N turns" pattern preserves the reasoning trace better than dropping history. `apps/ai-service/src/conversation/` owns this.
- **System prompt cap** — keep below 8k tokens even when cached. Longer prompts hit diminishing cache wins (5-min TTL vs cache-write cost) and dilute model attention.

## Rate limits + backpressure (client side)

- **`429` response** — parse `anthropic-ratelimit-*-reset` + `retry-after` headers, sleep until reset, retry with jitter. The SDK's built-in retry handles simple 429s; deep tool-use loops must bubble the rate limit up to the orchestrator for global fairness (W12 — K8s agent-pool backpressure).
- **Per-tenant quotas** — enforced at the wrapper layer via Redis token bucket keyed `ai:quota:<tenantId>:<model>`. Fail _closed_ on Redis outage — never silently ignore quota (MT-CRITICAL-002 regression pattern). Tenant upgrade path: quota bump is a billing-service event, not an ai-service config change.
- **Cost caps** — `profile.persona.dailyBudgetUSD` evaluated pre-call. When breached, return a soft-fail message ("daily AI budget reached"), NOT an exception. Exceptions propagate to the UI as "error"; cost cap is a business-level refusal and must render as such.

## Safety + content filtering

- **Guardrails** — `apps/ai-service/src/safety/` pre-filters user input (PII, prompt-injection patterns, known-jailbreak strings) + post-filters assistant output (hallucinated tool calls, policy violations).
- **Audit trail** — every Anthropic round-trip persists `{tenantId, personaId, model, input_tokens, output_tokens, cache_hit, cost_usd, flagged_categories}` to `ai.conversation_turns`. Audit rows are immutable (no UPDATE); corrections issue a new row with `corrects_turn_id`.
- **Hallucinated tool calls** — the assistant occasionally invents a tool name not in the declared list. The runner MUST reject the turn with an error `tool_result`, not forward to a tool handler. Silent execution of invented tools is a CRITICAL bug class.

## Claude Code sub-agent orchestration

- **No Agent SDK runtime dependency** — `apps/ai-service` uses `@anthropic-ai/sdk` for user-facing Messages API calls. The repository does not import `@anthropic-ai/claude-agent-sdk`, so that package must not be present in the production dependency graph.
- **Review-loop dispatch is Claude Code's built-in `Agent()` tool** (auto-discovery of `.claude/agents/**/*.md`). No external CLI binary, no `npx claude-agent`, no `tools/scripts/orchestrator-runner.ts` — all of that was retired on 2026-04-18 (commit `e8f06e98`). Sub-agent invocation format: `Agent(subagent_type="<name>", description="...", prompt="...")`.
- **Sub-agent isolation** — sub-agents run in their own context. Parent must pass findings in + pull results back via explicit message-passing, not shared state. The finding-registry (`docs/reviews/_registry/findings.jsonl`) is the SSoT for cross-agent state; never mutate another agent's in-flight context.
- **System prompt assembly** — sub-agent system prompts compose from the agent file header + `@`-referenced shared fragments (`.claude/shared/**`) + knowledge layers (this folder). Claude Code owns that assembly; agent files never inline SSoT content (W3 invariant).

## Gotchas

- **Model deprecation** — Anthropic deprecates models; always pin the exact ID (`claude-sonnet-4-6`) in tenant persona config, never just `"sonnet"`. Mass migration paths live in `apps/ai-service/src/tenant-config/` + a runbook in `docs/runbooks/` (not yet written — Phase 14 item).
- **Token drift between models** — a prompt that fits 190k on Sonnet can fail on Haiku (slightly different tokenizer). Always count tokens AGAINST the target model, not a default.
- **`anthropic-beta` header** — reserved for opt-in features (prompt caching was beta-gated until GA). Current GA features do NOT need this header; adding it unnecessarily pins you to a beta contract that can disappear.
- **SDK version anchor** — `@anthropic-ai/sdk` is the ai-service runtime client. The review-loop uses Claude Code's built-in `Agent()` tool; it does not add a second runtime SDK. `knowledge-ssot.spec.ts` pins this distinction to the dependency manifest.

## References

- `apps/ai-service/src/agent/agent-runner.service.ts` — canonical tool-use loop + model selection
- `apps/ai-service/src/safety/` — guardrails layer
- `apps/ai-service/src/cost/` — per-call cost attribution
- `tools/eslint-rules/rules/no-claude-sdk-raw-call.ts` — SDK-only enforcement rule
- Anthropic docs — prompt caching, tool use, streaming (user verifies these at request time; do not cite URLs from memory)
- ADR-006 (event flat), ADR-007 (CQRS)
