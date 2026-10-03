# ARIA request surface — `gap_finding`, a role nothing mints, waived under an id no store holds (2026-10-03)

Context: the memory and repository-knowledge program, rev3.1, "Şimdi" row 5 (attack report
ARCH-MINOR-012): the `gap_finding` waiver expires on 2026-10-16, and the decision is to delete the
role; blind enumeration (K42) re-adds a role only when its evidence trigger fires. Read on
`main @ 4ce31871d`.

Owner: claude (implementation), okan (review). Deadline 2026-10-16, the waiver's expiry.

## ORPHAN-MEDIUM-835

`gap_finding` is a member of `agent_surface.REQUEST_ROLES` that no kernel path mints. A request can
name it, the strict validators accept it, and nothing produces or dispatches it; the acceptance-lane
gap hunt it describes runs as an operator-driven dispatch outside the kernel. It carries a 0.40
context-budget cap of its own, and `surface-reachability.unwritten.json` waives it until 2026-10-16
under `ORPHAN-MEDIUM-688`.

That id is held by neither store the commit-msg gate reads: `docs/reviews/orphan-findings.md` has
no such heading and the registry has no such row. Sequence 688 belongs to `ORPHAN-HIGH-688`
(RESOLVED), the E9 change that added the surface-reachability gate itself. A `Closes:` trailer naming
`ORPHAN-MEDIUM-688` is refused by the gate, so the waiver pointed at work no record tracked.

Evidence:

- `aria-kernel/aria_kernel/agent_surface.py:26` (`gap_finding` in `REQUEST_ROLES`)
- `aria-kernel/aria_kernel/context_budget_gate.py:105` (its 0.40 cap)
- `aria-kernel/surface-reachability.unwritten.json:9` (the waiver: expires 2026-10-16,
  `finding_id` `ORPHAN-MEDIUM-688`)
- `aria-kernel/tests/test_surface_reachability.py:209` (the CLI-passthrough canary is
  `gap_finding`)
- `docs/reviews/orphan-findings.md:9745` (`ORPHAN-HIGH-688`, the resolved finding sequence 688
  belongs to)

No ledger row on `origin/aria/state @ f82569371` names the role (every `*.jsonl` scanned for a
`role` field equal to `gap_finding`; the one textual hit is an agent transcript quoting
`agent_surface.py`), so removing it from the closed set leaves recorded history parseable.

Rule: every role on the request surface has a production minter, or it is removed; a waiver for an
unwritten member names a finding a store holds.

Not covered here: `gap_closure` has the same shape and the same `ORPHAN-MEDIUM-688` waiver, also
expiring 2026-10-16; the program's decision names only `gap_finding`.
