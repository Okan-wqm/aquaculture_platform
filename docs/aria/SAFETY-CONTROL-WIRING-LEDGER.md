# ARIA safety-control wiring ledger

**What this file answers:** _is this ARIA safety control actually live, and who
changed that?_

It exists because the failure mode this repository keeps rediscovering is not a
missing control. It is a control that is written, unit-tested, exported, name-
pinned by an invariant — and called by nobody. `ORPHAN-CRITICAL-498`,
`ORPHAN-HIGH-455`, `ORPHAN-CRITICAL-420`, `ORPHAN-MEDIUM-571/572` and
`ORPHAN-MEDIUM-808` are all that one defect wearing different names. A green test
suite is no evidence against it, because the tests call the control directly.

Written for a reader — human or model — who was not present when the change was
made. **Do not trust this file; falsify it.** Every claim below has a command
next to it.

---

## How to check the current state yourself

```bash
cd aria-kernel
PYTHONPATH=.:.. python3 - <<'PY'
from pathlib import Path
from aria_kernel.control_reachability import declared_controls, unreachable_controls
import json, io
root = Path('..').resolve()
d, u = declared_controls(root), unreachable_controls(root)
dorm = json.load(io.open('control-reachability.dormant.json', encoding='utf-8'))
print('declared control verbs :', len(d))
print('unreachable            :', len(u))
print('waivers                :', len(dorm))
print('unreachable, NO waiver :', sorted(set(u) - set(dorm)))   # must be []
print('waived but reachable   :', sorted(set(dorm) - set(u)))   # must be []
PY

# the gate itself, including the clock comparison on every waiver
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:.. python3 -m unittest tests.test_control_reachability
```

To ask whether one specific control is wired, never grep — grep cannot tell a
call from a mention, and this repo's comments name these controls constantly.
That is how `ORPHAN-CRITICAL-428` was reported as wired when it was not:

```bash
grep -rn "\bmy_control(" --include=*.py aria-kernel/aria_kernel tools | grep -v "def my_control"
```

### Measurement on 2026-09-09

|                               |     |
| ----------------------------- | --- |
| Declared control verbs        | 111 |
| Unreachable from production   | 14  |
| Covered by a dormancy waiver  | 14  |
| Unreachable with no waiver    | 0   |
| Waived but actually reachable | 0   |

For contrast, when `test_control_reachability.py` was written the measurement was
**18 of 85 (21%)**.

---

## The gate's known blind spot — read this before trusting a green run

`control_reachability.CONTROL_VERBS` is exactly:

```text
validate_  enforce_  assert_  require_  verify_  guard_  refuse_  check_
```

A control whose name does not start with one of those prefixes **is invisible to
the gate**. This is not hypothetical — it hid `ORPHAN-MEDIUM-808` for months:

> A counter-based control has a completeness requirement — _increment, reset and
> decide are live together or not at all_ — that a name-prefix reachability scan
> cannot express. `oscillation_guard` had `guard_fix_dispatch` (visible, waived)
> and `record_resolution` (invisible, unwaived, and the one whose absence broke
> the contract).

**Rule of thumb for a future reader:** when you find a dormant `guard_*` /
`assert_*`, do not stop at the gate's report. Look for its `record_*`, `emit_*`,
`_reset` and `_producer` counterparts and check those by hand. The gate reports
deciders; it does not report the data they decide on.

---

## Standing rules for a dormant control

There are exactly **three** legitimate dispositions, and pushing `expires_on`
forward is not one of them. A waiver whose expiry nothing enforces is a waiver
with no expiry — which is the precise defect the clock comparison exists to catch
(`invariant-reachability.spec.ts` let twenty-five waivers sail a month past a
shared deadline in silence before it compared dates to the clock).

1. **Delete it** — when a live path already answers the same question. This is
   the most common correct answer. The manifest states the hazard itself, on
   `assert_within_breaker`: _"a second way to ask the same question is how two
   answers start to diverge."_
2. **Wire it** — when it guards a live path nothing else guards. Verify the whole
   contract first (see 808 below): wiring a decider onto an incomplete data path
   can be worse than dormancy.
3. **Keep it dormant with an honest waiver** — owner, reason, `expires_on`,
   `finding_id`. The reason must say what would make it wireable, not merely that
   it is not wired.

---

## 2026-09-09 — `ORPHAN-MEDIUM-808`, the oscillation guard

Commit: `fix(aria): the oscillation guard counted forever and decided nothing`
Audit: `docs/reviews/zcode/2026-09-09-aria-autonomy-design-health.md`

### The before-state, exactly

`aria_kernel/oscillation_guard.py` (Plan 031 Gate B) exists to stop ARIA
ping-ponging: fix X → X reopens → fix X again, forever, each fix correct in
isolation. It shipped a complete, unit-tested **three-part contract**. Production
wired **one third** of it:

```text
record_reopen      (increment) : memory.py:1004                  ← LIVE
record_resolution  (reset)     : tests only                      ← 0 production callers
guard_fix_dispatch (decide)    : tests only                      ← 0 production callers
assert_fix_dispatch_allowed    : tests only                      ← 0 production callers
is_oscillating     (predicate) : only from assert_fix_dispatch_… ← transitively dead
```

Three comments in three modules described a consumer that did not exist:

- `memory.py:1002` — _"the fix dispatcher's `guard_fix_dispatch` decides"_
  (there was no fix dispatcher, and nothing decided)
- `capability_gap.py:465` — _"…for oscillation guard use. Nights are UTC dates,
  not rows…"_ (shaping data for an absent reader)
- `observation_coverage.py:199` — _"…the oscillation guard uses to tell a loop
  from a revision"_

**Why the reset was the half that mattered.** `reopen_streak` tail-scans
governance newest-first and stops at the first `finding_resolution_clean` for the
fingerprint. With no producer for that event, the streak was **monotonic** — it
counted every reopen a belief had ever had, across the whole life of the
repository, and never subtracted. A belief that broke and healed three times over
three months was indistinguishable from one ping-ponging inside one cycle.

So wiring the decider _first_ would have converted a dormant control into a
**permanent block**: the first belief to reach three lifetime reopens would be
escalated to `HUMAN_REQUIRED` and refused forever, with no path back. That is
strictly worse than dormancy, and it is why the obvious move was the wrong one.

### What was WIRED, and where

**1. The reset — `memory.py`, in `_record_belief`, immediately after
`append_jsonl(... beliefs.jsonl ...)`:**

```python
if int((existing or {}).get("needs_revalidation_cycles", 0)) > 0 and not needs_revalidation_cycles:
    from .oscillation_guard import record_resolution
    record_resolution(fingerprint=f"belief:{belief_id}", cycle_id=cycle_id, base_dir=root)
```

The condition is a **state transition**, not a state: the belief _was_ in
revalidation, ARIA re-observed it, and its evidence holds again. Emitting on every
clean pass would silently disarm the guard; a test asserts that a still-broken
belief re-observed does **not** reset (`test_a_belief_that_never_healed_keeps_its_streak`).

The fingerprint is spelled `belief:{belief_id}` — byte-identical to how the reopen
side spells it. One vocabulary, or the governance scan matches nothing and the
guard is decorative.

**2. The decider — `promotion_controller.py`, inside
`promote_converged_plan_to_dispatch`, in the blocker-collection phase:**

```python
oscillation_fingerprint = _oscillation_fingerprint(paths, pressure_event_id)
if oscillation_fingerprint is not None:
    try:
        guard_fix_dispatch(fingerprint=..., cycle_id=cycle_id, base_dir=root, context={...})
    except GovernanceError:
        blockers.append("oscillating_fingerprint")
```

Why _that_ function: it is the single throat where a CONVERGED plan becomes a
materialized `aria/dispatch-request/v2` row a worker acts on. It is reachable
today from `cli.py:4441` — the waiver's _"wire it when that lane goes live"_ was
already satisfied and nobody had rechecked.

Why the raise is caught: the throat's contract is to report **every** reason a
promotion was refused. A plan blocked for four reasons must name four, or the
operator fixes one and returns to find the next. The escalation still happens
exactly once, inside the module that owns the threshold — there is no second copy
of the rule at the callsite.

**3. The fingerprint lookup — new helper `_oscillation_fingerprint`:**

Resolves `pressure_event_id → belief_id` by reading the **raw** pressure ledger
(`paths.ledgers["pressure"]`), deliberately **not**
`effective_workspace_pressures`. The effective view filters by decay, and a
pressure that has decayed out is still the pressure the plan was written for —
asking the decayed view would skip the guard for exactly the slow, long-running
ping-pong it exists to catch.

Returns `None` for a promotion with no pressure (an operator promotion has no
reopen history to consult) and for a pressure with no `belief_id` (the counter's
key space holds only `belief:<id>` today, so a tool-derived pressure has nothing
to look up). Both are _the absence of a question_, not permission to skip an
answer — and a test pins that an unrelated belief's history cannot leak in.

### What was DELETED, and what it was

Two non-escalating siblings, removed rather than given callers. Both asked the
decider's question without performing its refusal — the "second answer" the
manifest itself warns about.

**`is_oscillating`** — read-only predicate, transitively dead (its only caller was
the function below):

```python
def is_oscillating(*, fingerprint: str, base_dir: Any = None,
                   threshold: int = DEFAULT_OSCILLATION_THRESHOLD) -> bool:
    """Read-only: True iff the reopen streak has reached the threshold."""
    if threshold < 1:
        raise GovernanceError("threshold must be >= 1")
    return reopen_streak(fingerprint=fingerprint, base_dir=base_dir) >= threshold
```

**`assert_fix_dispatch_allowed`** — raised without escalating:

```python
def assert_fix_dispatch_allowed(*, fingerprint: str, base_dir: Any = None,
                                threshold: int = DEFAULT_OSCILLATION_THRESHOLD) -> None:
    """Raise if ``fingerprint`` is oscillation-blocked (read-only).

    The cheap pre-dispatch guard. Does NOT escalate (no HUMAN_REQUIRED write) —
    use ``guard_fix_dispatch`` for the escalate-and-block decision.
    """
    if is_oscillating(fingerprint=fingerprint, base_dir=base_dir, threshold=threshold):
        raise GovernanceError(
            f"oscillation_fix_dispatch_blocked: fingerprint={fingerprint!r} has "
            f"reopened >= {threshold} times without a clean resolution; "
            f"autonomous fix dispatch refused — operator must intervene"
        )
```

**If you are about to restore either of them: don't, unless you have a caller that
needs a check WITHOUT an escalation, and you can say why that caller must not
escalate.** Its waiver had argued the pair must be _"wired or neither"_ to avoid
"the appearance of oscillation control without the refusal". The refusal now
exists in `guard_fix_dispatch`; a second, quieter answer beside it is the drift
hazard, not a safety net. Their tests were removed with them; the surviving
behaviour is covered by `guard_fix_dispatch`'s own tests.

Also removed: their two entries from `control-reachability.dormant.json`
(expired waivers 10 → 8). The manifest raised no stale-waiver complaint, which is
independent confirmation that `guard_fix_dispatch` is genuinely reachable now.

### What was deliberately NOT done

- **The comments in `capability_gap.py:465` and `observation_coverage.py:199`
  were left as-is** — they became TRUE with this change (there is now an active
  consumer), so editing them would have been churn.
- **No change to the threshold** (`DEFAULT_OSCILLATION_THRESHOLD = 3`) or to
  `record_reopen`'s call site. The reopen half was never wrong.
- **No `finding:<sha>` producer was added.** The counter's key space documents
  both `finding:<sha>` and `belief:<id>`; only `belief:` is ever produced. The
  guard therefore fires only for belief-derived pressures today. That is the
  current shape of the system, recorded here so the next reader does not mistake
  it for coverage.

### Verification performed

- 7 new tests across `tests/test_oscillation_resolution_wiring.py` and
  `tests/test_oscillation_promotion_gate.py`.
- **Negative controls run for both halves** — with the fix reverted, 2 of 3 and 2
  of 4 fail, naming the real defect: _"3 separate break/heal rounds accumulated
  into a loop verdict"_.
- 131 tests green across memory, promotion, mission, dispatch and the guard.

---

## 2026-09-09 — `ORPHAN-HIGH-573`, the real-mode environment guard

Commit: `fix(aria): real-mode eval ran without its own environment precondition`

### Before

`artifact_safety.assert_real_mode_env_safe(env)` refuses a real-mode run when any
name in `FORBIDDEN_REAL_MODE_ENV` (today: `CODEX_OSS_DEBUG`) is set to `"1"`. It
had **zero callers anywhere** — only its definition and its `__all__` entry.

Its waiver carried a `CORRECTED 2026-08-06` note, which re-reading the CLI
confirmed is still accurate: the _original_ waiver claimed the mode is
unreachable because `run_agent_eval` defaults to `mock_mode=True`. False.
`eval-run --no-mock-mode` is registered (`cli.py:1105`), needs only
`--real-envelope-file` beside it (`cli.py:1103`), and `cli.py:3719` computes
`mock_mode = not args.no_mock_mode`. An unguarded **live** path, not a dormant
future one — bounded because the flag is operator-typed rather than scheduled,
which is why it stayed MEDIUM.

### Wired

`agent_eval.run_agent_eval`, as the **first** statement of the `else:` (real-mode)
branch, ahead of the provenance preconditions:

```python
assert_real_mode_env_safe(dict(os.environ))
```

Order is the substance, not the placement detail. Without it the first refusal a
caller sees is `mock_mode=False requires real_response_envelope` — proven by the
negative control, which produced exactly that error — meaning the run has already
begun reading ledgers and binding an invocation under the debugger environment
the guard exists to keep it out of.

Note that `enforce_profile_for_write` and `_read_fixture` still run before the
branch. That is correct: reading a fixture is not the hazard; _running real mode_
is.

### Verification

4 tests in `tests/test_real_mode_env_guard.py`, including one pinning the
ordering and one pinning the blast radius (mock mode completes normally with the
variable set, so wiring this cannot break a scheduled lane). Negative control
run. 41 tests green across the eval modules. Waiver removed; expired waivers
10 → 7 cumulative with the oscillation work.

## 2026-09-09 — `ORPHAN-HIGH-573`, collapsing the duplicate entry points

Commit: `refactor(aria): four ways to ask a question the live path already answers`

Every deletion below was preceded by PROVING the live answer exists. Two of the
five candidates did not survive that proof and were NOT deleted — which is the
point of doing it in that order.

### Deleted (proof in hand)

| Control | The live answer, verified |
| ------- | ------------------------- |

Their tests were repointed at the surviving path rather than dropped:
the breaker test now asserts on `evaluate_breaker`'s verdict directly, and the
disjointness tests build the three dispatch rows themselves. Coverage is
unchanged; only the second spelling is gone.

### Renamed, not deleted

`check_remaining_budget` → **`remaining_reservation_budget`** (`budget.py`).

Reading it proved the waiver wrong: it returns `reserved - reconciled` as a
float and refuses nothing, so it is an **accessor**, not the duplicate of
`assert_within_budget` (which raises) that the waiver described. Its only
consumer is `test_phase_v8_0_prerequisites`, observing reserve/reconcile
arithmetic — real coverage that deleting would have destroyed.

The defect was the NAME: `check_` is one of the eight `CONTROL_VERBS` prefixes,
so the gate demanded a production caller for something that is not a control.
Renaming fixes the classification at the source instead of carrying a waiver that
says something untrue about the code.

### Kept, with the reason replaced because the old one was FALSE

- **`verify_workflow_registry`** — waiver claimed "the equivalent assertion runs
  in CI as a TypeScript invariant". Checked: no spec under `tests/invariants`
  references `WORKFLOW_CONTRACTS`, and the nearest one asserts something else
  (that a job running kernel code provisions the kernel first). The guarantee is
  **unduplicated**: preflight's live `verify_workflow_contract` validates ONE
  contract and by construction only visits workflows that already have one, so an
  ARIA workflow added with neither a contract nor an audited exclusion is
  invisible to it. Deleting would have removed a real control on a false premise.

  Wiring it into `verify_workflow_preflight` was **attempted and reverted**: that
  preflight legitimately runs against synthetic workspaces where the workflow
  YAMLs are absent, so the inventory verdict is invalid there for a reason that is
  not a defect (`test_workflow_enterprise_preflight` proved it immediately). A
  repo-wide invariant needs a caller that always sees the real repo. That entry
  point — a CLI verb plus a CI step — is the open decision.

- **`validate_file`** — waiver read as dead code ("no CLI verb attached"). It is
  the ENGINE of the V4 narrative-shape invariant
  (`tests/invariants/v4/test_phase_v4_b_narrative_shape.py:62,66`), which runs it
  over every agent file. Its consumer is an invariant test, which is this
  control's intended and sufficient consumer.

- **`validate_request`** — reason re-verified and stands (`ORPHAN-MEDIUM-572`).
  No producer mints `aria/agent-request/v1`; the live dispatch path mints
  `aria/agent-invocation-request/v1`, while its sibling `validate_response` has 11
  callsites. Unlike the entry points deleted above, this one has **no live sibling
  answering its question** — it is the only validator for a contract half, so
  deleting it is not available either. The vocabulary is reconciled first.

### The classification problem, now seen three ways

`CONTROL_VERBS` decides what the gate can see, and it is wrong in both
directions:

|                     |                                                                     |
| ------------------- | ------------------------------------------------------------------- |
| `record_resolution` | a real control the prefix list **cannot see** (`ORPHAN-MEDIUM-808`) |

That rule is right for a control meant to run in production and wrong for one
whose consumer is the invariant itself. Teaching the gate that category is open
work; it is named here so the next reader does not rediscover it a fourth time.

### Result

Expired dormancy waivers **10 → 0**. `test_control_reachability` passes 8/8, and
with it the `aria-kernel` / `unittest` check that had been red on `main` since
2026-09-07. 126 tests green across every module touched.

## Open items a future reader should not re-derive

Measured 2026-09-09; check them before acting, they may have moved.

| Control             | Disposition    | Why                                                                                        |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `verify_branch_tip` | keep (in date) | `merge_pr_if_ready` does its own inline head-SHA comparison; PLAN Wave 8 collapses the two |

What 2026-09-09 actually taught, now that the deletions have been done rather
than planned:

**Five controls were nominated for deletion on the strength of their waivers.
Three survived the proof and were deleted. Two did not** — one guarded something
unduplicated (`verify_workflow_registry`) and one was not a control at all
(`check_remaining_budget`). A sixth (`validate_file`) had a waiver that read as
dead code and turned out to be an invariant's engine.

So the instinct "at this stage the healthy move is usually removal" is right
about the population and useless as a rule, because it is wrong about a third of
the individuals. The rule that survives is the ORDER:

> Prove the live answer FIRST, by reading it, and only then delete. A waiver's
> stated reason is a lead, not evidence — three of the ones checked today were
> materially false, and each would have removed or hidden a real control if
> followed.

Deleting a proven duplicate reduces the surface the safety system has to keep
consistent with itself; it does not weaken the system and it is not "silencing"
the gate — the gate stays armed, with less to be wrong about. Deleting an
UNPROVEN one is how a repository loses a control and keeps the green check.
