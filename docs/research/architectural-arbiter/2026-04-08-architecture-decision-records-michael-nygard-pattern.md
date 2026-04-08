# Research: Architecture Decision Records — Michael Nygard's Pattern

**Topic:** ADR structure, lifecycle states, supersession, when to write one, linking, open-source examples
**Date:** 2026-04-08
**Agent:** architectural-arbiter

## Sources

- [bliki: Architecture Decision Record - Martin Fowler](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html)
- [Scaling the Practice of Architecture, Conversationally - Martin Fowler](https://martinfowler.com/articles/scaling-architecture-conversationally.html)
- [Decentralizing the Practice of Architecture at Xapo Bank - Martin Fowler](https://martinfowler.com/articles/xapo-architecture-experience.html)
- [Documenting Architecture Decisions - Michael Nygard / Cognitect (2011)](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [Architecture Decision Record (ADR) examples - joelparkerhenderson/architecture-decision-record](https://github.com/joelparkerhenderson/architecture-decision-record)
- [Michael Nygard ADR template - joelparkerhenderson/architecture-decision-record](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md)
- [Architectural Decision Records — adr.github.io](https://adr.github.io/)
- [Lightweight Architecture Decision Records — ThoughtWorks Technology Radar](https://www.thoughtworks.com/en-us/radar/techniques/lightweight-architecture-decision-records)
- [Lightweight technology governance — ThoughtWorks](https://www.thoughtworks.com/en-de/insights/articles/lightweight-technology-governance)
- [actions/toolkit ADR README — github.com/actions/toolkit](https://github.com/actions/toolkit/blob/main/docs/adrs/README.md)
- [pyadr — opinionated-digital-center/pyadr (ADR lifecycle CLI)](https://github.com/opinionated-digital-center/pyadr)

## Key Findings

### 1. The Nygard ADR template (verbatim field set)

Michael Nygard's 2011 article "Documenting Architecture Decisions" introduced a deliberately minimal, Alexandrian-pattern-style template with five fields:

- **Title** — short noun phrase, present-tense imperative is acceptable (e.g., "Use PostgreSQL for primary store"). Numbered sequentially within the project (`ADR-0001`, `ADR-0002`, ...).
- **Status** — one of: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded` (sometimes annotated `superseded by ADR-NNNN`). Status is the only mutable field on an accepted ADR.
- **Context** — "the forces at play, including technological, political, social, and project local." Describes the situation and constraints, not the decision. Should be value-neutral and observable — a reader who disagrees with the decision should still recognize the context as accurate.
- **Decision** — "our response to these forces." Stated in **full sentences, with active voice** (Nygard's exact phrasing: "We will..."). One ADR = one decision; do not bundle.
- **Consequences** — "the resulting context, after applying the decision. All consequences should be listed here, not just the 'positive' ones." Negative and neutral consequences are mandatory; an ADR with no negatives is suspect because every architectural decision has trade-offs.

### 2. Status lifecycle and immutability

The ADR pattern treats accepted records as **append-only**. You do not edit an accepted ADR to reflect a changed mind — you write a new ADR that supersedes it.

- `proposed` — under discussion, not yet binding. Pull request is the typical mechanism.
- `accepted` — merged and binding. The decision is in force from this point.
- `rejected` — proposed but explicitly rejected. Kept in the log so future readers can see what was considered and why it was not chosen.
- `deprecated` — the decision is no longer relevant (the system it governed was removed). Kept for history; no replacement.
- `superseded by ADR-NNNN` — a later ADR overrides this one. The old ADR's status changes to `superseded` and links forward; the new ADR links backward in its Context section ("This decision supersedes ADR-NNNN because...").

The append-only discipline is what makes ADRs valuable as a learning record: a reader can trace why a decision was made, why it was later overturned, and what new context drove the reversal. Editing in place destroys this audit trail.

### 3. When to write an ADR

Nygard's heuristic and the GitHub `adr.github.io` guidance converge on: write an ADR for any decision that is **architecturally significant** — one of these tests applies:

- The decision affects **non-functional requirements** (security, performance, scalability, availability, maintainability).
- The decision creates or removes a **dependency** between modules, services, or external systems.
- The decision establishes a **convention** that other developers must follow (naming, layering, data shape, error handling).
- The decision is **costly to reverse** — the choice locks in a vendor, a data shape, or a deployment topology.
- The decision involved **disagreement** during the discussion. Writing it down captures the chosen path AND the rejected alternatives, so the question does not get re-litigated by every new team member.

If a decision is trivially reversible and uncontested (e.g., a variable rename), an ADR is overhead. If it touches any of the above, it is undocumented architectural debt.

### 4. Linking ADRs

Two link directions are mandatory:

- **Forward link** (newer to older): when ADR-0010 supersedes ADR-0003, ADR-0010's Context section names ADR-0003 explicitly and explains what changed.
- **Backward link** (older to newer): ADR-0003's Status field is updated to `Superseded by ADR-0010`. This is the only edit ever made to an accepted ADR.

Some teams add a `Related` or `See also` field for non-supersession links — e.g., "ADR-0010 builds on the event-contract policy in ADR-0007" — without invalidating the linked ADR.

### 5. Storage conventions

Both Fowler and the ThoughtWorks Technology Radar emphasize that ADRs **must live in the source repository alongside the code they govern**, not in a wiki. Reasons:

- Diffs are reviewable through the same PR mechanism as code changes.
- The decision history travels with the codebase forever, even after platform/wiki migrations.
- The ADRs are versioned with the code they describe — if you check out an old branch, you see the decisions that were in force at that time.

The conventional location is `doc/adr/` or `docs/adr/` at the repository root. Files are named `NNNN-short-imperative-title.md` with a zero-padded sequential number.

### 6. Rationale section (extension to Nygard)

While Nygard's original template does not have a separate "Rationale" field, Fowler's bliki and the MADR template explicitly recommend an additional section that captures **the alternatives that were seriously considered and why each was rejected**. Three reasons:

- It surfaces the cost-benefit reasoning so a future reader can re-evaluate it against new context.
- It prevents the same alternatives from being re-proposed by new team members who do not know they were considered.
- It documents the **confidence level** of the decision — a decision made under high uncertainty should say so, with criteria that would trigger re-evaluation.

### 7. ADRs as a learning checklist

The act of writing an ADR is, per Fowler, **as valuable as the document itself**. The five-field template forces the decision-maker to:

1. Articulate the forces (Context) — exposes hidden assumptions.
2. State the decision in active voice (Decision) — forces commitment, no hedging.
3. List negative consequences (Consequences) — surfaces trade-offs the team can no longer pretend do not exist.

ThoughtWorks calls this "lightweight ADR as a thinking checklist" — the structure does the heavy lifting; the words are short.

### 8. Open-source ADR exemplars

Recognized examples cited by the joelparkerhenderson repository and the GitHub `actions/toolkit` README:

- **Arachne framework** — Nygard's own project, the original published ADR collection.
- **github.com/actions/toolkit** — uses ADRs for build/runtime decisions affecting multiple language packages.
- **Kubernetes Enhancement Proposals (KEPs)** — a heavyweight cousin of ADRs; same logic, more process.
- **Spring Cloud / Spring Framework** — uses ADRs for cross-module decisions.
- **Linkerd / Envoy** — service mesh projects use ADRs to track service-discovery and policy decisions.

The pattern across these projects is the same: ADRs are 1-3 pages, append-only, numbered, and live next to the code they govern.

### 9. ADRs in the advice process (Xapo, Fowler)

A more recent application: in decentralized architecture practice (Xapo Bank, scaled at ThoughtWorks clients), ADRs are the **deliverable of the advice process** — anyone can make a decision provided they consult the people affected and the recognized expertise, then write and publish an ADR. The ADR is the record of the consultation as much as the decision.

This shifts ADRs from "documentation we wish we had written" to "the artifact through which architectural authority is exercised in a flat organization." For the architectural-arbiter agent, this is the operational mode: arbitrations produce ADRs as the authoritative resolution of conflicts that cross agent boundaries.

## Architectural Implications for architectural-arbiter

The arbiter is a **producer of ADRs**, not just a consumer. When a cross-agent conflict requires a decision that no single domain agent can make alone, the arbiter writes an ADR that:

1. **Cites both conflicting recommendations verbatim** in the Context section, with file paths and the reviewing agents named.
2. **States the decision in active voice** in the Decision section — no hedging, no compromise language ("We will..." not "We could consider...").
3. **Lists the negative consequences for the losing side** in the Consequences section — what the deferred agent's domain loses, and how that loss will be tracked or mitigated.
4. **Links to prior ADRs** that established related precedent. If the new decision contradicts a prior ADR, the prior ADR's status flips to `Superseded by ADR-NNNN` and the new ADR explains the reversal in Context.
5. **Records confidence and re-evaluation triggers**. If the conflict was resolved on incomplete information, the ADR names the conditions under which the team should re-open the question.

ADRs produced by the arbiter live in `docs/recommendations/architectural-arbiter/{YYYY-MM-DD}-adr-{topic}.md`. Numbering must be sequential and global across the arbiter's output (not per-cycle). An accepted ADR is never edited; if a later cycle reverses it, that reversal is itself a new ADR with its own number.

## Domain Rule Additions for architectural-arbiter

- Every arbitration decision MUST be persisted as an ADR following the Nygard template (Title, Status, Context, Decision, Consequences). Free-form arbitration notes without this structure = MEDIUM (not actionable as precedent).
- ADRs MUST be numbered sequentially across the arbiter's entire history (`adr-0001`, `adr-0002`, ...); per-cycle or per-topic numbering = HIGH (precedent linking breaks).
- An ADR's Decision field MUST be stated in active voice, present tense, with subject "We" or the platform name. Hedging phrases ("it might be reasonable", "consider perhaps") = MEDIUM (decision is not binding).
- The Consequences field MUST list at least one negative consequence. A consequences section listing only benefits = HIGH (the trade-off is hidden, the losing agent has no traceable record of what was given up).
- An ADR that contradicts a prior ADR MUST update the prior ADR's Status to `Superseded by ADR-NNNN` AND the new ADR's Context MUST explain the reversal explicitly. Silent contradiction = CRITICAL (the precedent log is now inconsistent; future arbitrations will cite the wrong ADR).
- Accepted ADRs MUST NOT be edited in place. Any change of intent requires a new ADR that supersedes. In-place edit of an accepted ADR = CRITICAL (audit trail destroyed).
- ADRs MUST cite the specific reviewing agents and reports that produced the conflict, with file paths to the underlying review documents. Unsourced ADRs = HIGH (the decision cannot be re-grounded if challenged).
- When an arbitration cannot reach a decision within the agents' combined authority, the arbiter MUST produce an ADR with status `proposed` and an explicit "Escalation to human reviewer" section framing the open question. Silent escalation without a `proposed` ADR = HIGH (the question vanishes from the precedent log).
