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

## Open items a future reader should not re-derive

Measured 2026-09-09; check them before acting, they may have moved.

| Control                     | Disposition         | Why                                                                                                                                                                                                                            |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assert_within_breaker`     | **delete**          | `_cycle_preflight` already reads the breaker                                                                                                                                                                                   |
| `check_remaining_budget`    | **delete**          | Same surface as `assert_within_budget`                                                                                                                                                                                         |
| `require_tools_v2`          | **delete**          | Every live path resolves through `ensure_tools_dir`                                                                                                                                                                            |
| `verify_claim_disjointness` | **delete**          | `verify_principal_disjointness` is the live independence pass, reached from `human_required_adjudication.py:364`                                                                                                               |
| `verify_workflow_registry`  | **delete**          | The equivalent assertion runs in CI as a TypeScript invariant — pick one lane, not two                                                                                                                                         |
| `validate_request`          | **reconcile first** | `ORPHAN-MEDIUM-572`. No producer mints `aria/agent-request/v1`; live dispatch mints `aria/agent-invocation-request/v1`. Its sibling `validate_response` has 11 callsites. Reconcile the vocabulary before anything enforces it |
| `validate_file`             | **verb or delete**  | Operator CLI surface with no CLI verb attached                                                                                                                                                                                 |
| `verify_branch_tip`         | keep (in date)      | `merge_pr_if_ready` does its own inline head-SHA comparison; PLAN Wave 8 collapses the two                                                                                                                                     |

The five **delete** rows are the point worth carrying forward: at this stage of
ARIA's life the healthy move on a dormant safety control is usually _removal_,
because the protection already exists elsewhere and the duplicate is what will
eventually disagree with it. Deleting them **reduces** the safety surface's
attack area on itself; it does not weaken the system, and it is not "silencing"
the gate — the gate stays armed, with less to be wrong about.
