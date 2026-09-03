# ADR-031: ARIA Snowball Continuous-Mode Meta-System

**Status:** Accepted as design history (2026-08-20 annotation) — the snowball branch was
archived; ARIA runs on main. Superseded operationally by ADR-035/040/041; the design record
stands.
**Date:** 2026-05-02
**Deciders:** Okan (operator)
**Owner:** Okan (operator) + future ARIA implementer if PoC gate passes
**Related ADRs:** ADR-011, ADR-012, ADR-014, ADR-015, ADR-030
**Related docs:** `docs/aria/SPEC.md`, `docs/aria/IDENTITY.md`, `docs/aria/CONTRACTS.md`, `.claude/knowledge/layer-1-aria.md`

---

## Context

The repository already has a mature PR-cycle review system: specialized Claude
Code agents, Nx affected gates, schema drift invariants, NATS cert identity
invariants, ADRs, and curated knowledge layers. That system is effective at
reviewing bounded changes, but it does not continuously watch for cross-layer
and cross-service drift that emerges while each individual PR still looks
locally consistent.

The operator wants a system that takes the shape of the repository it enters:
it should discover the repo's real contracts, record evidence, grow skills from
recurring pressure, retire weak skills, and propose improvements only after it
has enough grounded context. It must not become a generic prebuilt agent set
that imposes fixed boundaries on every repo.

## Decision

Evaluate ARIA Snowball on the `snowball` branch as a continuous-mode
meta-system, not as a replacement for the existing PR-cycle agent ecosystem.

The first committed implementation remains Phase-1 only: a zero-LLM mechanical
PoC under `tools/aria-poc/` that measures whether the repository has enough
cross-layer drift signal to justify building the real kernel. The PoC can walk
the repo, ingest trusted priors, compute a fingerprint, and detect selected
value-set drift across TypeScript, SQL migrations, and literal UI option
groups. It does not generate skills, open PRs, or mutate application code.

ARIA's future runtime shape, if the decision gate passes, is Claude Code CLI
mode: slash-command orchestration, local mechanical scripts, evidence logs, and
emergent `.claude/agents/aria-*` skills born from pressure. It must not import
the Anthropic SDK or require a separate API key.

## Consequences

- ARIA remains branch-scoped until the operator explicitly accepts the PoC
  decision gate. `snowball` is the evaluation branch; `main` is not touched by
  this ADR by default.
- The existing specialized agents remain authoritative for PR-cycle review.
  ARIA complements them by watching repo-wide and time-spanning patterns.
- No fixed ARIA skill set is committed up front. Skills are created only after
  repeated pressure shows that existing tooling and agents do not cover a real
  repo-specific gap.
- The kernel investment is deliberately blocked behind the PoC. If the PoC
  fails to surface novel, useful signal, ARIA stays as research artifacts.
- Any future ARIA action that modifies code must use isolated worktrees,
  baseline comparison, and human merge approval.

## Alternatives Considered

| Alternative | Reason rejected for this evaluation |
|---|---|
| Add a 39th specialized agent | Keeps the system PR-cycle bound and does not solve continuous cross-repo drift detection. |
| Standalone Python daemon with direct Anthropic SDK calls | Adds credential, budget, retry, and exfiltration surfaces that Claude Code CLI already controls. |
| Cron-only mechanical scripts | Useful for narrow gates, but no evidence memory, nuance protocol, skill lifecycle, or operator decision trail. |
| Build the full kernel immediately | Premature. The PoC must prove the value surface before months of implementation work. |

## Verification

During the `snowball` evaluation, the minimum verification is:

```bash
python3 -m unittest discover tools/aria-poc -p '*test*.py'
python3 tools/aria-poc/poc.py --workspace-root . --skip-nx-graph --fail-on-drifts 9999
```

The generated `.aria-poc/aria-poc-report.md` is the operator-facing decision
artifact. The `.aria-poc/` directory is runtime output and is not committed.

## Numbering Note

`docs/adr/_draft/031-nats-request-reply-pattern.md` already exists, but files
under `_draft/` are noncanonical. This file is the canonical `docs/adr/031-*`
record for the ARIA Snowball evaluation.
