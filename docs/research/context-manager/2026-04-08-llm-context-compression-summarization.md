# Research: LLM Context Compression and Summarization

**Topic:** Hierarchical summarization, key-finding extraction, lossy vs lossless compression, what to preserve (CRITICAL/HIGH findings), what to aggregate (MEDIUM/LOW), reference-preservation when compacting
**Date:** 2026-04-08
**Agent:** context-manager

## Sources

- [Effective context engineering for AI agents - Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Compaction - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Context editing - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Understanding and Improving Information Preservation in Prompt Compression for LLMs (arXiv 2503.19114, 2025)](https://arxiv.org/html/2503.19114)
- [NEXUSSUM: Hierarchical LLM Agents for Long-Form Summarization (ACL 2025)](https://aclanthology.org/2025.acl-long.500.pdf)
- [ACON: Optimizing Context Compression for Long-Horizon LLM Agents (arXiv 2510.00615, 2025)](https://arxiv.org/pdf/2510.00615)
- [On Context Utilization in Summarization with Large Language Models (arXiv 2310.10570v3)](https://arxiv.org/html/2310.10570v3)
- [Simon Willison on context-engineering — context pruning, summarization, offloading](https://simonwillison.net/tags/context-engineering/)
- [How we built our multi-agent research system - Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)

## Key Findings

### 1. Lossy compression with preservation rules beats uniform summarization
- Anthropic's Effective Context Engineering guide: "Preserve architectural decisions and unresolved issues; discard redundant tool outputs. Start by maximizing recall, then improve precision by eliminating superfluous content." This is the exact preservation strategy context-manager needs: CRITICAL/HIGH findings are "architectural decisions" that MUST be preserved verbatim; MEDIUM/LOW findings are "redundant tool outputs" that can be themed and aggregated.
- The research literature (arXiv 2503.19114) shows entity preservation is the single strongest predictor of post-compression usefulness: compression methods that explicitly track and retain named entities (file paths, function names, error messages) outperform uniform token-level compression by 2.7× on entity recall.

### 2. Hierarchical summarization: three-tier memory regions
- From arXiv 2510.00615 (ACON) and ACL 2025 (NEXUSSUM): hierarchical approaches divide ranked context into memory regions where highly important turns remain unchanged in short-term memory, medium-importance segments are summarized to reduce token usage, and low-importance turns are removed when they exceed budget constraints.
- For context-manager this translates directly:
  - **Tier 1 (verbatim):** CRITICAL + HIGH findings. Zero rewriting allowed. Source attribution, file path, line number, remediation text all preserved letter-for-letter.
  - **Tier 2 (themed aggregation):** MEDIUM findings. Grouped by theme with a count and a single representative example. Pointer to source report for the rest.
  - **Tier 3 (count only):** LOW findings. Counted per source agent. Never individually enumerated.
- This matches the existing context-manager.md Report Compaction rules and is validated by both Anthropic production practice and peer-reviewed literature.

### 3. Structured summary formats: what to preserve
- Best practice (agenta.ai, Mem0 2025 guide, Anthropic Effective Context Engineering): summarization prompts explicitly instruct preservation of variable/function/class names, file paths, error messages and resolutions, design decisions with rationale, task progress, tool call results, and constraints.
- Structured summary format: CONTEXT (what was being worked on) / ACTIONS (tools used, code written) / OUTCOMES (results, errors fixed) / NEXT STEPS (tasks remaining) / IMPORTANT REFERENCES (key entities to remember).
- For context-manager, the analogous schema is:
  - CONTEXT: which review cycle, which phase, which agents ran
  - FINDINGS (severity-tiered): the three-tier bucket above
  - CROSS-DOMAIN EDGES: resolved / unresolved graph edges
  - SYSTEMIC PATTERNS: 3+ occurrence root causes
  - BUDGET STATUS: OK / RECOMMENDED / MANDATORY
  - REFERENCES: file paths to original reports

### 4. Quantitative preservation results from the literature
- arXiv 2503.19114: intelligent compression approaches achieve 4-10× token reduction while preserving decision rationale, with 23% improvement on downstream tasks and up to 8 BERTScore F1 points in response grounding. Entity preservation (2.7× more entities retained) is the dominant quality factor.
- NEXUSSUM (ACL 2025): the refining agent "smooths sentence transitions, adjusts verbosity, and enhances fluency while preserving key narrative details." Practical target for context-manager: 4× compression (e.g., 64K corpus → 16K consolidation) without CRITICAL/HIGH loss.
- Server-side compaction in Claude Opus 4.6 / Sonnet 4.6 (beta `compact-2026-01-12`) demonstrates production-grade automatic summarization that "replaces stale content with concise summaries" and "keeps the active context focused and performant." Context-manager is doing the same job one layer higher (at the agent-report level, not the API layer).

### 5. "Context rot" is the hazard compression mitigates
- Anthropic: "As token count grows, accuracy and recall degrade, a phenomenon known as context rot. This makes curating what's in context just as important as how much space is available." Claude achieves state-of-the-art results on long-context benchmarks like MRCR (arXiv 2501.03276) and GraphWalks, but "these gains depend on what's in context, not just how much fits."
- Implication: simply raising the context window (Opus 4.6 is 1M tokens) does not eliminate the compression requirement. Quality degrades even with headroom. Compaction is a QUALITY tool, not only a BUDGET tool.

### 6. Lossless reference preservation via file paths
- Anthropic Effective Context Engineering: "Maintain lightweight identifiers (file paths, queries, links) instead of pre-loading all data."
- For every aggregated MEDIUM or counted LOW finding, context-manager MUST preserve the source report path so the orchestrator or human reviewer can retrieve the original losslessly. The consolidation is lossy; the underlying reports are not touched and remain the lossless source.
- This turns compression from "information loss" into "information relocation" — the signal is still on disk, it just isn't in the active context window anymore.

### 7. Merge-on-duplicate without renumbering
- A standard hazard in multi-agent review: the same file/line is flagged by two experts with overlapping scopes (e.g., security-reviewer and farm-expert both flag a missing tenant filter in `farm-service/batches.service.ts:147`). Without merge, the consolidation double-counts.
- Rule: findings with identical (file, line, root cause) are MERGED into a single entry with BOTH source agents listed. Severity is the MAX of the two. Remediation text is the UNION (concatenated with a section break and source attribution).
- Never renumber finding IDs during merge. Preserve original per-agent finding IDs so human reviewers can trace back (e.g., `[security-reviewer/C-03, farm-expert/H-07]`).

### 8. Compaction vs context editing: two distinct operations
- Anthropic distinguishes: `clear_tool_uses_20250919` clears tool results in conversation history (keeps structure, removes content); `compact_20260112` generates a summary replacing older blocks. Context editing is fine-grained; compaction is wholesale.
- For context-manager: these map to two distinct operations:
  - **Consolidation report** (compaction analogue) — a new summary document produced per cycle.
  - **Reference dereferencing** (context-editing analogue) — in downstream phases, replace full report bodies with "see `docs/reviews/farm-expert/2026-04-08-*.md`" pointers, leaving only severity-tagged references in active context.

### 9. Prompt caching and compaction interact
- From Anthropic Prompt Caching docs: tool-result clearing "invalidates cached prompt prefixes when content is cleared. Use `clear_at_least` to ensure a minimum number of tokens is cleared each time. You'll incur cache write costs each time content is cleared, but subsequent requests can reuse the newly cached prefix." Thinking block clearing preserves cache unless cleared.
- Implication for context-manager: if the orchestrator re-runs the same cycle multiple times (e.g., after partial fixes), batching the consolidation rewrites is more efficient than incremental edits. One compaction per cycle, not per report.

### 10. Critical preservation invariant: never soften a CRITICAL finding for brevity
- Anthropic Effective Context Engineering: "Start minimal, test with your best model, then add instructions/examples based on observed failures." Note: for critical findings, instructions must be prescriptive, not heuristic.
- arXiv 2503.19114 specifically measures "information preservation" as correctness-preserving compression. A compressor that loses a CRITICAL security finding to save tokens has committed a correctness bug — severity quantification is the stop-loss on compression aggressiveness.
- Rule: compression aggressiveness may increase for MEDIUM/LOW buckets as budget pressure increases, but CRITICAL/HIGH preservation is NEVER traded for budget. Exceed budget if necessary and report MANDATORY; never drop a CRITICAL.

## Security Concerns

- **Information-loss attacks via aggressive compression:** an adversary authoring an expert report could intentionally use a MEDIUM severity to hide a security-relevant finding from the compacted view. Context-manager should re-read the source report file bytes when grouping MEDIUM findings under a security-relevant theme and escalate to HIGH if the theme itself implicates tenant isolation, auth, credentials, or data leak.
- **Redaction during compaction:** PII and secrets must be redacted at the compaction boundary, not the emission boundary. Once the consolidation is emitted, there is no second chance to remove data.
- **Source-agent attribution forgery:** the consolidation must never merge a finding without preserving both source attributions. Losing attribution obscures who flagged what and breaks audit.
- **Hash-based tamper detection:** if feasible, context-manager should record a hash (SHA-256 of report file) in the consolidation's Report Manifest. A later re-read producing a different hash indicates tampering between cycles.

## Performance Concerns

- **Compression ratio target:** 4× is a reasonable default. 64K → 16K is achievable with CRITICAL/HIGH verbatim preservation + MEDIUM theming + LOW counting.
- **Pass count:** a single deterministic pass is preferable. Multi-pass LLM-driven summarization introduces nondeterminism; context-manager's compaction should be text-mechanical (regex + section extraction) where possible, LLM-driven only for theme clustering of MEDIUM findings.
- **Incremental cycles:** when the same cycle is re-run (e.g., after fixes), cache parse results by report-file SHA to avoid re-parsing unchanged reports. Only re-process changed reports.
- **Output budget cap:** target 3-5K tokens for the consolidation body (excluding the Report Manifest, which can be longer). Anything above 10K suggests the compression ratio is wrong.
- **Avoid quadratic merging:** duplicate detection is O(N²) naively but can be O(N log N) with a (file, line, root-cause-hash) index. Always use the index.

## Architectural Implications for context-manager reviews

When compacting, verify:

1. **CRITICAL and HIGH findings are preserved verbatim** — no paraphrase, no re-ordering within severity tier, no renumbering.
2. **MEDIUM findings are grouped by theme** with a count and one representative example; the rest are reference-only pointers.
3. **LOW findings are counted per source agent** with no individual enumeration.
4. **Duplicate findings are merged** on `(file, line, root-cause-hash)`; source agents are listed together; severity is MAX; remediation is UNION with attribution.
5. **Every reference to a source report** uses absolute path (or project-relative with explicit convention) — never bare agent name.
6. **Entity preservation is explicit:** every file path, function name, error string, and line number cited in a CRITICAL/HIGH finding must appear in the compacted output.
7. **The compaction never mutates source reports** — they remain the lossless ground truth.
8. **PII and secret redaction happens at the compaction boundary** before the consolidation file is written.
9. **Report file SHA (or git commit SHA) is recorded** in the Report Manifest section.

## Domain Rule Additions for context-manager

- CRITICAL and HIGH findings MUST be preserved verbatim (zero paraphrase) with full source attribution and original finding ID.
- MEDIUM findings MUST be grouped by theme with a count, a single representative example, and a path pointer to the source report. Missing pointer = PROCESS HIGH.
- LOW findings MUST be counted per source agent, never individually enumerated.
- Duplicate findings (same file, same line, same root cause) MUST be merged; severity taken as MAX; both source agents attributed; remediation texts combined with section break.
- The compaction pass MUST be deterministic (regex + section match) for the extraction stage. LLM-driven synthesis is only permitted for MEDIUM theme clustering.
- The compaction MUST target 4× compression (raw → consolidated) as a default, relaxing only when CRITICAL/HIGH count is large enough to breach.
- PII, secrets, and cross-tenant references MUST be scanned and redacted at the compaction boundary, before the consolidation file is written.
- The consolidation MUST include a Report Manifest section listing every source report by absolute path, git commit SHA (or file SHA), and severity count breakdown.
- Compression aggressiveness MUST never drop a CRITICAL or HIGH finding. Exceed the token budget and report MANDATORY rather than drop.
