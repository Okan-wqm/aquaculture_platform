# ARIA SE-2-ADR — non-blocking review findings (2026-10-24)

The SE-2-ADR package applied the architectural-arbiter ruling on ADR-049 (the C1 code fix for
ARIA-LOW-858, the C2 wording and the Accepted status). Review round 1, security and ssot lenses,
at `e71cfabc8`, found no blocker and made five non-blocking points. This file registers them as
four findings: the two points about the unrecorded `forbidden_scope_normalized` deviation are one
finding. Each evidence line was re-read at `e71cfabc8`. One line number moved: the review cited
`merge_authority.py:929` for the `merge-base` call, and it is on line 930.

## ARIA-LOW-876

The comment in `request_implementation_expert_reviews` and the second Consequences bullet of
ADR-049 say the routing table the claim-time panel is chosen from is "the base's". It is the table
at the fork point, `merge-base(live_base, head)`: `_evaluate_pre_merge_perimeter` sets `base_sha`
to that merge-base, shapes the workspace at the PR head, and judges the changed paths against it.
The table is committed on main, so a PR still cannot choose its own reviewers. But a routing-table
change that lands on main after the fork does not apply to the claim-time panel of a PR that has
not been updated.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-ADR review round 1, security lens non-blocking item 1; non-blocking, registered
  by the SE-2-ADR findings clerk. The SE-2 branch (`feat/aria-se2-one-path-agent-map`) is not held
  on it.
- Evidence:
  - `aria-kernel/aria_kernel/expert_review_gate.py:181-185`
  - `aria-kernel/aria_kernel/merge_authority.py:930`
  - `aria-kernel/aria_kernel/merge_authority.py:938`
  - `aria-kernel/aria_kernel/merge_authority.py:1083`
  - `docs/adr/049-aria-routing-inputs-authority.md:87-89`
- Verified: Re-read at e71cfabc8: `expert_review_gate.py:184` reads "the table read here is the
  base's"; `merge_authority.py:930` sets `base_sha` to `merge-base(live_base_sha, head_sha)`;
  `:1083` joins `merged_paths` against `merge_base_sha`.
- Rule: A claim in a comment or an ADR holds for every path that reaches the code it describes; a
  table named "the base's" is the table at the base the code reads it from.
- Close: `expert_review_gate.py:181-185` and ADR-049 Consequences (`:87-89`) say the table is the
  fork-point table, committed on main, and that a routing change landing on main after the fork
  applies to the claim-time panel only once the PR is updated; or the panel is chosen from the
  live base's table, with a test that a routing change on main after the fork is used. The ADR
  edit may share the Consequences bullet with ARIA-LOW-878.

## ARIA-LOW-877

The ARIA-LOW-858 fix (`64007eb28`) leaves `forbidden_scope_normalized` out of
`REVIEW_PANEL_REQUIRED_CHECKS`, which both the arbiter's C1 preferred fix and the finding's Close
line name. The reason is sound: it is a pre-PR-open check, the report
`request_implementation_expert_reviews` receives is the `GATE_PRE_MERGE` one, so the name never
passes there and requiring it would refuse every request. A test pins that every required name is
a pre-merge check. The reason is written in the code comment and the test, and in the commit
message. It is not in ADR-049, in the arbiter-ruling review file, or in the ARIA-LOW-858 section,
so an audit of the `Closes:` trailer against the literal Close line will flag it.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-ADR review round 1, security lens non-blocking item 2 and ssot lens non-blocking
  item 1, merged because both name the same deviation; non-blocking, registered by the SE-2-ADR
  findings clerk. The SE-2 branch is not held on it.
- Evidence:
  - `aria-kernel/aria_kernel/expert_review_gate.py:113-127`
  - `aria-kernel/tests/test_expert_review_gate.py:286-292`
  - `docs/adr/049-aria-routing-inputs-authority.md:3-17`
  - `docs/reviews/claude/2026-10-21-aria-quality-learning-program.md:1747-1750`
- Verified: Re-read at e71cfabc8: `implementation_safety.py:3601-3605` registers
  `forbidden_scope_normalized` at `GATE_PRE_PR_OPEN`; the ADR-049 Status block (`:3-17`) records
  the ruling and C2 but says nothing of this; the Close line at `:1747-1750` still names
  `forbidden_scope_normalized`.
- Rule: A deviation from a ruling's preferred fix is recorded where the ruling and the finding it
  closes are read, not only in a commit message.
- Close: ADR-049 records that C1 was met with `readonly_paths_untouched_at_merge` alone and why
  `forbidden_scope_normalized` is not required (its merge-time counterpart covers the same paths
  and path escapes), and the ARIA-LOW-858 section carries the same note, so the `Closes:` trailer
  of `64007eb28` reads true against the section.

## ARIA-LOW-878

The ADR-049 Consequences bullet that the ARIA-LOW-858 fix made true reads "Gate C reads the routing
table from the workspace under review". It does not name the claim-time panel,
`expert_review_gate.request_implementation_expert_reviews`, which is where ARIA-LOW-858 was. The
test that pins the guarantee, `ReviewPanelReadsOnlyAnUneditedTableTests` in
`test_expert_review_gate.py`, is also missing from the Enforcement table. The Context section does
name `expert_review_gate` beside Gate C.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-ADR review round 1, ssot lens non-blocking item 2; non-blocking, registered by
  the SE-2-ADR findings clerk. The SE-2 branch is not held on it.
- Evidence:
  - `docs/adr/049-aria-routing-inputs-authority.md:87-89`
  - `docs/adr/049-aria-routing-inputs-authority.md:74-80`
  - `aria-kernel/aria_kernel/expert_review_gate.py:185`
  - `aria-kernel/tests/test_expert_review_gate.py:213`
- Verified: Re-read at e71cfabc8: the Enforcement table (`:74-80`) has no row for
  `aria-kernel/tests/test_expert_review_gate.py`; the class is at `test_expert_review_gate.py:213`
  and `test_every_required_check_is_one_the_claim_time_report_carries` is at `:286`.
- Rule: An ADR's Consequences name every reader its guarantee covers, and its Enforcement table
  lists every test that pins the guarantee (the document and the gate stay one concept).
- Close: The Consequences bullet names `expert_review_gate.request_implementation_expert_reviews`
  beside Gate C and the check that makes it hold (`readonly_paths_untouched_at_merge` in
  `REVIEW_PANEL_REQUIRED_CHECKS`), and the Enforcement table has a row for
  `test_expert_review_gate.py` with the two tests. The ADR edit may share the Consequences bullet
  with ARIA-LOW-876.

## ARIA-LOW-879

A comment in `test_existing_agent_extension_recorded_as_audit` says the test "isolates the hook
routing logic from related_agents_for_paths detection". SE-2 deleted `related_agents_for_paths`.
The relatedness detection now goes through `agent_routing.reviewing_agents_for_paths` in
`capability_gap`. `test_path_agent_map_single_owner.py` names the old function on purpose, in
`_DELETED_NAMES`, to pin that it stays deleted.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-ADR review round 1, ssot lens non-blocking item 3; non-blocking, registered by
  the SE-2-ADR findings clerk. The SE-2 branch is not held on it.
- Evidence:
  - `aria-kernel/tests/test_phase4_1_genesis_hook.py:103`
  - `aria-kernel/aria_kernel/capability_gap.py:300`
- Verified: Re-read at e71cfabc8: a grep of `aria-kernel/aria_kernel` finds no
  `related_agents_for_paths`; `capability_gap.py:300` calls `reviewing_agents_for_paths`.
- Rule: A comment names code that exists; the one path-to-agent map is `agent_routing`, and a
  deleted function is not described as a live step.
- Close: The comment at `test_phase4_1_genesis_hook.py:103` names the current relatedness step
  (`capability_gap` detection through `agent_routing.reviewing_agents_for_paths`), or states the
  isolation without naming a function. A grep of `related_agents_for_paths` under
  `aria-kernel/tests` then finds only the invariant's deliberate mentions.
