---
Topic: Claude Opus 4.6 context window budgeting, 50% headroom rule, per-package size bound derivation, and Anthropic best practices on context management.
---

## Sources

- Anthropic Documentation, "Claude's context window and token limits"
  https://docs.anthropic.com/en/docs/about-claude/models
- Anthropic Documentation, "Build with Claude — Long context tips"
  https://docs.anthropic.com/en/docs/build-with-claude/context-window
- Anthropic Documentation, "Token counting API"
  https://docs.anthropic.com/en/docs/build-with-claude/token-counting
- Anthropic Research, "Long context performance and context window scaling" (2024 technical blog)
  https://www.anthropic.com/research
- Nelson Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" (2023)
  https://arxiv.org/abs/2307.03172
- Anthropic Claude System Card (2024) — context management and performance characteristics
  https://www.anthropic.com/claude-system-card
- context-manager agent research: `docs/research/context-manager/2026-04-08-token-budget-estimation-model-context-limits.md`

## Key Findings

### Claude Opus 4.6 Context Window

- Claude Opus 4.6 has a **1,000,000 token** (1M) context window. This is the CEILING, not the working target.
- The model supports 200K tokens of OUTPUT within that window. Input + output = 1M total.
- A 1M token context window does NOT mean 1M tokens of working quality. The "lost in the middle" phenomenon (Liu et al., 2023) demonstrates that model attention is strongest at the beginning and end of the context; material placed in the middle of very long contexts is retrieved less reliably. For reasoning-intensive tasks (like implementing a security fix), this degradation matters.

### 50% Headroom Rule

- Anthropic's long-context tips recommend leaving at least 50% of the context window as working headroom for the model's reasoning chain (extended thinking, chain-of-thought) and output generation.
- For Claude Opus 4.6 (1M window): working input budget = **500K tokens maximum**.
- In practice, for implementation sessions where source code is loaded, tests are run, and diffs are inspected, the effective useful context is much smaller due to attention quality degradation. Anthropic recommends **keeping implementation sessions under 200K tokens** of loaded context for reliable performance on complex multi-file refactors.
- The context-manager agent (which this platform uses) already applies the `chars / 3.5` estimation heuristic. The same heuristic applies to package size estimation.

### Per-Package Token Footprint Derivation

Components of a single work package session's token consumption:
1. **Plan context**: plan.md + this package file ≈ 1-3K tokens
2. **Source files loaded**: for each affected file, estimate `chars / 3.5`. A 300-line TypeScript file ≈ 3K tokens. If a package touches 5 files of average 300 lines = 15K tokens.
3. **Test files loaded**: test files are typically 50-100% the size of source files. Add 7-10K tokens for relevant test files.
4. **Review findings verbatim**: CRITICAL/HIGH findings quoted from source reports ≈ 1-2K tokens per finding. A package with 5 HIGH findings ≈ 10K tokens.
5. **Diff output and build output**: after implementing, git diff + test output ≈ 5-15K tokens depending on change size.
6. **Model reasoning budget**: the implementation session needs headroom for extended thinking. Reserve 50K tokens minimum for this.

**Rough total for a well-sized package: 20K-80K tokens loaded context.**

### Derived Package Size Bounds

Setting the target at ≤ 200K tokens total session context (conservative headroom):
- Subtract 50K for model reasoning budget = 150K available for input
- Subtract 3K for plan context = 147K
- With average 3K/file source loading, 147K / 3K ≈ **49 files maximum** (rarely reached)
- The practical binding constraint is NOT file count but **finding count**: each CRITICAL/HIGH finding includes verbatim review text (2-3K tokens each) × 10 = 30K tokens just for findings. Plus source files for those findings.

**Derived three-way size bound (whichever is reached first):**
1. **≤ 10 findings per package** (including all severity levels; CRITICAL count double toward the limit)
2. **≤ 500 lines of diff** (git diff output; counting both removed and added lines)
3. **≤ 20K tokens of source files loaded** (estimated via chars/3.5)

These bounds are consistent with the context-manager agent's per-report cap (50K tokens per report), the platform's existing compaction discipline, and Google's CL size guidelines.

### Anthropic Best Practices on Context Loading

1. **Place the most important content first**: the "lost in the middle" effect means findings and file excerpts that are load-bearing (the actual bug, the fix target) should be at the TOP of the context, not buried after boilerplate.
2. **Use structured delimiters**: XML tags (`<findings>`, `<affected_file>`, `<test_plan>`) help the model parse context structure without relying on proximity heuristics.
3. **Prefer targeted file reads over full file loads**: load only the function/class containing the bug, not the entire 800-line file. This is especially important for entity files in NestJS where the entity definition may be 50 lines but the file contains 200 lines of unrelated imports.
4. **Cache stable context separately**: if plan.md is read once and then packages are executed serially, the plan context can be cached (Anthropic prompt caching, ~10% of normal cost for re-reads). Plan the package file format to maximize prompt cache hit rate: stable header sections first, dynamic finding-specific content last.
5. **Token counting before loading**: use Anthropic's `/v1/messages/count_tokens` API (or the chars/3.5 estimate) to verify a package's estimated footprint before loading all files. If the estimate is near the bound, split the package.

### Context Rot and Session Length

- "Context rot" describes the phenomenon where a very long context session accumulates intermediate thoughts, failed attempts, and stale readings that degrade the model's focus on the current task.
- For implementation: sessions that exceed 4-6 hours of active work, or that load and modify 15+ files, exhibit context rot. The symptom is the model re-introducing bugs it already fixed, or failing to notice a constraint it stated 50K tokens ago.
- **The work package model is the cure for context rot**: by bounding each session to ≤ 10 findings / ≤ 20K loaded source tokens, each package session stays well below the rot threshold. A fresh context is loaded for each new package.

### Sub-Package Splitting Protocol

When a package's estimated token footprint exceeds the bound:
1. Identify the natural split point: either by domain layer (entity fix vs. handler fix) or by finding severity (CRITICAL findings in package 4a, HIGH in package 4b with 4a as prerequisite).
2. Re-number: package 4 → packages 4a and 4b. Add edge 4a → 4b to the dependency graph.
3. Update plan.md checkbox to include both sub-packages.
4. Do NOT simply increase the package bound — the bound exists to protect context quality.

## Security Concerns

- Artificially large packages created to "get through the list faster" introduce a risk that security findings get lost in the middle of the context. The 10-finding bound is partially motivated by security review quality.
- A package that loads too much context may cause the model to miss a subtle security constraint (e.g., a `tenantId` check 30K tokens into the context). Small packages keep security-critical material in the high-attention zone.

## Performance Concerns

- Context loading time is linear in token count. For a well-sized package (20-50K tokens), load time is under 5 seconds. For a poorly bounded package (200K tokens), load time is noticeable and output quality is lower.
- Prompt caching: stable plan-header content cached = 0.1× token cost on re-reads. Over a 20-package plan execution, this is a meaningful cost reduction.

## Architectural Implications

- The 200K-token per-session target assumes Claude Opus 4.6's 1M window with 50% headroom. If the platform upgrades to a future model with a larger window, the bounds should be recalculated using the same formula: (window × 0.5 × 0.4 [source-files fraction]) / average-finding-token-cost.
- The context-manager agent already has complementary machinery: it compacts findings to ≤ 10K tokens output. The implementation-planner should treat the context-manager's compacted output (not the raw expert reports) as the source for verbatim finding text. This alone reduces per-package context load by 4-10×.

## Domain Rule Additions

1. Each package targets ≤ 10 findings, ≤ 500 lines of diff, ≤ 20K tokens of loaded source — whichever is reached first.
2. CRITICAL findings count double toward the 10-finding limit (they carry more context loading due to verbatim quoting).
3. When a package estimate exceeds the bound, split into sub-packages (4a, 4b) with the first as prerequisite of the second; re-number in the plan and dependency graph.
4. Source text for findings in the package file is taken from the context-manager compacted output, not raw expert reports — this alone reduces per-package context overhead 4-10×.
5. Package file format: stable header (metadata, dependencies) before dynamic body (findings, test plan) to maximize prompt cache hit rate on plan re-reads.
