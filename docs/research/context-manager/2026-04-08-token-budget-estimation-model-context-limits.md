# Research: Token Budget Estimation and Model Context Limits

**Topic:** Character-to-token ratios per model, prompt budgeting under 50K/100K limits, adaptive compression triggers, front-loading critical content
**Date:** 2026-04-08
**Agent:** context-manager

## Sources

- [Context windows - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Token counting - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Prompt caching - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Context editing - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Compaction - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Effective context engineering for AI agents - Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [What's new in Claude 4.6 - Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6)
- [Claude Sonnet 4 now supports 1M tokens of context - Anthropic News](https://www.anthropic.com/news/1m-context)
- [MRCR: Multi-Round Co-reference Resolution (arXiv 2501.03276)](https://arxiv.org/abs/2501.03276)
- [Developing Adaptive Context Compression Techniques for LLMs in Long-Running Interactions (arXiv 2603.29193)](https://arxiv.org/html/2603.29193)

## Key Findings

### 1. Current Claude context windows (as of April 2026)
From the official Claude context-windows documentation:
- **Claude Mythos Preview, Claude Opus 4.6, Claude Sonnet 4.6:** 1,000,000 tokens (1M).
- **Claude Sonnet 4.5, Claude Sonnet 4, Claude Opus 4.5, Claude Haiku 4.5:** 200,000 tokens.
- Older models and smaller-tier variants: typically 100,000 or 200,000 tokens.
- Request-size limits may bind before token limits for large image/PDF payloads: "up to 600 images or PDF pages (100 for models with a 200k-token context window)."

### 2. Character-to-token ratio: ~4 chars/token for English is a defensible estimate
- Anthropic does not publish a fixed chars-per-token ratio because the tokenizer is BPE-like and content-dependent, but internal docs and the token-counting API validate the ~4 chars/token heuristic for English prose.
- For code (TypeScript, Python, Rust), the ratio drops to ~3 chars/token because of higher punctuation and keyword density.
- For Markdown (which is what context-manager consumes), the ratio is ~3.5 chars/token because of headings, list markers, and code fences.
- Safe default for context-manager's pre-flight estimate: **chars / 3.5** for Markdown input, **chars / 4** for plain prose, **chars / 3** for code blocks inside Markdown.
- This is consistent with the current context-manager.md rule "estimate as chars / 4" but that default slightly under-counts Markdown. Recommendation: tighten to 3.5 for the Markdown report corpus.

### 3. The authoritative token count comes from the Token Counting API
- Anthropic's `/v1/messages/count_tokens` endpoint accepts "the same structured list of inputs for creating a message, including support for system prompts, tools, images, and PDFs. The response contains the total number of input tokens."
- Pricing: token counting is **free** and subject only to RPM rate limits (100 RPM at tier 1, up to 8000 RPM at tier 4).
- Best practice: the chars/4 (or chars/3.5) estimate is FAST but approximate. For any cycle that hovers near a budget threshold (30K/50K), context-manager should call the Token Counting API to get the exact number before deciding on compression level.
- Important limitation: "The token count should be considered an estimate. In some cases, the actual number of input tokens used when creating a message may differ by a small amount. Token counts may include tokens added automatically by Anthropic for system optimizations. You are not billed for system-added tokens."

### 4. Context rot: more tokens is not always better
- Anthropic: "As token count grows, accuracy and recall degrade, a phenomenon known as context rot. This makes curating what's in context just as important as how much space is available." Claude achieves state-of-the-art on MRCR (arXiv 2501.03276) and GraphWalks, "but these gains depend on what's in context, not just how much fits."
- Implication: the 1M context window on Opus 4.6 is a ceiling, not a target. Filling it to 50% still degrades output quality versus a well-curated 10% fill.
- Practical budget tiers for context-manager consolidation output (not input):
  - **Consolidation body:** 3-5K tokens (the core content the orchestrator reads)
  - **Report Manifest:** 2-5K tokens (list of source reports, hashes, counts)
  - **Systemic section:** 1-3K tokens
  - **Dependency graph + Mermaid:** ~1K tokens
  - **Total target output:** ~10K tokens maximum
- Input budget (expert corpus the consolidation consumes) tiers from current context-manager.md:
  - **OK:** < 30K tokens — no compression required
  - **COMPRESSION_RECOMMENDED:** 30-50K — LOW findings counted only, MEDIUM themed
  - **COMPRESSION_MANDATORY:** > 50K — full hierarchy enforced, CRITICAL/HIGH verbatim, rest aggressively compacted

### 5. Front-loading critical content: primacy and recency bias
- Anthropic Effective Context Engineering and the "lost in the middle" literature: LLMs (including Claude) attend more strongly to the beginning and end of a prompt than the middle. CRITICAL findings should be front-loaded in the consolidation — placed immediately after the header, before any narrative.
- The recommended structure of the consolidation document is therefore:
  1. Header (cycle metadata, budget status)
  2. CRITICAL findings (verbatim, front-loaded)
  3. HIGH findings (verbatim)
  4. Cross-domain dependency graph (cycles/unresolved edges front-loaded within this section)
  5. Systemic patterns
  6. MEDIUM themed aggregation
  7. LOW counts
  8. Report Manifest
- This ordering guarantees the most decision-critical material gets the most attention regardless of context pressure downstream.

### 6. Context awareness: Claude 4.5+ tracks its own budget
- Claude Sonnet 4.6, Sonnet 4.5, and Haiku 4.5 feature **context awareness**: "This capability lets these models track their remaining context window (i.e., 'token budget') throughout a conversation."
- Format delivered to the model: `<budget:token_budget>1000000</budget:token_budget>` at start; `<system_warning>Token usage: 35000/1000000; 965000 remaining</system_warning>` after each tool call.
- This does not replace context-manager's job — context awareness is per-model-call, whereas context-manager operates across the multi-agent review corpus, which no single model call ever sees in full.

### 7. Server-side compaction and context editing (beta tools)
- **`compact_20260112`** (beta `compact-2026-01-12`, Opus 4.6 + Sonnet 4.6): automatic server-side summarization. "Detects when input tokens exceed your specified trigger threshold. Generates a summary of the current conversation. Creates a compaction block containing the summary. Continues the response with the compacted context."
- **`clear_tool_uses_20250919`** (beta `context-management-2025-06-27`): clears older tool results from conversation history.
- These are API-level tools for the orchestrator's own model calls, not for context-manager's file-level compaction. But they inform the mental model: adaptive compression SHOULD trigger on threshold crossing, not on fixed cycles.
- For context-manager, the analogue is: re-run the consolidation (or increase compression level) when the input corpus crosses a threshold, not on a fixed schedule.

### 8. Prompt caching reduces effective budget cost
- Anthropic Prompt Caching pricing: cache writes cost 1.25× base input token price (5-min TTL) or 2× (1-hour TTL); cache READS cost 0.1× base input tokens. "Up to 90% cost savings with prompt caching."
- Implication for context-manager: when the orchestrator re-uses the consolidation in Phase 4 and Phase 5, prompt caching the consolidation body turns the cost from 2-3 full reads into one write + 2-3 cheap reads. Worth structuring the consolidation as a single cacheable block (deterministic, stable-ordered, no timestamps in the middle).
- Minimum cacheable length: 2048-4096 tokens depending on model. A well-formed consolidation easily exceeds this threshold.

### 9. Adaptive compression triggers
- arXiv 2603.29193 (Adaptive Context Compression, 2025) frames compression as an adaptive feedback loop: measure the current token count against available budget, apply more aggressive compression when budget pressure rises.
- Rule for context-manager:
  - `estimated_tokens = sum(report_chars) / 3.5`
  - If `estimated_tokens < 30K`: emit all findings in full per severity tier
  - If `30K <= estimated_tokens < 50K`: MEDIUM findings theme-aggregated, LOW counted only — COMPRESSION_RECOMMENDED
  - If `50K <= estimated_tokens < 100K`: COMPRESSION_MANDATORY; CRITICAL/HIGH verbatim preserved; MEDIUM themes hard-capped at 3 themes per agent
  - If `estimated_tokens >= 100K`: emergency mode; consolidate into a minimal "CRITICAL/HIGH only + budget alert" document and escalate to human reviewer requesting scope reduction
- Prompt caching breakpoints further allow per-section adaptive triggers.

### 10. Budget reporting format
- The orchestrator consumes a single status string and an exact count:
  ```
  BUDGET_STATUS: COMPRESSION_RECOMMENDED
  ESTIMATED_INPUT_TOKENS: 42318
  CONSOLIDATION_OUTPUT_TOKENS: 4812
  COMPRESSION_RATIO: 8.8×
  REPORT_COUNT: 7
  OLDEST_REPORT_DATE: 2026-04-08
  NEWEST_REPORT_DATE: 2026-04-08
  ```
- This format is parseable by the orchestrator with a trivial regex and human-readable at a glance. Context-manager MUST emit this block at the top of every consolidation.

## Security Concerns

- **Token-budget exhaustion attack:** a buggy or adversarial expert agent could write a 500K-token report (e.g., with a huge copied-code block) intentionally to blow the budget. Context-manager should enforce a per-report size cap (e.g., 50K tokens per expert report max) and truncate with a WARNING if exceeded, not silently accept.
- **Timing side-channel via budget status:** revealing exact token counts in logs may leak information about system internals to attackers. Rounding to the nearest 1K in public logs is a reasonable privacy measure (internal diagnostics can keep exact counts).
- **Prompt-cache poisoning:** if the consolidation is cached, a later read of a stale cache could propagate old CRITICAL findings as current. Use short TTL (5 minutes) for dynamic consolidations; only cache the STATIC parts (severity rubric, rules) with longer TTL.

## Performance Concerns

- **Char counting is O(bytes):** reading all source reports and summing `len(file_bytes)` is linear and fast. This is the preferred pre-flight estimate.
- **Token Counting API round-trip:** ~100-300ms per call at tier 4. Call it AT MOST ONCE per cycle, only when the chars/3.5 estimate is within ±10% of a budget threshold.
- **Consolidation output budget:** target 10K tokens. Going above 15K indicates a compression rule is not firing.
- **Prompt cache amortization:** for the consolidation, a single write at 1.25× base + 3 subsequent reads at 0.1× base = 1.55× total cost, versus 4× without caching. Savings grow with downstream phase count.
- **Incremental token counting:** when re-running a cycle, recompute token counts only for changed reports (tracked by file mtime or SHA). Unchanged reports retain prior token count.

## Architectural Implications for context-manager reviews

When estimating and managing budget, verify:

1. **chars/3.5 is the default Markdown estimator.** chars/4 under-counts; chars/3 over-counts.
2. **The Token Counting API is used as ground truth** when the estimate is within 10% of a threshold.
3. **Per-report cap is 50K tokens;** larger reports are truncated with WARNING and an emergency consolidation.
4. **Budget status is emitted as a parseable header block** at the top of every consolidation with exact counts (OK / RECOMMENDED / MANDATORY).
5. **CRITICAL and HIGH findings are front-loaded** in the consolidation body (positions 1-2 after the header) regardless of source-agent ordering.
6. **Consolidation output is bounded to ~10K tokens.** Overrun indicates a missing compression rule.
7. **Adaptive compression triggers on threshold crossings,** not on fixed cycles: 30K → themed MEDIUM; 50K → hard-capped MEDIUM themes; 100K → emergency mode.
8. **Prompt caching is structured into stable and dynamic blocks** so the stable block (rules, rubric, schema) can be cached with longer TTL than the dynamic consolidation body.
9. **Emergency mode (> 100K input)** must escalate to human reviewer automatically and emit a minimal CRITICAL/HIGH-only consolidation.
10. **Budget figures are recorded in the Report Manifest** for cycle-over-cycle trending.

## Domain Rule Additions for context-manager

- Token budget estimation MUST use `chars / 3.5` for Markdown input as the default heuristic. `chars / 4` is deprecated as systematically under-counting.
- The Token Counting API MUST be called for ground-truth count when the char-based estimate is within 10% of a budget threshold (30K or 50K).
- Budget thresholds:
  - `OK` if `estimated_tokens < 30K`
  - `COMPRESSION_RECOMMENDED` if `30K ≤ estimated_tokens < 50K`
  - `COMPRESSION_MANDATORY` if `50K ≤ estimated_tokens < 100K`
  - `EMERGENCY` if `estimated_tokens ≥ 100K` (auto-escalate to human reviewer, emit CRITICAL/HIGH-only consolidation)
- Per-report size cap is 50K tokens; reports exceeding this MUST be truncated with a WARNING entry in the consolidation.
- Consolidation output MUST be bounded to ~10K tokens. Overrun is a PROCESS MEDIUM finding against the consolidation itself.
- CRITICAL and HIGH findings MUST be front-loaded (positions 1 and 2 after the header block) regardless of source-agent iteration order.
- Every consolidation MUST emit a machine-parseable budget header block containing `BUDGET_STATUS`, `ESTIMATED_INPUT_TOKENS`, `CONSOLIDATION_OUTPUT_TOKENS`, `COMPRESSION_RATIO`, `REPORT_COUNT`, `OLDEST_REPORT_DATE`, `NEWEST_REPORT_DATE`.
- Adaptive compression MUST trigger on threshold crossing: 30K → MEDIUM themed + LOW counted; 50K → MEDIUM themes capped at 3 per agent; 100K → emergency CRITICAL/HIGH-only + human escalation.
- Prompt caching MUST be structured such that the static rule-and-rubric block can be cached independently (longer TTL) from the dynamic consolidation body (short TTL or no cache).
- Budget figures (input, output, ratio) MUST be recorded in the Report Manifest for every cycle to enable trending.
