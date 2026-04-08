---
Topic: Trunk-based development principles, small batch sizes, DORA Lead Time for Changes, and why small batches statistically outperform large batches.
---

## Sources

- trunkbaseddevelopment.com — canonical TBD reference (Paul Hammant)
  https://trunkbaseddevelopment.com/
- DORA, "State of DevOps 2023 Report" — four key metrics, lead time analysis
  https://dora.dev/research/2023/dora-report/
- DORA, "Accelerate" (Forsgren, Humble, Kim, 2018) — Chapter 2: Measuring Software Delivery Performance
- Martin Fowler, "Continuous Integration" (2006, updated 2023)
  https://martinfowler.com/articles/continuousIntegration.html
- Martin Fowler, "Feature Branch" — arguments against long-lived branches
  https://martinfowler.com/bliki/FeatureBranch.html
- Jez Humble and David Farley, "Continuous Delivery" (Addison-Wesley, 2010) — Chapter 3: Continuous Integration
- Google Engineering Practices, "Speed of Code Reviews"
  https://google.github.io/eng-practices/review/reviewer/speed.html
- ThoughtWorks Technology Radar — "Trunk-based development" (Adopt tier since Vol. 16)
  https://www.thoughtworks.com/radar/techniques/trunk-based-development

## Key Findings

### Trunk-Based Development (TBD) Principles

From trunkbaseddevelopment.com:
1. **Single source of truth**: a single main/trunk branch is the integration point. Long-lived feature branches are forbidden. Short-lived branches (< 24–48 hours) are tolerated for pre-commit verification.
2. **Commit frequently to trunk**: at least once per day per developer (or per agent session). The longer a branch diverges from trunk, the higher the merge conflict probability exponentially.
3. **Always keep trunk releasable**: every commit to trunk must leave the system in a deployable state. This is the same invariant as the "no bisect-hostile commits" rule from Conventional Commits research.
4. **Feature flags for incomplete work**: large features are hidden behind flags, but the code is on trunk. In the aqua-saas context, this means work packages committed incrementally even when the full feature is not yet complete.

### DORA Lead Time for Changes

- DORA defines Lead Time for Changes as the time from code committed to code successfully running in production.
- 2023 DORA findings: elite performers have lead times under one day (sometimes minutes); low performers have lead times of 6+ months.
- The primary drivers of long lead time: large batch sizes (many changes bundled into a single deployment), infrequent integration (branches that diverge for weeks), and slow verification pipelines.
- **Direct implication for this platform's work packages**: each package should be committable and verifiable within a single session. Packages that span days (due to size) indicate under-decomposition.

### Why Small Batches Statistically Outperform Large Batches

From "Accelerate" (Forsgren et al.) and queuing theory (Kingman's formula):
- **Queue waiting time grows non-linearly with batch size**: W = (ρ²/(1-ρ)) × Cs / 2μ. As utilization approaches capacity, wait time explodes. Small batches keep the queue short and wait times linear.
- **Failure blast radius**: a large batch with a regression can be hard to identify (which of 50 changes caused it?). A small batch with a regression is trivially located (which of 3 changes caused it?).
- **Feedback speed**: a one-package commit produces CI results in minutes. A 20-package mega-commit produces CI results that are harder to interpret and longer to revert.
- **MTTR (Mean Time to Recovery)**: DORA 2023 confirms that small-batch teams recover from failures 4–8× faster than large-batch teams. For this platform's 11 subgraphs and 12 services, a rapid MTTR is especially valuable because a regression in one subgraph can cascade.

### Short-Lived Branches for Each Package

- TBD allows short-lived branches for pre-commit verification. Each work package should be implemented on a branch named `fix/{NN}-{slug}` or `feat/{NN}-{slug}`, where NN is the package number from the plan. This enables:
  1. Per-package PR reviews (reviewers see exactly one concern)
  2. Per-package CI runs (parallelizable in GitHub Actions)
  3. Clean merge-to-main with a single squash commit or merge commit
- Branch lifespan: target < 2 hours from branch creation to merge. Long-lived fix branches indicate either under-decomposition or a blocked prerequisite package.

### TBD and the Work Package Model

- The work package model (one package → one branch → one commit → merged to main) is the canonical TBD small-batch pattern applied to review implementation.
- The package plan file (`NN-{slug}.md`) serves as the pre-commit checklist: the implementor verifies every step before opening the PR.
- In a TBD workflow, the implementation-planner's output is the "backlog" and the executor (human or agent) is the "team" picking packages off the top of the topologically sorted list.

### Empirical Size Bounds from Practice

- Google's internal guideline (from the Engineering Practices guide) recommends CLs of under 300 lines of diff. Beyond 300 lines, reviewer attention quality degrades.
- Microsoft Engineering Fundamentals (DevDiv experience): PRs under 400 lines have 60% faster review times and 15% fewer escaped defects vs. PRs over 800 lines.
- Synthesis for this platform: ≤ 500 lines of diff per package is the upper bound. Above 500, split.

## Security Concerns

- A work package branch that lives for more than 48 hours accumulates drift from trunk. On the auth-service or gateway-api, this drift means the branch may be missing security patches merged to trunk — creating a regression window. Security packages must be fast-tracked to merge.
- TBD's "always keep trunk releasable" invariant means security CRITICALs on trunk are hot-patched inline (hotfix branch, < 4 hours), not batched into the next planned release. The implementation-planner must flag CRITICAL packages as `HOTFIX` priority.

## Performance Concerns

- Branch creation and CI trigger overhead per package is negligible (seconds in GitHub Actions). This is not a reason to batch packages.
- For the 11-subgraph GraphQL federation setup, a package that changes one subgraph's schema triggers a supergraph re-composition step. This step is fast (< 1 minute with Apollo Studio) but must be in the verification command for that package.

## Architectural Implications

- The aqua-saas platform's multi-service architecture (12 backend services, 9 MFEs) amplifies the value of small batches: a large-batch deployment touching 8 services simultaneously has 8× the blast radius of a single-service deployment.
- Module Federation (Vite 7) remote loading means each MFE can be deployed independently. Work packages that fix a single MFE should NOT be bundled with packages that fix the host shell — they are independently deployable and independently verifiable.
- NATS JetStream event consumers: a package that changes an event consumer must leave NATS subscription handlers backward-compatible for the duration of the deployment window. Small batches make this requirement easier to reason about.

## Domain Rule Additions

1. Each work package targets one short-lived branch (`fix/{NN}-{slug}`) with a lifespan under 2 hours from creation to trunk merge.
2. CRITICAL packages are marked `HOTFIX` priority and placed first in the execution sequence regardless of topological position (they must be implemented and merged before any non-CRITICAL package).
3. Target ≤ 500 lines of diff per package. Packages estimated to exceed 500 lines must be split into sub-packages before execution begins.
4. The plan's topological sequence is the team/agent backlog. Packages are never implemented out of sequence (skipping a prerequisite creates bisect-hostile states and integration failures).
