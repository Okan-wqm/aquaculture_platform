# ARIA kernel budget — a gate the program named and nobody built (2026-10-04)

Context: the memory and repository-knowledge program, rev3.1, decision R3-D10 and "Şimdi" row 4:
ADR-0025 rewrites constraint K-4′ on a measured base, and the `kernel-budget.json` gate merges
before the first rev3-min kernel PR. Measured on `main @ 8cc79053b`.

Owner: claude (implementation), okan (decides the base; ADR-0025 is Proposed). Deadline
2026-10-11, ahead of rev3-min's first kernel PR.

## ARIA-MEDIUM-335

K-4′ caps ARIA kernel growth: gross non-test lines added under `aria-kernel/aria_kernel/`,
counted from the K1 merge commit, with net module count ≤ 0, credit only for merged deletions,
≤ 400 kernel lines per PR, and `docs/aria/policy/kernel-budget.json` as its CI gate (L3; an
overrun only with an ADR in the same PR). The policy file was never written and no workflow
measured the kernel, so the gate the constraint relies on did not exist, and the budget was
exceeded with nothing reporting it.

Measured from the K1 merge (`b28a5216a`, PR #1710) to `8cc79053b`, one row per first-parent
change, test files excluded:

| Change    | PR    |     Added |   Deleted |
| --------- | ----- | --------: | --------: |
| 9bf72a04d | #1723 |       536 |       206 |
| 3339e5655 | #1725 |       249 |        85 |
| a58a8f405 | #1729 |     1,293 |       421 |
| 57b6e1aca | #1728 |       347 |         9 |
| f76a06f30 | #1741 |     1,145 |       135 |
| 537fdfbbe | #1744 |       378 |         9 |
| 63fe52c36 | #1730 |       168 |        34 |
| 8a33bda79 | #1749 |        61 |        47 |
| 2ef27ddcb | #1734 |       208 |        59 |
| fc9c3be87 | #1732 |       399 |       115 |
| **total** |       | **4,784** | **1,120** |

No change deleted more than it added, so no change earns deletion credit: the measure is 4,784
against the plan's 4,500. Three changes exceed the per-PR cap (#1729, #1741, #1723). The kernel
module count is 362 at both ends. Twelve open PRs touch kernel source for another 3,108 gross
lines; four of them exceed 400 lines (#1766 560, #1731 454, #1739 420, #1733 405) and two add
modules (#1756 +2, #1766 +2).

The plan's rev3.1 figures (about 2.4k merged, about 3.9k open) were a 2026-10-03 snapshot.
#1730, #1732, #1734, #1741, #1744 and #1749 merged after it, and #1753, #1755, #1756, #1759 and
#1766 opened after it.

Evidence:

- `docs/aria/policy/` (no `kernel-budget.json` on main at 8cc79053b)
- `.github/workflows/aria-kernel.yml:162` (the `lane` job, which every kernel PR needs green, runs
  no kernel-size measurement)
- `aria-kernel/aria_kernel/` (first-parent numstat from `b28a5216a` to `8cc79053b`: the table
  above; ADR-0025 lists the exact commands)

Rule: a budget the program declares as a CI gate is enforced by a gate that runs on every kernel
PR and on main. Its ceiling is a measured number, and only an ADR in the same PR raises it.

Fix: ADR-0025 (Proposed) sets the ceiling on the measured base. `docs/aria/policy/kernel-budget.json`
records it, and `tools/gates/kernel-budget.ts` enforces it in the `lane` job of
`aria-kernel.yml`.

Not covered here: the ceiling is the operator's decision. ADR-0025 lists the alternatives
(holding the plan's 4,500 turns main red on the first run).
