# ARIA SE-2 — architectural-arbiter ruling on ADR-049 (2026-10-24)

The architectural-arbiter ruled on ADR-049 at `feat/aria-se2-one-path-agent-map` `853aa1dcf`:
APPROVE WITH CONDITIONS. The ruling approves the decision (the routing inputs join the derived
authority set and CODEOWNERS) and does not ratify the routing-table primary-owner reassignments
made in the same diff. It raised the two findings below, registered under the program's ARIA IDs.

## ARIA-HIGH-874

The SE-2 diff moves routing-table primary owners without a ratified ownership record. Rows 70, 94,
96 and 91 (`.claude/agents/*.md`; `.claude/knowledge/**` with `.claude/shared/**`;
`.claude/skills/**`; `docs/research/**`) move from prompt-writer to architectural-arbiter. Row 102
(`apps/*/src/gdpr/**`) moves from gdpr-erasure-executor to compliance-expert, which matches
`compliance-expert.md:37`. prompt-writer is dropped from also-notify on rows 88 and 101.
`orchestrator.md:91` still describes the arbiter's scope as `docs/reviews/*/` plus source. The
arbiter cannot ratify these moves: the diff makes it primary of `.claude/shared/**` (conflict of
interest), so the operator ratifies them.

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: architectural-arbiter ruling on ADR-049, 2026-10-24 (ARCH-HIGH-001), at `853aa1dcf`.
- Evidence:
  - `.claude/shared/orchestrator-routing-table.md:70`
  - `.claude/shared/orchestrator-routing-table.md:88`
  - `.claude/shared/orchestrator-routing-table.md:91`
  - `.claude/shared/orchestrator-routing-table.md:94`
  - `.claude/shared/orchestrator-routing-table.md:96`
  - `.claude/shared/orchestrator-routing-table.md:101`
  - `.claude/shared/orchestrator-routing-table.md:102`
  - `.claude/agents/orchestrator.md:91`
  - `.claude/agents/compliance-expert.md:37`
  - `.claude/agents/legal-hold-auditor.md:37`
- Rule: A change of a routing row's primary owner is an ownership decision, recorded and ratified
  before it lands; the arbiter does not ratify a diff that makes it primary of the routing inputs.
- Close: A separate ownership ADR ratified by the operator, plus prompt-writer updates to
  `orchestrator.md:91`, `architectural-arbiter.md` and `legal-hold-auditor.md:37` (ARIA-LOW-856).

## ARIA-MEDIUM-875

Rows `aria-kernel/**`, `tools/aria-poc/**` and `tools/aria-adapters/**` (table:98-100) name no
Lane-A primary (`*ARIA lane — no Lane-A primary*`). That contradicts the table's own rule
(table:129) and `orchestrator.md:40`: every changed file maps to at least one primary agent. The
roster check in `orchestrator-routing-coverage.spec.ts:194-205` selects `orchestrator.md`'s
Phase 1 section (`:38-44`) first and never parses the table's primary cells, so it does not see
the gap.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: architectural-arbiter ruling on ADR-049, 2026-10-24 (ARCH-MEDIUM-002), at
  `853aa1dcf`.
- Evidence:
  - `.claude/shared/orchestrator-routing-table.md:98-100`
  - `.claude/shared/orchestrator-routing-table.md:129`
  - `.claude/agents/orchestrator.md:38-44`
  - `tests/invariants/orchestrator-routing-coverage.spec.ts:194-205`
- Rule: One rule per concept: a routing exemption is declared by one marker that the coverage
  check reads, and the roster check parses the table it guards.
- Close: An explicit ARIA-lane exemption expressed by one marker, plus a roster check that parses
  the table.
