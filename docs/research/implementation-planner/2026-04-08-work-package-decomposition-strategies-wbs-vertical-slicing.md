---
Topic: How to decompose a large review output (50+ findings) into independently executable, testable work packages using WBS, vertical slicing, INVEST criteria, and User Story Mapping.
---

## Sources

- PMI/PMBOK 7th Edition (2021) — Work Breakdown Structure chapter, practice guide WBS-2nd Ed.
  https://www.pmi.org/pmbok-guide-standards/practice-guides/wbs
- SAFe 6.0 — Feature Slicing, Story Decomposition Patterns, Splitting Stories guide
  https://scaledagileframework.com/story/  
  https://scaledagileframework.com/splitting-user-stories/
- Atlassian Agile Coach — "How to break user stories down into tasks"
  https://www.atlassian.com/agile/project-management/user-stories
- Bill Wake, "INVEST in Good Stories, and SMART Tasks" (2003) — canonical INVEST definition
  https://xp123.com/invest-in-good-stories-and-smart-tasks/
- Jeff Patton, "User Story Mapping" (O'Reilly, 2014) — Chapter 5: Breaking Backbone Stories
- ThoughtWorks Technology Radar Vol. 28 (2023) — Small Batch Delivery entry
  https://www.thoughtworks.com/radar
- Mike Cohn, "Agile Estimating and Planning" — story splitting and sizing heuristics

## Key Findings

### WBS Decomposition (PMI/PMBOK)
- A WBS decomposes deliverables, not activities. The terminal element (work package) represents a verifiable, time-boxed unit of work. WBS rule: each work package must have a single responsible owner, defined acceptance criteria, and an estimable effort.
- WBS decomposition stops when the package is: (a) independently estimable, (b) independently deliverable, (c) independently testable, and (d) neither too large to complete in one context window nor too small to warrant a commit boundary.
- WBS is hierarchical top-down; review findings map to WBS leaf nodes grouped by affected subsystem (the WBS "branch" is the bounded context or service).

### Vertical Slicing (SAFe / Agile)
- A vertical slice cuts through all layers required to deliver a working increment — front end, back end, data, tests. Horizontal slices ("fix all DTOs", then "fix all entities") prevent early validation and produce large all-or-nothing merges.
- SAFe decomposition heuristics that map directly to review-finding packages:
  1. Split by workflow step (e.g., "creation path only" before "update path")
  2. Split by simple/complex (fix the trivially-wrong case first; the exceptional case second)
  3. Split by CRUD operation (Create, Read separately from Update/Delete)
  4. Split by business rule (each CRITICAL finding with its own business rule becomes its own package)
  5. Split by data variant (one tenant schema variant per package when isolation is the concern)

### INVEST Criteria (Bill Wake, 2003)
- **Independent**: the package can be implemented without waiting for another package in the same batch (exception: declared prerequisite packages).
- **Negotiable**: the scope of the package is explicitly listed; nothing implicit.
- **Valuable**: each package delivers a reviewable, testable improvement. A package that only touches test infrastructure without an associated fix is LOW value — acceptable but must be flagged.
- **Estimable**: the package lists Affected Files and an estimated diff size (line count / token footprint) upfront.
- **Small**: a package targets ≤ 10 findings or ≤ 500 lines of diff or ≤ 20K tokens of loaded context (whichever first). Exceeding the size bound requires a sub-package split.
- **Testable**: every package must specify a Verification Command that produces a pass/fail signal.

### User Story Mapping Applied to Review Findings
- Discovery mapping: group findings by domain narrative ("batch lifecycle", "sensor ingestion", "tenant isolation") as the horizontal backbone. Findings in the same domain narrative that share a root cause cluster into one story. Findings in the same domain narrative with different root causes get separate packages.
- Release slice: the top row (must-have) = CRITICAL and HIGH. Second row = MEDIUM. Third row = LOW.

### Grouping Priority for Review Findings
1. **File locality first**: findings that touch the same file → same package, unless INVEST size bound is exceeded.
2. **Root cause second**: findings with the same root cause in different files → same package (they must be fixed atomically or the fix is incomplete).
3. **Dependency order third**: findings where Fix A must precede Fix B → separate packages in topological order with explicit prerequisite annotation.
4. **CRITICAL isolation last**: each CRITICAL finding that stands alone (root cause not shared with other findings) → its own package. CRITICAL findings MUST NOT be bundled with lower-severity findings in the same package (blocks deployment debugging).

## Security Concerns

- Bundling a CRITICAL security finding with MEDIUM functional findings in the same work package creates a deployment gate risk: if the MEDIUM fix fails verification, the CRITICAL fix is blocked as collateral. Rule: CRITICAL security findings are always isolated in their own packages.
- Packages that touch auth-service, gateway-api, or any guard/middleware file must be tagged `security-sensitive`; the security-reviewer gate is mandatory for these packages regardless of declared severity.

## Performance Concerns

- Over-decomposition (too many tiny packages) creates coordination overhead: each package requires a commit, a verification run, and a checkbox update. Empirically, packages under ~5 lines of diff are waste unless they fix a CRITICAL issue. Aggregate ultra-small findings into a "housekeeping" package when they share the same domain.
- Under-decomposition (one mega-package) reintroduces the original context-overflow problem. The 20K-token loaded-context bound is the hard stop.

## Architectural Implications

- The package structure must mirror the bounded-context architecture of the platform. A package that crosses service boundaries (e.g., fixes both farm-service and event-contracts in one commit) breaks atomic commit discipline: if farm-service changes are wrong, reverting the commit also reverts the contract fix. Split these into prerequisite-ordered packages.
- For the aqua-saas platform's CQRS architecture, group command-handler and its corresponding event into the same package (they are atomically coupled); query handlers can be separate packages.

## Domain Rule Additions

1. Package decomposition applies INVEST criteria; size bound is ≤ 10 findings OR ≤ 500 lines of diff OR ≤ 20K tokens of loaded context, whichever is first.
2. Grouping priority: file locality → shared root cause → dependency order → CRITICAL isolation.
3. CRITICAL findings always get their own package; they MUST NOT be bundled with lower-severity findings.
4. Vertical slice discipline: every package must touch all necessary layers (entity, handler, event, test) for the fix to be complete and independently verifiable.
5. A package that crosses service boundaries (app + shared lib) must be split into prerequisite-ordered sub-packages.
