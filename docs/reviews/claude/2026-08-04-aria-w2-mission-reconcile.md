# A mission's state was only ever what ARIA last wrote

Date: 2026-08-04
Branch: `claude/aria-w2-mission-reconcile`
Scope: `aria_kernel/mission_reconcile.py`, `aria_kernel/mission.py`,
`aria_kernel/cycle.py`, `aria_kernel/github_adapters.py`,
`aria_kernel/auto_merge.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 2 PR 1.3

## The gap

PR 1.1 gave work a durable identity; PR 1.2 gave the candidate generator its
first caller. Both write. Nothing reads back.

Between two nightlies a PR can be merged by a human, closed without merging, or
lose its branch. A mission's recorded state is what ARIA last wrote, so it stays
in `IMPLEMENTING` forever — holding a WIP slot for work that is already on main,
and carrying a `wake_condition` for an event that has already happened. The
durability PR 1.1 bought is worth nothing if the durable record is wrong.

## The one rule, and why it is not caution

Only a POSITIVE, RECOGNISED observation moves a mission. An unrecognised state,
a `None`, an adapter that raised: recorded, and nothing else.

That is not a general preference for safety. It is the shape of the production
lane, and the evidence is concrete. `select_github_adapter` hands
`observe`/`standard`/`frozen` a `RecordingGitHubAdapter` that never calls `gh`.
A reconciler that read "not merged" as "closed unmerged" would advance the retry
rung of **every** mission on **every** dry-run night, and again on every GitHub
outage, until each one reached `justified_reject` — without one real
observation ever having been made.

The same property is why this PR ships no soak flag, though PLAN specified a
`would_transition` soak before going live. A flag is a second control surface
for something the adapter table already decides, and it is a control surface
somebody can leave in the wrong position. The profiles that must not act get an
adapter that **cannot answer**, so observe-first is structural. When the lane
moves to `strict`/`autonomous`, reconciliation begins acting for the same reason
merging does, and through the same table.

## Absence is not damage, three times over

The rule shows up as three separate refusals, and each one is a place the
obvious code would have been wrong:

**`get_pr` could not have carried this.** It requests
`number,baseRefName,headRefName,headRefOid,files,reviews,reviewDecision` — no
`state`, no `merged`. Building reconciliation on it would have produced a phase
that classifies every real PR as unobserved and never transitions anything:
machinery written and unable to fire, the exact defect class the last seven PRs
closed. Hence `get_pr_lifecycle`, a purpose-built call, `None` on the recording
adapter.

**`merged` is read before `state`, and against the boolean.** GitHub's REST API
reports a merged PR with `state: "closed"`. A classifier reading state first
would call every successful merge a failed attempt and send the mission back to
PLANNING with a rung spent. `merged: "false"` is truthy, so the comparison is
`is True`.

**Branch absence goes through `git ls-remote`, not `gh api`.** The two outcomes
that must not be confused — "the branch is gone" and "I could not ask" — are an
exit code apart in `ls-remote`, where over HTTP they are both a non-zero `gh`
exit whose difference lives in stderr prose. A branch-absence rule that depends
on parsing an error message is a rule that starts replanning missions the day
GitHub rewords a 404.

## Where the divergence table draws its lines

| Observation                     | Mission state          | Result                                    |
| ------------------------------- | ---------------------- | ----------------------------------------- |
| merged                          | before MAIN_VERIFYING  | fast-forward, `reconciled_external_merge` |
| merged                          | MAIN_VERIFYING onwards | nothing — steady state, not divergence    |
| merged                          | a waiting state        | contradiction recorded; no edge exists    |
| closed unmerged                 | IMPLEMENTING..MERGING  | PLANNING, retry rung +1                   |
| closed unmerged                 | rung exhausted         | HUMAN_REQUIRED, `retry_ladder_exhausted`  |
| closed unmerged                 | merge tail             | contradiction recorded                    |
| branch absent (and no PR bound) | IMPLEMENTING..READY    | PLANNING, `reconciled_lost_branch`        |
| anything else                   | any                    | counted, not acted on                     |

Three of those lines are the interesting ones.

**A merge outranks a closed sibling.** Two attempts, the second merged: acting
on the closed one would replan work that is already on main. **An open sibling
holds the replan back** — some attempt is in flight, and replanning abandons it.
**A branch is only checked when the mission has no PR**, because GitHub deletes
the head branch when a PR merges; checking it otherwise would report every clean
merge as a lost branch.

At most one state transition per mission per sweep. The mission snapshot is
folded once at the top, and deciding a second transition against it would be
deciding against a state that no longer exists. Divergence that survives is
reconciled next cycle — which is what a reconciler is for.

## Two things this PR changes outside itself

**`FORWARD_SKIP_REASONS` replaces a single literal.** `transition_mission`
allowed a forward mainline skip only under `reason_code == "coarse_observation"`.
An externally-observed merge is genuinely that shape — we saw the end state, not
the path — but writing `coarse_observation` on it would have thrown away the
only record of _why_ the mission jumped. The guard now reads a closed set of two
reasons, each documented as a claim that an END STATE was observed and the path
was not. Widening it further is an edit in `mission.py`, reviewed against that
rule.

**`_mainline_index` became public.** Reconciliation asks the transition guard's
own question — is this state before that one? — and a second copy of the
ordering rule is how two callers come to disagree about it.

## The PR body is untrusted, and adoption respects that

A PR opened outside the dispatch path carries `ARIA-Mission: m-…` in its body,
and reconciliation adopts it. The trailer regex is anchored and strict
(`^ARIA-Mission:[ \t]*(m-[0-9a-f]{16})[ \t]*$`), and the only thing extracted
from a PR body is an identifier that must **already name an open mission**. An
unknown id is recorded and refused, never opened. Mission identity is derived
from the source of the work; a PR cannot assert work into existence. An AST test
pins it — over both `Name` and `Attribute` call forms, because a source-text
search for `open_mission` is satisfied by the `list_open_missions` this module
legitimately imports.

## Verification

`aria-kernel/tests/test_mission_reconcile.py` — 42 tests, written before the
code.

**Mutation-checked seventeen ways**, all killed. The one that had to be fixed
rather than confirmed:

| Mutation                               | Result                           |
| -------------------------------------- | -------------------------------- |
| unrecognised state guesses `closed`    | 2 fail                           |
| `state` read before the `merged` flag  | 1 fail                           |
| truthy `merged` accepted               | 1 fail                           |
| unobservable branch read as absent     | 1 fail                           |
| merged no longer outranks closed       | 6 fail                           |
| open sibling no longer holds back      | 1 fail                           |
| branch checked despite a bound PR      | 13 fail                          |
| phase row deleted from `CYCLE_PHASES`  | 3 fail                           |
| phase joins the burn-in lane           | 1 fail                           |
| transitions drop next_action/wake      | 1 fail                           |
| retry rung stops advancing             | 1 fail                           |
| exhausted ladder loops to PLANNING     | 1 fail                           |
| trailer pattern loosened               | 1 fail                           |
| recording adapter fabricates an answer | 3 fail                           |
| external merge not a legal skip        | 5 fail                           |
| merge on a waiting mission ignored     | 1 fail                           |
| one bad mission aborts the sweep       | **SURVIVED**, then 1 error after |

The survivor is worth recording. The sweep's outer `except` exists for the one
call that can raise past the per-observation handlers — `transition_mission`
refuses any edge outside the closed table — and no test reached it, because the
adapter-error test is caught one level down. The handler was live code with a
green suite over it. There is now a test that makes the state machine refuse one
mission's edge and asserts the next mission still reconciles.

Kernel suite 3230 OK; `invariants:fast` green; run **sequentially**.

## Findings

- **ORPHAN-HIGH-544** (new) — a mission's state is only what ARIA last wrote;
  nothing reads back what GitHub did between cycles. The fix lands in the
  registering commit; the close ceremony rides the next PR, because `close`
  refuses a branch-local SHA and this branch has no merged one yet.
- **ORPHAN-HIGH-542** — closed here against `6b386a840`, the squash SHA of
  #1063, for the same reason.

Owner: okan
