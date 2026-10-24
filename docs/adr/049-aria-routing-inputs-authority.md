# ADR-049 — ARIA routing inputs (`.claude/shared/**`) join the derived authority set and CODEOWNERS

- **Status:** Accepted — architectural-arbiter ruling 2026-10-24 (APPROVE WITH CONDITIONS), at
  `feat/aria-se2-one-path-agent-map` 853aa1dcf. The routing inputs
  (`agent_routing.ROUTING_INPUT_DIR`, the whole `.claude/shared/` directory including files a change
  adds) are members of `self_improvement.derived_authority_set` through `ROUTING_INPUT_MEMBERS`,
  with no hand entry in `implementation_safety._IMPLEMENTER_READONLY_ANCHORS`. They reach
  `readonly_paths()`, the merge perimeter and the self-change judges by derivation, and
  `.github/CODEOWNERS` owns `.claude/shared/`. A routing row names no `_maintenance` or writer agent
  (owner: `surface_manifest_validator.validate_maintenance_agent_isolation`). This meets the
  `implementation_safety.py` perimeter rule; the invariant amendment is
  `aria-kernel/tests/invariants/test_routing_inputs_authority.py` and
  `test_path_agent_map_single_owner.py`. It extends the perimeter of arbiter ADR-0003 and ADR-0023
  and supersedes neither. Removing the routing inputs from the set requires a superseding ADR,
  arbiter approval and an invariant amendment. This ruling does not ratify the primary-owner
  reassignments in the same diff (ARIA-HIGH-874). Tracked: ARIA-MEDIUM-854, ARIA-HIGH-874,
  ARIA-MEDIUM-875.
- **Date:** 2026-10-24
- **Owner:** platform operator + ARIA kernel
- **Tracking:** `docs/reviews/claude/2026-10-21-aria-quality-learning-program.md#ARIA-HIGH-767`
  (service-expertise package SE-2, review item SK-01)
- **Relates to:** ADR-031/033/035/036 (ARIA), ADR-041 (narrow autonomous-merge lane), PLAN-v2 B1
  (the derived authority set)
- **Numbering:** 048 is taken by `048-suderra-os-edge-agent-integration-contract.md` on an open
  branch, so this record takes 049.

## Context

The implementer perimeter rule sits in `aria-kernel/aria_kernel/implementation_safety.py`, in the
comment above `_IMPLEMENTER_READONLY_ANCHORS`: _"Adding/removing a path = ADR + arbiter approval +
invariant amendment."_ The SE-2 package adds a path to that perimeter, so it needs this record.

SE-2 makes `.claude/shared/orchestrator-routing-table.md` the **one** path-to-Lane-A-agent map. The
kernel reads it only through `agent_routing.load_routing_table` / `recommended_agents_for_project` /
`reviewing_agents_for_paths`, with the path set by `agent_routing.ROUTING_INPUT_DIR` and
`ROUTING_TABLE_REL`. SE-2 deletes the other two answers:
`specialist_review_runner._DOMAIN_TOUCH_MAP` and the frontmatter `scope_globs` relatedness in
`agent_priors`.

Since that change, the table also picks the **merge-time expert reviewers of ARIA's own
implementation PRs**: Gate C (`specialist_review_runner.select_specialist_agents`) and
`expert_review_gate`. Owner decision Q12 keeps this review as a separate concept. Before SE-2,
nothing guarded the table:

- it was outside `self_improvement.derived_authority_set`, so neither the implementer room
  (`implementation_safety.readonly_paths()`) nor the merge perimeter (hard-fail checks
  `forbidden_scope_normalized` and `readonly_paths_untouched_at_merge`) refused an ARIA-authored
  edit to it;
- `.github/CODEOWNERS` named no owner for `.claude/shared/`.

As a result, one ARIA change could edit the table and choose its own reviewers in the same PR.

## Decision

1. **The routing inputs are members of the derived authority set.**
   `self_improvement.ROUTING_INPUT_MEMBERS = (f"{ROUTING_INPUT_DIR}**",)` is a named member of
   `declared_authority_members()`, and so of `derived_authority_set()` / `kernel_authority_set()`.
   It names the owner's constant and holds no copy of the path. The whole directory joins. That
   includes the review-contract fragments that sit beside the table and any file a change **adds**
   there, because the kernel's routing input is whatever lives under that directory.
2. **No hand entry.** `_IMPLEMENTER_READONLY_ANCHORS` gains nothing. B1 derives the implementer
   perimeter (`readonly_paths()`), the merge perimeter and the self-change judges from the one set,
   so the routing inputs reach all of them through the derivation. A second hand list is the drift
   B1 removed.
3. **CODEOWNERS owns the directory.** `.github/CODEOWNERS` carries a `.claude/shared/` rule. Every
   member of the derived set must have an owner there.
4. **What a routing row may name.** A routing row names only reviewers. It never names, as primary
   or also-notify, an agent under `.claude/agents/_maintenance/` or a writer agent (its `tools:`
   include a file-editing tool, `runtime_profiles.FILE_WRITE_TOOLS`). The rule's one owner is
   `surface_manifest_validator` `validate_maintenance_agent_isolation` (Layer 6).

## Enforcement (invariant amendment)

| Invariant                                                                                                       | What it pins                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aria-kernel/tests/invariants/test_routing_inputs_authority.py`                                                 | `ROUTING_TABLE_REL` and every path under `.claude/shared/`, including a probe a change could add, are in `kernel_authority_set()`. Both the pre-PR-open scope gate and the merge perimeter refuse them. CODEOWNERS owns them. No hand anchor covers them.                                 |
| `aria-kernel/tests/test_derived_authority_set.py`                                                               | The derived set as a whole (B1). `test_codeowners_covers_every_member` and `test_codeowners_names_an_owner_for_every_named_member_and_authority_surface` require a CODEOWNERS owner for every member.                                                                                     |
| `aria-kernel/tests/invariants/test_path_agent_map_single_owner.py`                                              | No path-to-agent table in `aria_kernel` and no kernel routing reads `scope_globs`. The reviewer set derived per surface equals the Q4 literal, and nothing the deleted touch map named drops. No routing row names a `_maintenance` or writer agent (Layer 6, proved on a fixture first). |
| `tests/invariants/orchestrator-routing-coverage.spec.ts`, `tests/invariants/agent-ownership-uniqueness.spec.ts` | Every required repo surface has a routing row, and no glob has two primary agents.                                                                                                                                                                                                        |

## Consequences

- An ARIA-authored change cannot edit, add or remove any file under `.claude/shared/`. CODEOWNERS
  places `.claude/shared/` in ARIA's human-merge lane (risk policy L3); GitHub requires no
  code-owner review on `main`, so server-side review of human changes remains the operator's open
  decision (INFRA-MEDIUM-197; HL safety review X1).
- Gate C reads the routing table from the workspace under review. No ARIA PR can change a routing
  input, so that table is always the base table, and a PR can neither widen nor narrow its own
  merge-time reviewer set.
- Removing the routing inputs from the set again needs this ADR to be superseded, plus arbiter
  approval and an amendment of the invariants above (the `implementation_safety.py` rule).

## Alternatives considered

- **Add `.claude/shared/` to `_IMPLEMENTER_READONLY_ANCHORS` by hand.** Rejected. It guards only the
  implementer room, and the merge perimeter and the self-change judges read the derived set. It
  would also be a second list of authority paths beside B1's one function.
- **Guard only `orchestrator-routing-table.md`.** Rejected. The owner reads its routing input from
  the directory, and a file added beside the table, or a renamed table, would sit outside the guard.
