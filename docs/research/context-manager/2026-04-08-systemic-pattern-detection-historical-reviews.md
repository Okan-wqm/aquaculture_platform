# Research: Systemic Pattern Detection Across Historical Reviews

**Topic:** N-occurrence thresholds (3+ across sources), root-cause clustering vs instance counting, false-positive reduction, time-window windowing (30 days), escalation rules
**Date:** 2026-04-08
**Agent:** context-manager

## Sources

- [Code Smell - Martin Fowler](https://martinfowler.com/bliki/CodeSmell.html)
- [Data Clump - Martin Fowler](https://martinfowler.com/bliki/DataClump.html)
- [Refactoring 2nd Edition - Martin Fowler](https://martinfowler.com/books/refactoring.html)
- [Encoding Team Standards - Martin Fowler](https://martinfowler.com/articles/reduce-friction-ai/encoding-team-standards.html)
- [Repetition in software design (IEEE Software 2001) - Martin Fowler](https://www.martinfowler.com/ieeeSoftware/repetition.pdf)
- [A systematic review on machine learning methods for root cause analysis (Frontiers 2022)](https://www.frontiersin.org/journals/manufacturing-technology/articles/10.3389/fmtec.2022.972712/full)
- [Software root cause prediction using clustering techniques: A review - IEEE Xplore](https://ieeexplore.ieee.org/document/7342714/)
- [A Comprehensive Survey on Root Cause Analysis in (Micro) Services - arXiv 2408.00803](https://arxiv.org/html/2408.00803v1)
- [Topic modeling-based prediction of software defects and root cause using BERTopic - Nature Scientific Reports (2025)](https://www.nature.com/articles/s41598-025-11458-0)
- [Root Cause Detection Among Anomalous Time Series Using Temporal State Alignment - arXiv 2001.01056](https://arxiv.org/pdf/2001.01056)
- [ThoughtWorks Technology Radar - llm-powered autonomous agents](https://www.thoughtworks.com/radar/techniques/llm-powered-autonomous-agents)

## Key Findings

### 1. The "rule of three" is the canonical recurrence threshold
- Martin Fowler's "rule of three" (Refactoring, 2nd ed.) is widely cited as the threshold for extracting a pattern: once is an incident, twice is a coincidence, three times is a pattern. The IEEE Software column on repetition (Fowler, 2001) frames recurrence as the primary signal that something in the design is missing: "if the same or similar code is appearing in several places, you have a smell that wants to be resolved."
- For context-manager, the translation is direct: a finding that appears in three or more independent reviews across the 30-day window is SYSTEMIC. Three is the floor, not the target.
- Kent Beck's "smell of the week" practice (cited by Fowler in Encoding Team Standards) encodes the pattern-reinforcement loop: once a systemic issue is identified, the team (or the review system) should actively look for more instances of it and fix them as a cluster, not individually.

### 2. Root-cause clustering, not instance counting
- IEEE Xplore's "Software root cause prediction using clustering techniques" (2015) establishes the distinction: grouping by SURFACE symptom (e.g., "null pointer exception") is a weak signal, grouping by ROOT CAUSE (e.g., "missing tenant filter in the ORM layer causes optional chain on a filtered entity") is a strong signal.
- Nature Scientific Reports (2025): BERTopic-based topic modeling combined with a multioutput classifier achieves high-quality clustering of defect descriptions. The useful unit is the topic (root-cause class), not the ticket count.
- For context-manager, the practical rule is: two findings with identical root-cause-text hash count as 1 instance for systemic purposes; instance count is measured after clustering, not before.
- arXiv 2408.00803 (Comprehensive Survey on RCA in Microservices, 2024) synthesizes: topology-graph approaches + pattern-matching on log templates + time-window bucketing are the three pillars of production RCA. All three map to context-manager's job.

### 3. Root-cause identity: hash on (category, pattern, file-shape)
- A practical root-cause identifier for context-manager: `sha256(category || pattern-string || file-shape)`, where:
  - category is the severity-tagged review category (security, performance, architecture, observability)
  - pattern-string is a normalized description of the issue (strip file paths and line numbers, keep the semantic verb-object)
  - file-shape is the glob-generalized path (e.g., `farm-service/src/**/handlers/*.ts` instead of the specific file)
- This yields a stable key across reviews: the same root cause in a different file still hashes identically because only the file-shape is used, not the exact path.
- Two findings with the same root-cause hash, flagged on different files, count as two INSTANCES of the same root cause. Three instances triggers systemic classification.

### 4. Time-window windowing: 30 days with decay
- Frontiers in Manufacturing Technology (2022) systematic review of ML methods for RCA: sliding time windows are standard for pattern emergence detection. 30 days is a defensible default balancing freshness (short windows miss slow-burn systemic issues) and noise (long windows accumulate fixed issues).
- A decay function can further refine: weight each occurrence by `exp(-days_ago / 30)`. A finding 29 days old counts 0.37 of full weight; at exactly 30 days it is dropped.
- Simple implementation for context-manager: read `docs/reviews/{agent}/` for the trailing 30 days, count uncdecayed occurrences first, and only apply decay if instance count is exactly at threshold (tie-breaker).
- Critical: the 30-day window is calendar days, not business days. File timestamps (or dates embedded in filenames) are the clock source.

### 5. Independent-occurrence criterion
- A finding repeated in two reports from the SAME agent on the SAME day (e.g., `farm-expert/2026-04-08-x.md` and `farm-expert/2026-04-08-y.md`) is ONE independent occurrence, not two.
- The independent-occurrence count must be distinct across at least one of: (a) source agent, (b) review date. Otherwise the same root cause from one agent on one day still counts as one.
- Rule: three independent occurrences means three instances that differ in at least one of (source-agent, review-date). This is the current context-manager.md rule and is consistent with the literature.

### 6. False-positive reduction: symptom vs cause separation
- IEEE Software (Fowler 2001) warns that raw repetition detection produces many false positives. "Smells aren't inherently bad on their own — they are often an indicator of a problem rather than the problem themselves." Context-manager should mirror this: systemic detection raises an INDICATOR, not a verdict.
- The false-positive control mechanisms from the literature, ranked by strength:
  1. **Root-cause clustering** (not symptom counting) — biggest single win
  2. **Independent-occurrence requirement** (different agent or date) — prevents self-counting inflation
  3. **Severity gating** — only count findings ≥ MEDIUM severity toward systemic analysis; LOW findings are too noisy
  4. **Fixed-issue filtering** — if a prior systemic pattern has a confirmed fix commit SHA, drop it from the count
  5. **Category scope check** — systemic detection runs per review category (security, performance, etc.), not globally; cross-category coincidence is coincidence

### 7. Escalation rules: +1 severity per unfixed cycle
- Escalation is the hard part: if a systemic pattern is detected and NOT fixed, the next cycle must escalate. The current context-manager.md rule (+1 severity) is consistent with production best practice.
- Formal rule: `new_severity = min(CRITICAL, prior_severity + 1 * unfixed_cycles_count)`. After two unfixed cycles, a MEDIUM becomes HIGH, then CRITICAL.
- The `prior_severity` comes from the last systemic-pattern report for this root-cause hash. The `unfixed_cycles_count` is the number of subsequent cycles in which the same root-cause hash reappeared without any review of a commit that targets it.
- Git-commit-SHA-based "fixed" tracking: a systemic pattern is considered fixed iff a commit message references the consolidation report file path (e.g., `Fixes docs/recommendations/context-manager/2026-03-15-systemic-tenant-filter.md`). Without this reference, the pattern is presumed unfixed on the next cycle.

### 8. Human escalation rules
- Three distinct escalation endpoints:
  - **+1 severity per unfixed cycle** — automatic escalation within the normal review loop
  - **After CRITICAL + 1 unfixed cycle** — escalate to `architectural-arbiter` with CRITICAL severity and a "SYSTEMIC + UNFIXED" flag
  - **After 3 consecutive unfixed cycles at any severity** — escalate to HUMAN reviewer with a blocking "process failure" flag; deployments should pause until acknowledged

### 9. Cross-cutting systemic patterns
- A systemic pattern spanning multiple expert agents (e.g., tenant isolation bugs flagged by both farm-expert and messaging-expert across multiple files) is a stronger signal than a single-agent pattern.
- Rule: a single-agent systemic pattern is escalated to the same agent + architectural-arbiter. A multi-agent systemic pattern is escalated directly to architectural-arbiter, bypassing domain agents. This is because multi-agent crossing indicates an architectural shared infrastructure is at fault.

### 10. Topology-graph enrichment of pattern detection
- arXiv 2408.00803 synthesizes that topology-graph approaches (knowing which service calls which) dramatically improve RCA quality over log-only analysis. For context-manager, the analogue is the cross-domain dependency graph from research file 3: if two systemic findings are in agents that are graph-connected, they likely share a root cause upstream on the dependency path.
- Rule: when two systemic patterns are detected in agents connected by a cross-domain edge, bundle them as a single "upstream suspect" report to architectural-arbiter with both patterns attached.

## Security Concerns

- **Systemic blindness to security:** a pattern-detection system that counts on root-cause hashes may fail to aggregate closely-related security issues that have distinct root causes but the same architectural gap. Periodic HUMAN audit of the trailing 30 days of security-reviewer reports is required to catch what the hash-based detector misses.
- **Attacker camouflaging by distribution:** a malicious actor aware of the systemic detector could intentionally vary surface details to avoid hashing collisions (e.g., renaming parameters). Mitigation: include abstract-syntax-level signatures in the root-cause hash when source code snippets are present in the finding.
- **Escalation denial-of-service:** a buggy expert agent that repeatedly emits the same finding could spoof 30 days of independent occurrences and drive a false systemic escalation to architectural-arbiter. Independent-occurrence criterion (different agent OR different date) plus per-agent rate limits on systemic detection are the defenses.
- **Suppression by fix-reference spoofing:** a commit message can reference a systemic pattern's path without actually fixing it. Periodically re-scan the target file-shape on every cycle; if the root-cause hash re-appears after a "fix" commit, re-open the systemic pattern with CRITICAL severity and "fix failed" flag.

## Performance Concerns

- **30-day scan cost:** reading all `docs/reviews/{agent}/*.md` for 30 days is bounded by total file count. At ~10 experts × ~2 reviews/day × 30 = ~600 files. Each ~5-10K tokens. This is 3-6M tokens of raw scan text per cycle — too much to LLM-process. Must be deterministic grep/parse.
- **Hash index:** maintain an index file `docs/reviews/context-manager/.index.jsonl` with one line per finding (root-cause hash, source agent, file path, line, date, severity). Rebuilds from the 30-day file scan are O(files). Pattern detection is O(distinct-hashes) using a Counter on the index.
- **Incremental updates:** new reports added today only append to the index; prior days are immutable. Check for new files by mtime, not by full re-scan.
- **Decay computation:** decay weights are only needed at tie-breaking time (instance count == 3). In the common case, count without decay first; apply decay only if count is exactly at threshold.

## Architectural Implications for context-manager reviews

When scanning for systemic patterns, verify:

1. **Root-cause clustering happens before instance counting** — the counter operates on distinct root-cause hashes, not raw findings.
2. **Independent-occurrence criterion is enforced:** instances must differ in at least one of (source-agent, review-date).
3. **30-day window is calendar-based;** file date (from filename convention `YYYY-MM-DD-*.md`) is the clock source.
4. **LOW findings are excluded** from systemic detection; the floor is MEDIUM.
5. **Fix-reference tracking:** systemic patterns previously reported are re-queried each cycle; unfixed patterns escalate +1 severity automatically.
6. **Git commit SHA must reference the systemic report path** to count as a fix attempt. Verify by re-scanning for the root-cause hash in the target file-shape on the next cycle.
7. **Multi-agent systemic patterns escalate directly to architectural-arbiter.** Single-agent systemic patterns escalate to same agent plus architectural-arbiter.
8. **After 3 consecutive unfixed cycles, HUMAN escalation is mandatory;** the consolidation must emit a blocking "PROCESS FAILURE" marker.
9. **Index file (`.index.jsonl`) is maintained incrementally** to avoid full 30-day re-scans.
10. **The consolidation's systemic section cites** all 3+ source reports by absolute path, with dates and root-cause hash.

## Domain Rule Additions for context-manager

- Systemic detection MUST operate on root-cause hashes, not on raw finding counts. The hash formula is `sha256(category || normalized-pattern-string || glob-generalized-file-shape)`.
- Three independent occurrences within a 30-day calendar window triggers SYSTEMIC classification. Independence requires differing source-agent OR differing review-date.
- LOW-severity findings MUST be excluded from systemic detection; the floor is MEDIUM.
- The 30-day window is computed from the review file date (convention `YYYY-MM-DD-*.md`).
- Systemic patterns from prior cycles MUST be re-checked each cycle. An unfixed systemic pattern escalates severity by +1 per cycle, capped at CRITICAL.
- A systemic pattern is considered "fix-attempted" ONLY if a git commit message references the systemic report path AND the root-cause hash is absent from the target file-shape on the next cycle's scan. Missing either = still unfixed.
- Single-agent systemic patterns MUST be escalated to the source agent AND `architectural-arbiter`.
- Multi-agent systemic patterns (same root-cause hash reported by two or more different agents) MUST be escalated directly to `architectural-arbiter` and flagged as "cross-cutting."
- After 3 consecutive unfixed cycles at any severity, HUMAN escalation is MANDATORY. The consolidation MUST include a blocking "PROCESS FAILURE" marker.
- The systemic section of the consolidation MUST cite all contributing source reports by absolute path, date, source agent, and original finding ID.
- The systemic-pattern detector MUST maintain an incremental index file at `docs/reviews/context-manager/.index.jsonl` to avoid re-scanning 30 days on every run.
