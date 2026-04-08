# Research: Multi-Agent Context Engineering Patterns

**Topic:** Context assembly patterns, message passing between agents, shared vs isolated context, context handoff protocols, token budget management across agent boundaries
**Date:** 2026-04-08
**Agent:** context-manager

## Sources

- [How we built our multi-agent research system - Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Effective context engineering for AI agents - Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Create custom subagents - Claude Code Docs](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Building Effective AI Agents - Anthropic Resources PDF](https://resources.anthropic.com/hubfs/Building%20Effective%20AI%20Agents-%20Architecture%20Patterns%20and%20Implementation%20Frameworks.pdf)
- [Context windows - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Simon Willison on sub-agents](https://simonwillison.net/tags/sub-agents/)
- [Simon Willison on context-engineering](https://simonwillison.net/tags/context-engineering/)
- [LLM-powered autonomous agents - ThoughtWorks Technology Radar](https://www.thoughtworks.com/en-us/radar/techniques/llm-powered-autonomous-agents)
- [Model Context Protocol and A2A Protocol - ThoughtWorks Technology Radar Vol 33 (Nov 2025)](https://www.thoughtworks.com/content/dam/thoughtworks/documents/radar/2025/11/tr_technology_radar_vol_33_en.pdf)

## Key Findings

### 1. Orchestrator-worker topology is the canonical pattern
- Anthropic's Research product uses a lead-agent coordination pattern: the primary agent "analyzes it, develops a strategy, and spawns subagents to explore different aspects simultaneously." The subagents function as "intelligent filters by iteratively using search tools to gather information" before returning findings to consolidate results. This is exactly the shape used by aqua-saas: orchestrator-agent dispatches expert reviewers (farm-expert, messaging-expert, etc.), collects their reports, and hands the corpus to context-manager for meta-synthesis.
- Simon Willison distinguishes between "workflows" (multiple LLMs orchestrated with pre-defined patterns) and true "agents" (LLMs that dynamically direct their own processes and tool usage). The aqua-saas multi-agent review is a workflow: orchestrator phases are pre-defined, so determinism and auditability can be expected and enforced.
- ThoughtWorks Technology Radar Vol 33 (Nov 2025) observed that context engineering has proven critical to optimizing both behavior and resource consumption in agentic workflows, and promoted context engineering as a first-class discipline distinct from prompt engineering.

### 2. Context isolation ("context quarantine") is the load-bearing pattern
- Anthropic explicitly states: "Subagents enable parallelization by spinning up multiple subagents to work on different tasks simultaneously, and they help manage context by using their own isolated context windows, with only relevant information sent back to the orchestrator rather than their full context."
- Simon Willison names the pattern "context quarantine": isolating contexts in their own dedicated threads. Claude Code itself uses this pattern — each subagent has its own system prompt, tool allowlist, and independent context window.
- Implication for context-manager: expert agents' raw tool outputs, code listings, and intermediate reasoning MUST NOT leak into the meta-review corpus. Only their finalized report files (`docs/reviews/{agent}/*.md`) are read. Context-manager must never attempt to re-run tool calls the experts already made — that would collapse isolation and blow the budget.

### 3. Subagent summaries, not full transcripts
- Anthropic: "each subagent returns condensed summaries (1,000-2,000 tokens) of extensive exploration. Main agent synthesizes results; detailed search context stays isolated."
- This is the contractual interface: a subagent produces a compact, structured report; the orchestrator (or context-manager) consumes only the report. If a subagent's report is missing a CRITICAL finding that was in its scratchpad, that is a subagent bug, not a context-manager responsibility — context-manager must only trust published reports.
- For aqua-saas specifically, every expert agent writes to `docs/reviews/{agent}/{YYYY-MM-DD}-*.md`. Context-manager's input boundary is exactly this set of files — nothing else.

### 4. Multi-agent systems consume 4-15x more tokens than single-turn chats
- Anthropic reports: "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats" and "token usage by itself explains 80% of the variance" in their evaluation suite. This validates distributed architecture on quality grounds but makes the context-manager's compaction function economically critical.
- For an aquaculture review with 8 experts each producing a 5-10K token report, the raw corpus is 40-80K tokens. Without compaction, Phase 4 (Cross-Domain Resolution) and Phase 5 (Unified Report) re-ingest the full corpus repeatedly, causing the orchestrator's own context window to bloat and degrade (context rot).

### 5. External memory for state preservation across context boundaries
- Anthropic's LeadResearcher "saves its plan to Memory to persist the context, since if the context window exceeds 200,000 tokens it will be truncated." When approaching limits, fresh subagents receive "clean contexts while maintaining continuity through careful handoffs," and agents "retrieve stored context like the research plan from their memory rather than losing previous work."
- For aqua-saas, the equivalent of "Memory" is `.full-review/state.json` + the `docs/reviews/` / `docs/recommendations/` / `docs/research/` files on disk. These ARE the external memory substrate — they survive context resets and are authoritative across phases.
- Context-manager must treat these files as the source of truth. Anything that isn't written down is gone after context rollover.

### 6. Parallelism: lead agent spawns N subagents, subagents each use M parallel tools
- Anthropic reported a 90% cut in research time from: "(1) the lead agent spins up 3-5 subagents in parallel rather than serially; (2) the subagents use 3+ tools in parallel."
- For aqua-saas: when orchestrator Phase 3 dispatches 8 experts in parallel, each runs independently. Context-manager is invoked in Phase 3.5 AFTER all experts complete; it is NOT parallel with experts. It processes their outputs.
- The synchronous orchestrator-first-then-consolidator pattern simplifies coordination but creates a bottleneck: context-manager cannot start until all experts finish. This is an accepted trade — synchronous correctness over asynchronous throughput, since multi-agent review correctness is more important than wall-clock latency.

### 7. Context handoff protocol: structured, not free-form
- Anthropic's Effective Context Engineering guide prescribes: "Organize into distinct sections using XML tags or Markdown headers (`<background_information>`, `<instructions>`, etc.)" and "Curate diverse, canonical examples rather than exhaustive edge-case lists."
- For aqua-saas: expert reports follow a rigid section layout (Summary, Findings by Severity, Cross-Domain Dependencies, Remediation). Context-manager depends on this structure to parse and compact without a language-model pass — it must be able to extract CRITICAL blocks by a deterministic heading match. Free-form prose in expert reports is a CRITICAL process defect that context-manager must flag.

### 8. Just-in-time context retrieval beats pre-loading
- Anthropic: "Maintain lightweight identifiers (file paths, queries, links) instead of pre-loading all data. Use tools to dynamically load context at runtime." For context-manager, this means the consolidation report references expert reports by PATH (e.g., `docs/reviews/farm-expert/2026-04-08-batch-lifecycle.md#critical-3`) rather than copying their entire body in.
- The orchestrator and human reviewer can follow the path when they need detail; the consolidation carries only the load-bearing text (CRITICAL/HIGH findings verbatim) plus references.

### 9. Tool result clearing and compaction are distinct strategies
- Anthropic's Context Editing API distinguishes `clear_tool_uses_20250919` (remove old tool outputs from the conversation history) from `compact_20260112` (summarize old messages into a compaction block).
- For context-manager's behavioral analogue: compaction = produce a condensed consolidation report replacing expert reports in downstream phases; tool-result-clearing = after Phase 5 unified report is published, expert reports can be referenced but should no longer be fully re-ingested.
- `compact_20260112` beta header works by: "Detects when input tokens exceed your specified trigger threshold. Generates a summary of the current conversation. Creates a compaction block containing the summary. Continues the response with the compacted context." This is the mental model context-manager emulates at the agent-report layer, not the API layer.

### 10. Model Context Protocol (MCP) vs Agent2Agent (A2A) distinction
- MCP is an open standard defining how LLM applications and agents integrate with external data sources and tools (context + tool access).
- A2A is a protocol governing inter-agent communication (handoffs, capability discovery, result exchange).
- aqua-saas does not currently implement A2A formally — it uses a file-system handoff (expert reports on disk). This is a valid low-tech A2A substitute as long as the file layout is stable and the schema is enforced (see 7 above).

## Security Concerns

- **Report tampering between phases:** because handoff is file-based, any process with write access to `docs/reviews/` can inject or modify a finding. In production, consider signing report files (git commit SHA + optional HMAC) so context-manager can detect tampering. At minimum, context-manager should record the git SHA of every report it consolidated, so a reviewer can bisect later.
- **PII leakage through unfiltered report fields:** expert agents may inline file excerpts containing user data (names, emails, phones). Context-manager must not propagate unmasked PII into the consolidation report. A regex sweep for `@domain.com` and phone-shaped strings, plus hashing, is a reasonable minimum.
- **Cross-tenant leakage via shared review corpus:** in a platform that reviews multi-tenant code, a finding in tenant A's module may accidentally reference tenant B's data in an example. Context-manager must flag and redact these.
- **Credential echo from source excerpts:** expert reports sometimes paste configuration blocks. If an expert accidentally quoted a real secret (against policy), context-manager's compaction would republish it. Scan incoming report files for secret-shaped tokens and redact before consolidation.

## Performance Concerns

- **15x token multiplier:** confirmed by Anthropic's own measurements. A single review cycle of 8 experts at ~8K tokens each = 64K raw, which is already above the 50K COMPRESSION_MANDATORY threshold currently in context-manager.md. Compaction must become routine, not exceptional.
- **Synchronous bottleneck:** all experts must finish before context-manager runs. If one expert stalls, the whole Phase 3.5 stalls. The orchestrator should enforce a per-expert timeout and treat missing reports as explicit "not run" entries rather than blocking indefinitely.
- **Repeated re-reads of the same report:** if context-manager runs multiple times in a cycle (e.g., once after Phase 3 and once after Phase 4 changes), it should cache parsed findings by report SHA to avoid re-parsing.
- **Context rot at the orchestrator:** if context-manager returns too much, the orchestrator's own context degrades. Target 3-5K tokens for the consolidated output, not 20K.

## Architectural Implications for context-manager reviews

When synthesizing the multi-agent review corpus, verify:

1. **All expert reports parse against the expected schema.** Any report missing the Findings-by-Severity section is a process failure that must be flagged before compaction begins.
2. **No expert-to-expert messaging exists outside the orchestrator.** Direct agent handoffs that bypass the orchestrator are banned — all cross-domain signals flow through `Cross-Domain Dependencies` sections in reports.
3. **Report file paths are quoted in the consolidation, not copy-pasted bodies.** CRITICAL and HIGH findings are the only exception (quoted verbatim with attribution).
4. **Context budget is reported every cycle,** not only when over threshold — trending data matters for capacity planning.
5. **Historical consolidations in `docs/reviews/context-manager/` are scanned every cycle** for systemic patterns; trailing 30 days is the window.
6. **Raw expert scratchpads, tool outputs, and research files are never ingested;** only finalized report files.
7. **PII, secrets, and cross-tenant references are redacted** at the compaction boundary.
8. **`.full-review/state.json` is read-only** to context-manager — state belongs to the orchestrator.

## Domain Rule Additions for context-manager

- Expert reports MUST follow the structured-section layout (Summary / Severity Buckets / Cross-Domain Dependencies / Remediation). A report that fails schema parsing is a PROCESS CRITICAL finding.
- The context-manager consolidation MUST reference expert reports by path (with anchor where possible), NOT by copied-out prose, except for CRITICAL/HIGH findings which are quoted verbatim with source attribution.
- External memory (disk files under `docs/reviews/`, `docs/recommendations/`, `docs/research/`, `.full-review/state.json`) is the authoritative handoff substrate. Context-manager MUST NOT invent findings that do not trace to a file path.
- Every consolidation MUST include a "Report Manifest" section listing every expert report file consumed by absolute path, SHA where available, and severity count breakdown per agent.
- Context-manager MUST record and surface the total token budget (char/4 estimate) for the cycle, categorized as OK / RECOMMENDED / MANDATORY per the existing thresholds.
- Subagent outputs must be treated as opaque — context-manager never re-executes an expert's tools; trust the report or flag the report missing.
