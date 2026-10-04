# ADR-0025 — The ARIA Kernel Budget Starts From a Measured Base

**Status:** proposed (the operator, Okan, decides the base and the ceiling)
**Date:** 2026-10-04
**Owner:** okan
**Decision deadline:** before rev3-min's first kernel PR merges (program rev3.1, R3-D10); target
2026-10-11
**Resolves:** program plan rev3.1 decision R3-D10 and "Şimdi" row 4 (ADR-0025 rewrites constraint
K-4′ on the measured base)
**Finding reference:** docs/reviews/claude/2026-10-04-aria-kernel-budget-gate.md#ARIA-MEDIUM-335
**Plan reference:** `/root/.claude/plans/crystalline-purring-hare.md` K-4′ (rev2), rev3.1
"Değişen gerçekler" and R3-D10
**Related:** ADR-0024 is reserved for the refutation protocol and is written only when its trigger
fires (R3-D10). ADR-0021's rule of one decision per ADR applies here as well.

## Context

Constraint K-4′ of the ARIA memory and repository-knowledge program caps kernel growth:

- the measure is gross added non-test lines under `aria-kernel/aria_kernel/`, counted from a
  fixed base SHA, the K1 merge commit; the ceiling is ≤ 4.5k (A ≤ 2.4k, B ≤ 0.6k, C–F ≤ 1.5k);
- the net module count is ≤ 0; deletions earn credit only once merged; a PR adds ≤ 400 kernel
  lines;
- the CI gate is `docs/aria/policy/kernel-budget.json` (L3), and an overrun is allowed only with
  an ADR in the same PR;
- K1 itself (+1,947) predates the program and is recorded as an exception.

The architectural arbiter's program review (ruling 10, "budget gap") asked for exactly this
shape. Its SRE review measured K1 alone at +4,017/−686 lines on its branch, +1,947 of them kernel
source, which already conflicts with both the per-PR cap and the C–F share of the ceiling.

**What happened.** The policy file was never written and nothing measured the kernel. The gate
K-4′ depends on did not exist, and the budget was exceeded with nothing reporting it.
Program rev3.1 records this rather than hiding it ("Kernel bütçesi rev3'ten ÖNCE aşıldı … kapı
hiç koşmuyor"), and so does this ADR. Its figures (about 2.4k merged, about 3.9k open, #1729
alone +1,293) were a 2026-10-03 snapshot. Measured on 2026-10-04 at `main @ 8cc79053b`:

- **K1**: PR #1710, merge `b28a5216ac3a672ecb82c3f74d70a56405977c0d`, +1,947/−358 kernel source
  lines against its first parent.
- **Merged since K1**: 10 changes, +4,784/−1,120 non-test kernel lines. No change deleted more
  than it added, so the measure is 4,784, over the plan's 4,500 ceiling. The kernel module count
  is 362 at the base and at main (net 0). Three changes exceed the per-PR cap: #1729 +1,293,
  #1741 +1,145 and #1723 +536.
- **Open PRs touching kernel source**: 12, +3,108 gross. Four exceed 400 lines (#1766 560,
  #1731 454, #1739 420, #1733 405). Two add modules (#1756 +2, #1766 +2).
- **rev3-min**: the rev3.1 "Şimdi" table's own estimates for the kernel rows not yet open are the
  lesson reader (~80), the citation check (~80), the quota ceiling (~120), red_today/K35-lite
  (~180), the CB-4 pre-merge check (~150) and K40-lite (~200): **810**. R3-D10 rounds this to
  ≈0.9k. Row 3's K10 is #1738 (open, counted above), and row 5 is a deletion.

| PR        | Branch                                     | Head measured |     Added | Deleted | Modules |
| --------- | ------------------------------------------ | ------------- | --------: | ------: | ------: |
| #1563     | `f0-g/security-preflight`                  | edcf932a1     |         1 |       0 |       0 |
| #1569     | `feat/suderra-session-20260917`            | cc65fa4bd     |        16 |     126 |       0 |
| #1629     | `claude/wonderful-archimedes-msrlg9`       | 52fff6690     |        19 |       0 |       0 |
| #1731     | `fix/aria-plans-only-with-admissible-refs` | 8c33ad2a9     |       454 |     164 |       0 |
| #1733     | `fix/aria-closable-backlog-cap`            | 0a527cf41     |       405 |      78 |       0 |
| #1738     | `fix/aria-agent-eval-real-mode`            | 3699f9d11     |       400 |     127 |       0 |
| #1739     | `fix/aria-tool-output-content-addressed`   | 6be84c9e7     |       420 |      76 |       0 |
| #1753     | `fix/aria-main-anchor-root-owned-checkout` | c5a9bd7fc     |       128 |       1 |       0 |
| #1755     | `fix/aria-agents-work-in-english`          | 83a703c65     |         9 |       0 |       0 |
| #1756     | `feat/aria-system-one-core-v2`             | d38079917     |       400 |       0 |      +2 |
| #1759     | `fix/aria-finding-identity-lifecycle`      | 3e283a81b     |       296 |     104 |       0 |
| #1766     | `fix/aria-judgment-precision`              | f196d89b8     |       560 |      50 |      +2 |
| **total** |                                            |               | **3,108** | **726** |  **+4** |

Each PR is measured against its own merge base with `main @ 8cc79053b`.

### How the numbers were produced

Kernel source is a file under `aria-kernel/aria_kernel/` outside any `tests/` or `test/`
directory whose name is not `test_*.py`, `*_test.py` or `conftest.py`. A module is a
kernel-source `*.py` file. The gate applies the same predicate (`isKernelSource` in
`tools/gates/kernel-budget.ts`).

```bash
B=b28a5216ac3a672ecb82c3f74d70a56405977c0d   # K1 merge, PR #1710
M=8cc79053bb0f8fc1133896fe438ef0171550797c   # main measured
# K1 itself, against its first parent
git diff --no-renames --numstat "$B^1" "$B" -- aria-kernel/aria_kernel/
# merged since K1, one numstat block per first-parent change
git log --first-parent --diff-merges=first-parent --no-renames --numstat \
  --format='@@%h %s' "$B..$M" -- aria-kernel/aria_kernel/
# module count at both ends
git ls-tree -r --name-only "$B" -- aria-kernel/aria_kernel/ | grep -c '\.py$'
git ls-tree -r --name-only "$M" -- aria-kernel/aria_kernel/ | grep -c '\.py$'
# open PRs touching kernel source
env -u GH_TOKEN -u GITHUB_TOKEN gh pr list --state open --limit 200 \
  --json number,headRefName,headRefOid,files \
  --jq '.[] | select(any(.files[]; .path|startswith("aria-kernel/aria_kernel/")))'
# each open PR against its merge base
git fetch origin "+pull/$N/head:refs/remotes/origin/pr/$N"
git diff --no-renames --numstat "$(git merge-base "$M" origin/pr/$N)" origin/pr/$N -- aria-kernel/aria_kernel/
# the same numbers, from the gate itself
npm run gates:kernel-budget -- --base-ref "$M" --head "$M"
```

Options considered and rejected:

- **A: keep 4,500.** Rejected as the base. Main measures 4,784, so the gate would be red on main
  from its first run and every kernel PR would need an ADR. The number would then stop meaning
  anything, which is the failure K-4′ was written to prevent.
- **B: count net lines (added − deleted).** Rejected. Arbiter ruling 10 notes that net counting
  rewards churn: a +600/−600 rewrite would cost nothing.
- **C: a budget without a gate.** Rejected. That is what we have today, and it is how the budget
  was exceeded without anyone seeing it.

## Decision

We measure the ARIA kernel from K1's merge and enforce one ceiling, set on the measured base, with
a CI gate that runs on every kernel PR and on every push to main.

1. **Base.** `base_sha` is K1's merge commit `b28a5216a`. K1's +1,947/−358 kernel lines are the
   recorded pre-program exception (`base_exception`). They lie outside the measure because the
   measure starts at their merge commit.
2. **Measure.** One change is one first-parent commit on main (a PR's merge commit). It is charged
   its gross added non-test kernel lines minus the deletions that exceed them:
   `charge = added − max(0, deleted − added)`. The merged measure is the sum of these charges from
   the base to main. Deletion credit exists only for merged changes: a deletion on an open branch,
   or one promised for later, moves nothing. A rewrite earns no credit. Renames count as a deletion
   plus an addition.
3. **Ceiling: 8,702 kernel lines and +4 modules.** The line ceiling is 4,784 merged + 3,108 in
   the twelve named open PRs + 810 rev3-min estimate. The module ceiling is 0 merged + 4 in the
   named open PRs (#1756, #1766) + 0 for rev3-min. A change that adds to the measure may not take
   the projection (merged measure + its own charge) past either ceiling. A change that only
   removes is never blocked. On a push to main the merged measure alone must fit.
4. **Per PR: ≤ 400 gross kernel lines and module delta ≤ 0.** Deletions in the same PR do not
   offset the per-PR cap.
5. **Open PRs that predate the gate.** They are the twelve PRs in the table above, each named in
   `predating_prs` by number, branch and measured head, with its measured added and deleted lines
   and module delta. There is no wildcard. A PR matches its entry only when both number and branch
   match. It may carry up to its measured size and module delta, never more: a named PR that grows
   loses the allowance for the excess. An entry is removed from the policy when its PR merges or
   closes. Removing an entry tightens the policy, so it needs no ADR. The gate reports an entry
   whose PR has merged as stale and grants nothing through it.
6. **Raising a limit.** Only an ADR in the same PR raises a limit. The PR edits
   `docs/aria/policy/kernel-budget.json` and adds or modifies an ADR that the edited policy lists
   in `adr_refs`. Tightening needs no ADR: lower limits, or fewer predating entries left unchanged.
   Any other policy edit without such an ADR fails the gate (`policy_change_without_adr`). The
   limits are then evaluated against main's policy, so the overrun the edit tried to cover is
   reported next to it.
7. **Where it runs.** `tools/gates/kernel-budget.ts` (`npm run gates:kernel-budget`) runs in the
   `lane` job of `.github/workflows/aria-kernel.yml`, which the required `aria-kernel` verdict
   needs green, on every PR touching `aria-kernel/**`, `docs/aria/**` or the gate itself, and on
   every push to main. Its spec, `tools/gates/kernel-budget.spec.ts`, runs in `npm run gates:test`
   (`closes-footer-check.yml`, every PR).
8. **Who may change it.** The policy, this ADR and the gate are L3. The policy and the gate match
   the L3 globs `docs/aria/**` and `tools/**` in `docs/aria/policy/risk-policy.json`. All three
   are code-owned by the operator in `.github/CODEOWNERS`, and the risk policy puts every
   code-owned path in L3 (`codeowners_lane`). The ADR needs that line: `docs/**/*.md` would
   otherwise make it L1. All three are READONLY to ARIA's implementer through the
   `docs/aria/policy/`, `docs/recommendations/` and `tools/gates/` prefixes of
   `implementation_safety.READONLY_PATHS`, pinned by
   `aria-kernel/tests/test_trust_anchor_boundary.py`. ARIA cannot write its own budget.

## Consequences

- The ceiling (8,702) is almost twice K-4′'s 4,500. Most of it legitimises growth that has
  already merged or is already open, including three merged changes and four open PRs over the
  per-PR cap. The measure does not judge whether those lines were needed. The losing side is
  K-4′'s original intent of a small kernel, which this ADR trades for a number the gate can hold
  from today.
- Headroom is first come, first served. Of the 810 lines left for rev3-min, any other kernel PR
  can use some. A non-named PR that adds a module needs an ADR even while the module ceiling has
  room, because the per-PR module delta is ≤ 0.
- The rev3-min share is an estimate from the plan's table, not a measurement. If rev3-min's
  kernel rows need more than 810 lines, that needs another ADR.
- A named PR that grows by one line past its measured size fails. Four named PRs are already
  above 400 lines and are allowed only their measured size. Several were still moving when they
  were measured: #1733 went from 399 to 405 within the measuring session.
- Line counts are a proxy for complexity. A dense 300-line PR passes and a tidy 450-line PR does
  not. Kernel data files (`aria_kernel/data/*.json`) count as lines because the kernel executes
  them as policy. They are not modules.
- Direct pushes to main are judged only after the fact, by the push run. The gate cannot see
  closed PRs without network access, so a closed PR's entry stays until someone removes it. It
  grants nothing beyond that PR's measured size.

## Escalation to human reviewer

This ADR is **Proposed**. The operator decides:

1. **The base.** Accept 8,702 / +4 on `b28a5216a` as stated, or choose another number. If a
   number below 4,784 is chosen, main fails its push run from the first commit, as option A
   describes.
2. **The rev3-min share.** 810 (the plan table's itemised estimates) or R3-D10's rounded ≈0.9k.
3. **The module ceiling.** +4 (the two named PRs that add modules), or K-4′'s strict 0, which
   would require #1756 and #1766 to fold their new modules into existing ones before they merge.
4. **The charge rule.** Credit is given only for deletions in excess of additions, per change.
   K-4′ says "credit only for merged deletions" without saying whether a mixed change earns any.
5. **Non-ARIA PRs in the list.** #1563, #1569 and #1629 touch kernel source by 1, 16 and 19 lines.
   They are listed so that the ceiling's composition is complete. Removing them lowers the
   ceiling by 36.
