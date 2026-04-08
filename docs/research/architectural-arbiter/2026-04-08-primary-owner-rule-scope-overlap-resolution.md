# Research: Primary Owner Rule & Scope Overlap Resolution

**Topic:** Multi-team code ownership, CODEOWNERS patterns, module boundary enforcement, who decides on shared modules, scope dispute resolution workflows
**Date:** 2026-04-08
**Agent:** architectural-arbiter

## Sources

- [About code owners - GitHub Docs](https://docs.github.com/articles/about-code-owners)
- [Codeowners Multi-Approval Check - GitHub Marketplace Action](https://github.com/marketplace/actions/codeowners-multi-approval-check)
- [Repository Rulesets vs CODEOWNERS - GitHub community](https://github.com/orgs/community/discussions/35673)
- [bliki: Conway's Law - Martin Fowler](https://martinfowler.com/bliki/ConwaysLaw.html)
- [bliki: Team Topologies - Martin Fowler](https://martinfowler.com/bliki/TeamTopologies.html)
- [Linking Modular Architecture to Development Teams - Martin Fowler](https://martinfowler.com/articles/linking-modular-arch.html)
- [Demystifying Conway's Law - ThoughtWorks](https://www.thoughtworks.com/insights/articles/demystifying-conways-law)
- [Embrace Conway's Law - ThoughtWorks Technology Radar Press](https://www.thoughtworks.com/en-es/about-us/news/2021/latest-thoughtworks-technology-radar-proclaims---embrace-conway-)
- [Sam Newman - Backends For Frontends pattern](https://samnewman.io/patterns/architectural/bff/)
- [Building Microservices, 2nd Edition - Sam Newman](https://samnewman.io/books/building_microservices_2nd_edition/)
- [Building Microservices Workshop - Sam Newman](https://samnewman.io/talks/building-microservices-tutorial/)
- [Team Topologies — Key Concepts](https://teamtopologies.com/key-concepts)
- [Team Interaction Modeling — Team Topologies](https://teamtopologies.com/key-concepts-content/team-interaction-modeling-with-team-topologies)
- [Identify microservice boundaries - Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/microservice-boundaries)

## Key Findings

### 1. Conway's Law as the underlying physics

Melvin Conway (1968) and the modern restatement: **the structure of a software system mirrors the communication structure of the organization that built it**. Fowler's bliki notes the strong corollary that "the modular decomposition of a system and the decomposition of the development organization must be done together."

For the aqua-saas platform, the agent roster IS the organization for the purpose of this law. Each agent has a domain it owns. When two agents disagree on the same file, the conflict is a Conway's Law manifestation: the file lies on a boundary between two communication channels, and the boundary is either undefined or contested.

The arbiter's job is not to "pick a winner" arbitrarily; it is to **make the boundary explicit and stable**, so future cycles do not relitigate the same dispute.

### 2. CODEOWNERS — what it does and what it does not do

GitHub's CODEOWNERS file is the canonical mechanism for **declaring** ownership in a multi-team repository. The relevant rules:

- A path pattern with one or more owners. The **last matching pattern wins** (later lines override earlier ones).
- Multiple owners on the same line are all required (when branch protection requires CODEOWNERS approval). Multiple owners on different lines: the last line's owners override the earlier ones for the matching path.
- CODEOWNERS approval is enforced by **branch protection rules** — the file alone does not block merges; it must be paired with a "require review from Code Owners" rule.
- By default, GitHub requires **one** approval from the matching code owners, even if multiple owners are listed. To require approval from every owner, you need an external action (e.g., `codeowners-multi-approval-check`) or GitHub's newer Repository Rulesets.

What CODEOWNERS does not do:
- It does not establish a hierarchy of primary/secondary owners — every listed owner is equal in authority.
- It does not record **why** the ownership was assigned. That belongs in an ADR.
- It does not resolve disputes between owners. It only enforces that all (or one) of them must approve.

For a multi-agent review system like aqua-saas, the equivalent of CODEOWNERS lives in each agent's prompt (their "Scope" section listing the directories and files they review). The arbiter's role is to detect when two agents' scopes overlap and to designate primary/secondary authority — analogous to a CODEOWNERS reorganization.

### 3. Primary owner rule — the resolution heuristic

Across CODEOWNERS practice, Team Topologies, and Newman's microservices guidance, the consistent rule is: **for any code unit (file, module, package), exactly one team is the primary owner**. Other teams may be secondary reviewers, but only the primary owner has decision authority.

The criteria for designating primary ownership, in priority order:

1. **Domain alignment.** The team whose ubiquitous language the code most closely matches. A file using `Feeding`, `BatchHarvest`, `WaterQuality` belongs to `farm-expert`'s primary ownership regardless of its physical location.
2. **Change frequency.** The team that has historically made the most semantic changes to the file (per `git blame` aggregation). Cosmetic edits and dependency bumps do not count.
3. **Domain invariant authority.** The team whose domain invariants the file enforces. If the file enforces VFD safety interlocks, `sensor-expert` is the primary owner regardless of whether `infra-expert` also touches it for deployment configuration.
4. **Code locality.** The team whose service/module physically contains the file, used as a tiebreaker.

When primary ownership is unclear after applying these criteria, the arbiter must **declare** an owner via an ADR rather than leaving the file in a contested state. Indecision is the worst outcome — it guarantees the same conflict in the next cycle.

### 4. Secondary reviewers and consultation

Team Topologies' "Collaboration" interaction mode and the Customer/Supplier DDD pattern both prescribe a **consultation** relationship for shared concerns:

- **Primary owner** decides and merges.
- **Secondary reviewer(s)** are consulted and can object, but cannot block unless their objection is escalated to arbitration.
- The consultation is recorded — in CODEOWNERS, in PR review history, or in an ADR.

For aqua-saas, this maps cleanly to:
- The primary agent runs first; their recommendation is canonical.
- The secondary agent runs and may flag a concern; their concern is documented but does not override the primary unless it triggers a new arbitration.
- The arbiter is invoked only when the secondary's concern is genuinely irreconcilable with the primary's recommendation.

This prevents the failure mode where every shared file requires unanimous approval from N agents — that mode is paralysis by consensus.

### 5. Shared modules — the high-coordination zone

Some code does not belong to any single domain: shared libraries (`libs/event-contracts/`, `libs/outbox/`, `libs/auth/`), platform infrastructure (`infra/`), the dependency-injection wiring of the monorepo. For these, two strategies are valid:

**Strategy A — Platform team owns it (Team Topologies platform team).** A dedicated team (`platform-services`) owns the shared module and treats it as an internal product. Other teams are consumers and submit feature requests; the platform team prioritizes and ships.

**Strategy B — Shared kernel with explicit contributors (DDD shared kernel).** The shared module has a defined set of contributing teams who jointly own it. Changes require approval from all contributing teams, captured in CODEOWNERS or its equivalent.

The Newman "Building Microservices" 2nd ed. and Team Topologies guidance both warn that **strategy B does not scale beyond 2-3 teams**. Past that, the coordination cost becomes prohibitive and the shared kernel either ossifies (no one can change it) or becomes inconsistent (everyone changes it without coordination). Past 3 contributors, the recommendation is to switch to strategy A and put a platform team in front of the shared module.

For the aqua-saas platform, `platform-services` is the platform team. Shared libraries that touch many services (event-contracts, outbox, auth) should default to strategy A: `platform-services` is the primary owner, domain experts are consumers.

### 6. CODEOWNERS hardening — what an enforced boundary looks like

GitHub Repository Rulesets (the newer mechanism) and the Codeowners Multi-Approval Check action provide three enforcement levels:

- **Level 1: Soft notification.** CODEOWNERS auto-assigns reviewers but the merge does not require their approval. Default-cheap; useful only as an early warning.
- **Level 2: At least one owner approves.** GitHub default for "Require review from Code Owners" branch protection. Sufficient for most teams.
- **Level 3: All owners approve.** Required for high-risk paths (security-sensitive code, cross-service contracts, infrastructure). Achieved via Repository Rulesets or third-party actions.

For agent-level governance in aqua-saas, the equivalent is:
- Level 1: agent runs but its findings are notes only.
- Level 2: agent runs and any HIGH/CRITICAL finding blocks the cycle.
- Level 3: multiple agents must concur for changes to a path; the arbiter is the tiebreaker.

The arbiter's authority IS Level 3. When the arbiter writes an ADR designating primary ownership, that ADR becomes the equivalent of a CODEOWNERS rule — future cycles defer to it.

### 7. Scope overlap as a recurring pattern

Fowler's bliki and Team Topologies both observe that **scope overlap is not a one-time problem; it is a continuous adjustment process**. As the system evolves, new files are introduced that do not cleanly fit any team's existing scope. The healthy pattern is:

1. New file appears.
2. First cycle: two agents both review it (overlap).
3. Arbiter detects the overlap and designates primary ownership in an ADR.
4. The ADR's Decision section updates the affected agents' scopes (via `prompt-writer`) to make the boundary permanent.
5. Future cycles: only the primary agent reviews; the secondary defers.

The unhealthy pattern is:
1. New file appears.
2. Two agents fight over it every cycle.
3. The arbiter resolves it ad-hoc each time without recording the decision.
4. The same dispute recurs indefinitely.

The healthy pattern requires the arbiter to be **systemic**, not reactive: every scope dispute generates an ADR AND an instruction to `prompt-writer` to update the affected agent prompts.

### 8. Inverse Conway Maneuver — adjusting team boundaries to fit architecture

ThoughtWorks Technology Radar (2021) explicitly endorsed Conway's Law as inevitable and named the **Inverse Conway Maneuver**: rather than fighting Conway's Law, deliberately design the team structure to produce the desired architecture.

For multi-agent systems, this translates to: rather than letting agent scopes drift into overlap, the platform owner should periodically **re-design the agent roster** to match the desired modular boundaries. The arbiter's recurring-scope-conflict findings are the input to that redesign — three or more cycles of the same two agents conflicting on the same kind of file is evidence that the agent scopes need rebalancing.

The arbiter's escalation in this case is not "human, decide this conflict" but "human, the agent scopes are wrong; please rebalance via prompt-writer."

### 9. Ownership disputes vs technical disputes

The arbiter must distinguish two failure modes that look similar:

- **Ownership dispute.** Two agents both want to review the same file because their scopes overlap. The arbitration is "who owns this file going forward." Resolution: ADR + prompt update.
- **Technical dispute.** Two agents agree on who owns the file but disagree on the correct fix. The arbitration is "which fix is correct." Resolution: ADR with technical reasoning, no scope change.

These require different ADRs. Mixing them in a single ADR confuses precedent: a future arbiter looking up "who owns sensor calibration migrations" should not have to read through a technical fix dispute to find the answer.

## Architectural Implications for architectural-arbiter

The arbiter operates as the **scope arbiter** for the agent roster, analogous to a CODEOWNERS administrator for a multi-team repository. Specifically:

1. **Detect overlap from review reports.** When two agents both produce findings for the same file in the same cycle, that is the trigger.
2. **Apply the primary owner rule** (§3): domain alignment first, then change frequency, then invariant authority, then code locality. Pick exactly one primary.
3. **Designate secondary reviewers** if the file genuinely requires cross-domain consultation (not all overlapping files do).
4. **Write the designation as an ADR** — the ADR is the long-lived precedent.
5. **Instruct `prompt-writer`** to update the affected agent prompts so the boundary is encoded in the agent definitions, not just in the ADR.
6. **Track recurring conflicts** — three or more cycles of the same two agents conflicting on related files is a SYSTEMIC architectural tension, escalated to `context-manager` and ultimately to human review for roster rebalancing.

Distinguish ownership disputes from technical disputes; do not bundle them.

## Domain Rule Additions for architectural-arbiter

- When two agents both produce findings for the same file in the same cycle, the arbiter MUST designate exactly ONE primary owner via ADR. Multi-primary ownership ("both agents own this") = HIGH (the next cycle will reproduce the conflict).
- Primary owner designation MUST follow the priority order: domain language alignment → change frequency → invariant authority → code locality. Ad-hoc designation without applying the criteria = MEDIUM (the precedent is not reproducible).
- Every primary owner ADR MUST also issue an instruction to `prompt-writer` to update the affected agent prompts. ADRs without scope-update instructions = HIGH (the boundary lives only in the ADR and is invisible to the agents themselves).
- Shared infrastructure (libs/event-contracts/, libs/outbox/, libs/auth/, libs/scoped-repository/) defaults to `platform-services` primary ownership. Domain agents are secondary reviewers. Designating a domain agent as primary owner of shared infrastructure = HIGH (creates a single-domain bias on a cross-domain library).
- Shared kernel ownership (more than one primary) is permitted only for at most 2 teams AND only with an explicit ADR naming the kernel and the joint owners. Implicit shared kernels (no ADR) = HIGH.
- Recurring scope conflicts between the same two agents on related files across THREE or more cycles MUST be flagged as SYSTEMIC and escalated to `context-manager` AND human review for roster rebalancing. Ad-hoc resolution of recurring conflicts = MEDIUM (the underlying boundary problem is hidden).
- The arbiter MUST distinguish ownership disputes from technical disputes and produce SEPARATE ADRs for each. Bundling ownership and technical disputes in one ADR = MEDIUM (precedent lookup is broken; future arbitrations will cite the wrong ADR).
- A primary owner ADR MUST cite the specific files in scope, with absolute paths and a glob if a directory. Vague scope ("the messaging library") = HIGH (the boundary cannot be applied uniformly).
- An ADR that contradicts a prior primary-owner ADR MUST explicitly supersede it (per Nygard pattern). Silent override = CRITICAL (the precedent log is now inconsistent).
