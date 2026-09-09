# Is ARIA's autonomy design healthy? — 2026-09-09

Reviewer: zcode
Question asked: examine the health of ARIA's autonomous design before deciding
the ten expired dormancy waivers blocking `aria-kernel` / `unittest`.

## Verdict

**Structurally healthy.** The safety architecture holds the one property that
matters for an autonomous system — _the machine cannot widen its own authority_ —
and it holds it in code, not in prose. The red check is the system working, not
failing: it refuses to let a waiver expire silently, which is the exact defect
its TypeScript predecessor shipped with.

The work the ten waivers represent is **mostly deletion, not wiring**.

## What was verified, and how

### The authority model is sound

`ACTION_PERMISSIONS` (`runtime_profile.py:167`) is the SSoT mapping profile →
permitted action. Three properties were checked against code rather than comment:

1. **`pr_merge` is `autonomous`-only**, and `SCHEDULER_MAX_PROPOSABLE_PROFILE`
   is `strict`. A scheduled lane therefore **cannot reach merge authority by its
   own evidence, at any ladder level.** Only an operator gesture can.
2. **The ceiling is downward-only by construction.** `bound_profile_to_ceiling`
   is `min(ceiling, verdict)` and total — "there is no pair of profiles for which
   it has no answer, and the fallback direction is always downward." A
   non-operator attempting to raise it is refused:

   ```python
   if not is_operator and not profile_within_ceiling(scheduler_ceiling, previous_ceiling):
       raise GovernanceError("scheduler_ceiling_raise_requires_operator: ...")
   ```

3. **`PROFILES_WITH_ACTION_AUTHORITY` is derived from the table, not enumerated**
   (`frozenset().union(*ACTION_PERMISSIONS.values())`). Granting a profile a new
   cell automatically enrols it in breaker gating. The comment records why: the
   original defect was hardcoded `profile == "autonomous"` at each gate, which
   let `strict` and `standard` keep acting with the breaker tripped
   (`ORPHAN-CRITICAL-420` S2).

Default scheduler ceiling is `standard` — "a store no operator has touched keeps
every scheduled lane producing, observable, unable to open a pull request on its
own initiative."

### The merge boundary is layered, and every layer is wired

`merge_pr_if_ready` (`merge_authority.py:32`) passes through, in order: runtime
profile gate, autonomy unlock ladder, readiness claim, risk decision, L3 policy
approval, enterprise readiness, `GATE_PRE_MERGE` hard-fail checks, rollback
bundle, runner attestation, watchdog freeze, incident ledger rows, triple gate.
The unlock policy carries `critical_violation_limit: 0` and a cumulative
evidence ladder (L3 needs 30+30+30+10+5+3 recorded successes).

### The out-of-band stop is correctly shaped

`watchdog_freeze.py` is the strongest single piece of reasoning in the module.
The watchdog **reads** on the merge side and never writes, because "freezing
writes the breaker ledger, which requires importing the kernel — and every
failure the watchdog exists to catch is a failure of that kernel. A watchman
that dies of the illness it watches for is not a watchman."

It also **corrected the finding that spawned it**: `ORPHAN-MEDIUM-562` proposed
refusing inside the `aria-merge-authority` workflow, which is a required check on
every `pull_request` — so following it would have blocked every human PR in the
repository, _including the one repairing the stall_. The recorded shape was
corrected rather than followed. Wired at `merge_authority.py:58`.

### The reachability discipline is measurably improving

Executed against the live tree:

|                                  |              |
| -------------------------------- | ------------ |
| Declared control verbs           | **111**      |
| Unreachable from production      | **16 (14%)** |
| Covered by a waiver              | **16**       |
| Unreachable with NO waiver       | **0**        |
| Waived but now reachable (stale) | **0**        |

When `test_control_reachability.py` was written the measurement was **18 of 85
(21%)**. The manifest is exactly reconciled in both directions, and the gate
compares `expires_on` **against the clock**, not against a regex — the lesson
`invariant-reachability.spec.ts` paid for by letting twenty-five waivers sail a
month past a shared deadline in silence.

Two waivers carry `CORRECTED` notes that **falsify their own earlier claims**
(`assert_real_mode_env_safe`, `verify_claim_disjointness`). A manifest that
argues against its own past entries is the opposite of audit theater.

## The real weakness: duplicate safety entry points

Read by their own stated reasons, the sixteen waivers are not one population.
The dominant category is **a second helper asking a question a live path already
answers**:

| Control                     | The live answer it duplicates                                                    |
| --------------------------- | -------------------------------------------------------------------------------- |
| `assert_within_breaker`     | `_cycle_preflight`'s own breaker read                                            |
| `check_remaining_budget`    | `assert_within_budget`                                                           |
| `require_tools_v2`          | `ensure_tools_dir`                                                               |
| `verify_claim_disjointness` | `verify_principal_disjointness` (live from `human_required_adjudication.py:364`) |
| `verify_workflow_registry`  | the equivalent TypeScript CI invariant                                           |
| `verify_branch_tip`         | `merge_pr_if_ready`'s inline head-SHA comparison                                 |

Six of sixteen. The manifest names the hazard itself, on `assert_within_breaker`:

> a second way to ask the same question is how two answers start to diverge.

So the system is not under-guarded. It is **over-supplied**, and the failure mode
is slower and subtler than a missing check: two implementations drift, a future
author wires the wrong one, and the reachability signal gets noisy enough that
"add a waiver" becomes the reflex answer. Five of these six are safely
**deletable**, which _reduces_ the surface rather than growing it.

## ORPHAN-MEDIUM-808 — the oscillation guard is half-wired: a live producer with no consumer

This is the one finding this review adds, and it is not what the waiver says.

`assert_fix_dispatch_allowed` and `guard_fix_dispatch` are waived as belonging to
a lane that is not live: _"there is no live caller to attach it to."_ That is true
of the **decider**. It omits that the **recorder is already running in
production**:

```text
record_reopen()  written by : aria_kernel/memory.py:1004   ← LIVE
                 read by    : assert_fix_dispatch_allowed  ← 0 production callsites
                              guard_fix_dispatch           ← 0 production callsites
```

`memory.py` increments the oscillation counter on every belief whose evidence
changed, disappeared, or stopped matching its glob. Nothing ever reads it.

The danger is not the wasted write — it is the comment sitting directly above it:

```python
# Plan 031 Gate B — a belief reopened because its evidence changed is a
# reopen signal for the oscillation guard. Pure counter increment (no
# escalation here); the fix dispatcher's guard_fix_dispatch decides.
```

There is no fix dispatcher, and nothing decides. Two further modules shape their
own data for the same absent reader — `capability_gap.py:465` ("…for oscillation
guard use. Nights are UTC dates, not rows…") and `observation_coverage.py:199`
("…the oscillation guard uses to tell a loop from a revision"). Three comments
across three modules assert an active consumer that does not exist, which is
precisely the `ORPHAN-HIGH-455` shape: a reader concludes oscillation control is
in place because the code says so.

Not a safety hole today — the lane the guard would refuse is not dispatching. It
is a **false-assurance** defect, and it should be fixed by making the comments
true (say the counter is accumulated for a consumer not yet wired) or by wiring
the pair, not left as-is.

## One genuinely unguarded live path

`assert_real_mode_env_safe` — the waiver's `CORRECTED 2026-08-06` note is still
accurate on today's code. Real-mode eval is reachable
(`cli.py:1103-1106` register `--no-mock-mode` / `--real-envelope-file`;
`cli.py:3719` computes `mock_mode = not args.no_mock_mode`), and the guard has
zero callers anywhere. Blast radius is one env var (`CODEX_OSS_DEBUG=1`) on an
operator-typed flag rather than a scheduled lane, so the waiver's MEDIUM ranking
is correct, and wiring it is a one-line call at the real-mode entry.

## Recommended disposition of the ten expired waivers

Only **one** is "wire it".

| Action                             | Controls                                                                                                                       | Note                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Delete** (duplicate entry point) | `assert_within_breaker`, `check_remaining_budget`, `require_tools_v2`, `verify_claim_disjointness`, `verify_workflow_registry` | The live answer already exists in each case; deleting removes the divergence risk                                                                                              |
| **Wire** (one line)                | `assert_real_mode_env_safe`                                                                                                    | Genuinely unguarded live path                                                                                                                                                  |
| **Keep dormant, fix the lie**      | `assert_fix_dispatch_allowed`, `guard_fix_dispatch`                                                                            | Lane genuinely not live; but close `ORPHAN-MEDIUM-808` so three comments stop claiming otherwise                                                                               |
| **Reconcile the vocabulary first** | `validate_request`                                                                                                             | `ORPHAN-MEDIUM-572`: no producer mints `aria/agent-request/v1`; live dispatch mints `aria/agent-invocation-request/v1`, while its sibling `validate_response` has 11 callsites |
| **Give it a verb or delete**       | `validate_file`                                                                                                                | Operator CLI surface with no CLI verb attached                                                                                                                                 |

Pushing `expires_on` forward is the one move that is not available: a waiver
whose expiry nothing enforces is a waiver with no expiry, which is the defect the
assertion exists to catch.
