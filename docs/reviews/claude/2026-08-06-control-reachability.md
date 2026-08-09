# The controls nobody calls — 2026-08-06

## ORPHAN-HIGH-573 — 21% of the kernel's declared controls were dormant

### The class, not the instance

Four findings closed in this programme are one defect wearing four names:

| finding               | what it was                                         |
| --------------------- | --------------------------------------------------- |
| `ORPHAN-CRITICAL-498` | a perimeter with no production caller               |
| `ORPHAN-HIGH-569`     | a discovery list the repository outgrew             |
| `ORPHAN-MEDIUM-571`   | a repository map nothing refreshed and nothing read |
| `ORPHAN-MEDIUM-572`   | a request vocabulary nothing consults               |

Each is **a control that is correct, tested, exported — and called by nobody.**

Every one was found by a human reading code. No gate has ever fired on this
class, and a green suite is no evidence against it: the tests call the control
directly. That is precisely how a control stays green while governing nothing.

Fixing them one at a time was treating symptoms. The root cause is that
nothing asks whether a control is connected to anything.

### The measurement

Of **85** public module-level callables in `aria_kernel` whose names begin
with a control verb (`validate_`, `enforce_`, `assert_`, `require_`,
`verify_`, `guard_`, `refuse_`, `check_`), **18 were referenced by no
production module at all — 21%.**

The verb convention is a usable definition rather than an arbitrary one: it
selects these functions because their own authors named them as guarantees.

### The one that mattered most

`verify_no_secret_in_envelope`. Its own docstring:

> _Hard-fail check — scan agent response envelope before kernel persists.
> Stringifies the envelope, runs the same secret-scan as diff. Defense against
> agent stdout / stderr / validation_results embedding secrets._

It was exported in `__all__`, covered by tests, **absent from
`HARD_FAIL_CHECKS`, and called by nothing.** Its sibling
`verify_no_secret_in_diff` _is_ wired — so diffs were scanned and the envelope
carrying agent stdout, stderr and validation results was not. The leak path
its docstring names was the one left open.

It is now called in `submit_claim_result`, at the moment the docstring
specifies — before the kernel persists the response — where a hit joins the
existing `reasons` list and refuses the envelope. The exception message is
redacted by construction (pattern name and count, never the matched value), so
appending it cannot move a secret into the rejection row.

### The fix is the gate, not the seventeen

`tests/invariants/invariant-reachability.spec.ts` already solved this shape for
TypeScript specs, and it learned one lesson expensively: it validated the
**shape** of `expires_on` with a regex and never compared it to the clock, so
twenty-five waivers sailed a month past a shared deadline in silence. Checking
the syntax of a date instead of the date is checking the syntax of a thing
instead of the thing.

That mechanism is now applied to the kernel — deliberately reused rather than
reinvented, because two ways to ask one question is how two answers start to
diverge. A dormant control must be declared with an **owner, a reason, a
deadline and a finding ID**, and:

- a waiver past its deadline fails the suite;
- a waiver for a control that has since been wired fails the suite, so the
  manifest cannot rot in the other direction;
- a waiver naming a control that no longer exists fails the suite.

The 17 remaining waivers are **not deferral**. Each names why the control has
no caller _today_ — a lane not yet live (skill-genesis, autonomous fix
dispatch, real-mode eval), a duplicate entry point pending a deliberate
collapse (`assert_within_breaker`, `verify_branch_tip`, `require_tools_v2`),
or a decision owned by a specific PLAN wave — carries a deadline, and fails
the day it expires.

Two are worth naming as genuinely missing consumers rather than duplicates:
`validate_generated_adapter` and the two adapter sandbox checks (the
skill-genesis lane validates nothing kernel-side).

`verify_claim_disjointness` was originally listed here as a third. It is not —
see the correction at the end of this document. The claim that the judge
fan-out has no independence pass was false, and it had ranked that control as
the strongest wiring candidate on the strength of it.

### What counts as reachable, and the hole the gate found in itself

A control is reachable if a production module **uses** it: a call, a registry
tuple membership, a string in a dispatch table. Excluded are its own `def`
line, its module's `__all__` (exporting is not using — `ORPHAN-MEDIUM-572` was
in `__all__` and governed nothing), prose, and **imports**.

The import exclusion is not fastidiousness; the gate caught itself without it.
The mutation _"replace the one call to `verify_no_secret_in_envelope` with
`pass`, leave the import"_ left the suite **green** — the import counted as a
reference. A control imported and never invoked is exactly the defect being
hunted, so the gate would have certified it. Imports are now excluded by AST
line span and that mutation goes red.

That is the third time this session mutation checking has caught a control of
mine that was weaker than its own name, and the first time the thing it caught
was the anti-defect gate itself.

### Verification

New suite `aria-kernel/tests/test_control_reachability.py`, 7 tests.

| mutation                                           | result                         |
| -------------------------------------------------- | ------------------------------ |
| un-wire the envelope secret scan (keep the import) | 2 red _(after the import fix)_ |
| a waiver past its deadline                         | red                            |
| a waiver with no `finding_id`                      | red                            |
| drop a dormant control's waiver entirely           | red                            |
| leave a stale waiver for a control that is wired   | 2 red                          |

Counts: 85 controls, 18 dormant before, **17 declared + 1 wired** after.

---

## ORPHAN-MEDIUM-574 — three numbers that made every merge conflict

### Found by counting, not by irritation

`tools/quality/format-scope.json` conflicted on **five separate merges in one
day** once two sessions were working concurrently. Each was resolved
identically. After the fifth, the conflict was inspected instead of resolved
again.

### The mechanism

The manifest is ~9,300 sorted entries. Two branches adding entries at
different paths should merge cleanly — and the entries did. The conflict was
elsewhere: three summary scalars emitted beside them.

```text
file_count               entries.length
managed_count            managedFiles.length
managed_file_list_sha256 sha256(managedFiles.join('\n'))
```

Adding or removing **any** tracked file changes all three. So two branches
conflict on exactly those lines _regardless of which files each one touched_ —
a structurally certain conflict rather than an occasional one.

### Why the conflicts carried no information

`checkManifest` rebuilds the manifest from the tree and compares it
byte-for-byte, and the pre-commit hook runs that check **unconditionally**
(`.husky/pre-commit`), as does CI. So whichever side of the conflict is taken,
the content is recomputed and anything else is refused. Five hand-resolutions,
zero decisions.

### Why removal, not a merge driver

Measured: the three scalars have **one producer and zero readers**.
`getManagedFormatFiles` is the manifest's only consumer and reads `.entries`
alone; a repo-wide search returns nothing but their own assignment lines.

A checksum over a file's own contents, stored in that same file, cannot detect
anything the contents do not already show. Removing them costs no detection
power — `checkManifest` still compares all entries byte-for-byte.

The obvious alternative was a git merge driver. It was rejected on
architecture, not effort: `merge.<name>.driver` must be registered in every
clone's git config, **does not travel with the repository**, and would change
merge behaviour for everyone in order to work around data that should not
exist. The neighbouring precedent — `merge=union` on the append-only
`orphan-findings.md` ledger — is right for that file and wrong here, because
this is structured JSON where union produces an invalid document.

### Pinned in two places, deliberately

`tools/gates/format-scope-derived-scalars.spec.ts` checks the artifact **and**
the generator. Checking only the artifact would pass while the defect sat one
command away: a field absent from today's manifest but still emitted by
`buildFormatScope` reappears on the next `generate`.

| mutation                                         | result                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| re-add a scalar to `buildFormatScope`            | red — _"the committed manifest is only clean until the next regenerate"_ |
| manifest carries a scalar the generator does not | red                                                                      |

The spec also re-runs the existing freshness check, so it can never become a
way to pass while the manifest drifts.

---

## ORPHAN-HIGH-575 — the most ordinary commit shape crashed the impact graph

### Found by a machine, believed only after checking by hand

An adversarial multi-agent investigation of the docs-only risk-class question
reported a production-reachable `TypeError`. Earlier the same day a
confidently-wrong HIGH was drafted and deleted on this same kind of evidence,
so the claim was reproduced by hand before being believed. It reproduced.

### The mechanism, line by line

```python
changed = sorted({_project_for_path(path, graph["projects"]) for path in ...})
changed_projects = [project for project in changed if project]   # filters AFTER sorting
```

`_project_for_path` returns `str | None`. Sorting a set holding **both** a
project name and `None` raises:

```text
TypeError: '<' not supported between instances of 'str' and 'NoneType'
```

### Why every obvious test passed

The trigger is the **mixture**, and the two natural test cases each avoid it:

| changed_files   | resolved set             | result                                 |
| --------------- | ------------------------ | -------------------------------------- |
| all code        | `{'farm-service'}`       | fine — no `None`                       |
| all docs        | `{None}`                 | fine — one element needs no comparison |
| **code + docs** | `{'farm-service', None}` | **TypeError**                          |

Code plus its own review document is this repository's most common commit —
it is what I have been making all day.

### Production reachability, verified link by link

- `learning.py:222` calls `plan_downstream_impact` with a pressure event's
  `evidence_refs` — arbitrary mixes of docs and code paths.
- `learning.py:228` catches `GovernanceError` only, so a `TypeError` escapes
  the loop over **every** pending dispatch.
- `learning.py:105` swallows it into a generic `learning_hook_failed`
  governance event and the cycle continues.

Net: one mixed-evidence pressure event silently disabled impact-graph
computation for a whole cycle, and the only record did not name the cause.

### The fix, and what it deliberately does not buy

Resolve each path once into `(path, project)`, then derive both outputs from
it — filtering before sorting. The unplaceable paths are still reported in
`unknown_files`; surviving by discarding the honesty about what the graph
could not place would be the wrong repair, and the second mutation below pins
that.

| mutation                       | result |
| ------------------------------ | ------ |
| restore sort-before-filter     | red    |
| stop reporting `unknown_files` | 2 red  |

### Blind-spot sweep for the same class

13 sites in `aria_kernel` match `sorted(<comprehension of an unfiltered
call>)`. Twelve are provably safe — `as_posix`, `str`, regex `group`, and a
`dict.get` with a non-`None` default. `impact_graph.py:51` was the only real
instance.

### Two things left open, named rather than implied

1. `learning.py`'s narrow `except GovernanceError` means **any** other
   unexpected exception can still abort the whole dispatch loop and be
   recorded only as a generic hook failure. Changing that alters another
   module's failure semantics and deserves its own decision.
2. Whether a docs-only change _should_ be blocked as `impact_graph_unknown`
   is still unanswered. This fix makes the measurement possible without
   deciding the policy.

---

## ORPHAN-HIGH-576 — a second normalizer that mangled every dotfile path

`impact.py` carried its own inline normalizer:

```python
item.replace("\\", "/").lstrip("./")
```

`str.lstrip` strips **characters from a set**, not a prefix. Verified by
execution:

| input                            | output                          |
| -------------------------------- | ------------------------------- |
| `.github/workflows/x.yml`        | `github/workflows/x.yml`        |
| `.claude/agents/orchestrator.md` | `claude/agents/orchestrator.md` |
| `./docs/a.md`                    | `docs/a.md` (correct, by luck)  |

Two consequences, both verified. The mangled path is what `plan_impact` writes
to the impact-plans ledger as the record of what a change touched — a
corrupted audit trail. And no discovered project root begins with `github/`,
so the mangling _also_ guaranteed such a path could never be placed, inflating
`unknown_files` for a reason that was an artifact of the normalizer rather
than of the repository.

Fixed by deleting the second normalizer and calling the promoted
`impact_graph.normalize_paths`, which uses `removeprefix("./")`. Tier 2: a
second normalizer cannot drift from the first because there is no second
normalizer.

**Blind-spot sweep.** `executor.py` and `codegen.py` have their own
`_normalize_paths`, but both delegate to `_strip_relative_prefix`, which
strips the prefix in a `while` loop and was verified _not_ to mangle dotfiles.
This was the only defective one.

---

## ORPHAN-HIGH-577 — a control that is called and cannot decide

The gate built above asks _"is this control called"_. Here is the case that
question cannot see.

`enforce_separation_of_duties` runs on **every** agent submit
(`agent_invocations.py:2306`). It refuses when the submitter appears in
`request["separation_of_duties"]["forbidden_agent_ids"]`. Verified by
repo-wide search: that field appears at exactly one production site — the
enforcer's own read — plus three test files. **No production path ever sets
it.** The control always evaluates an empty list, so its refusal branch is
unreachable and the property its docstring claims (_implementer != reviewer
for the same request_id_) is enforced nowhere.

### Why this is HIGH rather than MEDIUM

Because it is invisible to the control built hours earlier to police exactly
this class. `control_reachability` passes it — it _is_ called. The gate
measures **call-site existence**, not **decision efficacy**, and the most
dangerous member of the class falls in the gap between those two questions.

The gate's docstring now says so. A green gate must not be read as "every
control can refuse".

### Why no fix is guessed here

The blocker is a policy decision, not effort. Making it able to refuse
requires deciding _what_ is forbidden, and the code expresses no such policy:

- Deriving the forbidden set from prior claims on the same `request_id` — the
  ledger carries `request_id` and `agent_id` and could supply it — would also
  refuse a **legitimate retry** by the same agent after a transient failure.
- _Implementer != reviewer_ is a role-separation rule, and the queue layer
  does not currently record roles to separate.

Two honest options, both needing the operator's intent: mint a real forbidden
set at request creation, or delete the control, because a check that cannot
refuse is false assurance. A third was considered and rejected as unshippable
— raise when the forbidden set is empty — since that would refuse every
production submit today.

A generalised _vacuous control_ gate was prototyped and **not shipped**: a
mechanical scan for controls reading dict keys no production module writes
flagged 10 of 68 live controls, but most were false positives from writers
living in JSON/YAML or from short key names. A gate that cries wolf gets
waived into uselessness.

---

## Two of my own waivers were wrong, and corrected

A waiver whose reason is false is worse than no waiver — the finding notes
said so before either of these was caught.

| waiver                      | the claim                                                     | the code                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify_claim_disjointness` | _"the judge fan-out scores claims with no independence pass"_ | `verify_principal_disjointness` **is** the live pass, reached from `human_required_adjudication.py:364`. This is a second entry point, not an absent guarantee — and it was mis-ranked as the strongest wiring candidate on a claim nobody had checked. |
| `assert_real_mode_env_safe` | _"the mode this guard exists for is not reachable yet"_       | `eval-run --no-mock-mode` is registered at `cli.py:888`. Real mode is reachable today; the guard is simply not on that path.                                                                                                                            |
