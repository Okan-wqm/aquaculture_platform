# ADR-050 — Routing-table ownership of agent, knowledge, skill and research paths

- **Status:** Accepted — operator ratification 2026-10-25. Ratified on 2026-10-25 by the operator on
  duty (session takeover), in answer to the program lead's question; Okan may revisit it. The
  question offered three answers (ratify / revert / leave to Okan) and named the arbiter's conflict
  of interest below; the recorded answer was "Onayla (Önerilen)" (ratify).
- **Date:** 2026-10-25
- **Owner:** platform operator
- **Tracking:** `docs/reviews/claude/2026-10-24-aria-se2-arbiter-ruling.md#ARIA-HIGH-874`
  (arbiter finding ARCH-HIGH-001), `docs/reviews/claude/2026-10-21-aria-quality-learning-program.md#ARIA-LOW-856`
- **Relates to:** ADR-049 (routing inputs join the derived authority set). ADR-049 covers who may
  edit the routing table; this record covers the owners the table names.

## Context

`.claude/shared/orchestrator-routing-table.md` is the one path-to-reviewer map (SE-2, ADR-049).
Commit 8e18aeb7b ("writer and maintenance agents are never reviewers in the routing table")
removed every writer and `_maintenance` agent from the table's primary and also-notify cells. A
writer named as reviewer would review its own output. To do that, the commit gave the affected
rows new primary owners.

The architectural-arbiter ruled on ADR-049 on 2026-10-24 (APPROVE WITH CONDITIONS) and did not
ratify these reassignments (ARCH-HIGH-001). The arbiter could not rule on them because of a
conflict of interest: the same diff makes the arbiter the primary reviewer of
`.claude/shared/**`, the directory that holds the table naming the arbiter. A primary-owner change
is an ownership decision. It needs a record of its own, and someone outside the change has to
ratify it. For this change that person is the operator.

## Decision

We ratify the following primary owners and also-notify changes made in 8e18aeb7b.
Row numbers refer to the table at 8e18aeb7b.

### Ratified rows

| Glob(s)                                     | Row | Primary before        | Primary after         | Also-notify change                                      |
| ------------------------------------------- | --- | --------------------- | --------------------- | ------------------------------------------------------- |
| `.claude/agents/*.md`                       | 70  | prompt-writer         | architectural-arbiter | dropped the "maintenance-only" note                     |
| `docs/research/**`                          | 91  | prompt-writer         | architectural-arbiter | none                                                    |
| `.claude/knowledge/**`, `.claude/shared/**` | 94  | prompt-writer         | architectural-arbiter | architectural-arbiter moves from also-notify to primary |
| `.claude/skills/**`                         | 96  | prompt-writer         | architectural-arbiter | implementation-planner dropped                          |
| `apps/*/src/gdpr/**`                        | 102 | gdpr-erasure-executor | compliance-expert     | compliance-expert moves from also-notify to primary     |
| `docs/adr/**`                               | 88  | architectural-arbiter | architectural-arbiter | prompt-writer dropped                                   |
| `CLAUDE.md`                                 | 101 | architectural-arbiter | architectural-arbiter | prompt-writer dropped                                   |

1. **The table is the one owner of "who reviews a path".** Agent prompts do not restate a
   different owner for these rows. `orchestrator.md`'s roster points at the table for the
   arbiter's rows. `legal-hold-auditor.md` names no owner for the destructive paths it
   secondary-reviews. `gdpr-erasure-executor.md` writes the `apps/*/src/gdpr/**` handlers and
   reviews none of them. `operating-modes.md` no longer gives prompt-writer a CATCHER role on agent
   prompts.
2. **Writers stay out of reviewer sets.** The Tier-1 profile gate
   (`specialist_review_runner._TIER_1_SPECIALISTS`) loses `gdpr-erasure-executor` and
   `security-architecture-writer`. The gate only strips or orders reviewers that the table and the
   cross-cutting set select, and those never include a writer, so the two entries had no effect.
3. **The arbiter does not ratify a change to its own rows.** A diff that adds, removes or changes
   a routing row whose primary or also-notify cell names architectural-arbiter goes to the
   operator for ratification. The arbiter may rule on such a diff only as `proposed`.

## Enforcement

| Invariant                                                          | What it pins                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/invariants/agent-ownership-uniqueness.spec.ts`              | Every row in _Ratified rows_ has the same primary in the routing table, and no agent prompt claims an untagged primary on one of those globs for a different agent. A later primary change has to supersede this ADR. |
| `aria-kernel/tests/invariants/test_path_agent_map_single_owner.py` | No agent prompt names a writer agent (`runtime_profiles.FILE_WRITE_TOOLS`) as `primary`, and the Tier-1 gate holds no writer or `_maintenance` agent. Both checks run on a fixture first.                             |

## Consequences

- prompt-writer loses its review role on agent prompts, knowledge, skills and research. Its
  CATCHER pass on a prompt diff no longer runs, so the arbiter reviews those diffs alone, and the
  arbiter is a meta reviewer of reviews, not a prompt-craft specialist.
- gdpr-erasure-executor no longer reviews the erasure handlers it writes. compliance-expert now
  reviews them on every change, which costs one more reviewer dispatch per change.
- The arbiter now reviews the table that names it. Decision 3 removes the self-ratification, but
  the arbiter still reviews routing diffs that name it, and only the operator gate stops it from
  approving its own scope.
- `supply-chain-auditor.md` claims primary on `package.json` and `Cargo.toml`, which the table
  gives to infra-expert and edge-expert. Those rows are not in this record, and the drift is
  reported for its own finding. The routing-exemption rows (`aria-kernel/**`, `tools/aria-*/**`)
  stay under ARIA-MEDIUM-875.

## Alternatives considered

- **Revert to the pre-SE-2 owners.** Rejected. It would name writer and maintenance agents as
  reviewers again, which breaks the Layer 6 rule (`validate_maintenance_agent_isolation`) and lets
  an author review its own output.
- **Let the arbiter ratify its own rows.** Rejected because of the conflict of interest. The
  arbiter's ruling on ADR-049 declined to ratify for that reason.
- **Leave the decision to Okan.** Not taken. The operator on duty answered the question as asked,
  and Okan can revisit the decision with a superseding ADR.
