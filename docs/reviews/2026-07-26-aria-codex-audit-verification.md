# ARIA Codex Audit — Independent Source Verification (2026-07-26)

Cycle: `2026-07-26-aria-codex-audit-verification`
Verified commit: `bdaf00bf633151927740304985551a012e5e2e5c` (same commit the Codex report audited)
Scope: `aria-kernel/aria_kernel/**`, `tools/aria-poc/**`, `.github/workflows/aria-*.yml`, `.gitignore`,
plus live-remote branch/tag triage for the report's §19.

Method: every claim was re-derived from source at the audited commit. Where a claim was
falsifiable by execution, it was **executed** rather than reasoned about (breaker state machine,
Jaccard/revision independence layers, `poll_pr_checks` empty-set behaviour, the
`feat/aria-autonomous-mode` summary parser). Claims about the live GitHub Actions artifact were
**not** re-fetched; instead the code paths that *produce* each reported number were verified, which
independently explains every figure the report cited.

## Verdict

The Codex report is substantially accurate. **All 15 P0 findings are confirmed.** Eight are more
severe than described. Three framings are too harsh and are corrected below. Four findings are new.

The report's central thesis — *code exists, is not connected to a production call chain, and is
reported as green* — is verified in its strongest possible form:

| Structural fact | Evidence |
|---|---|
| 4 policy functions with **zero** production callers | `assert_within_budget`, `record_actual_usage`, `reserve_cycle_budget`, `circuit_breaker.record_failure` |
| 1 function the orchestrator calls that **does not exist** | `replay_pending_bridges` |
| 2 of 3 independence layers that **cannot fire**, proven by execution | `independence_check` layers 2 + 3 |
| 4 summary counters structurally pinned to zero | `incomplete_lifecycle_count`, `warning_count`, `suppressed_count`, `truncated_count` |
| the agent queue directory is gitignored **out of its own consumer's filesystem** | `.gitignore:205` vs `aria-agent-executor.yml` |
| the canonical schema validator has zero callers **and** would reject every production envelope | `validate_request` vs `must_satisfy[].statement` |

Autonomous write/merge must stay closed. That conclusion is unchanged.

## Registered finding IDs

This document is the SSoT for the finding IDs below; the hash-chained registry entries carry their
state. IDs were allocated by `npm run findings:add` (which mints the sequence itself, so the audit
report's `P0-*` / `NEW-*` labels are the analysis names and these are the tracked names).

| Registry ID | Audit label | Severity | Finding |
|---|---|---|---|
| `ORPHAN-CRITICAL-418` | NEW-01 | CRITICAL | corrupting the failure ledger un-trips the breaker |
| `ORPHAN-CRITICAL-419` | P0-02 | CRITICAL | producer and executor share no queue |
| `ORPHAN-CRITICAL-420` | P0-07 | CRITICAL | budget + breaker have zero production callers |
| `ORPHAN-HIGH-421` | P0-10 / NEW-02 | HIGH | all three independence layers non-functional |
| `ORPHAN-HIGH-422` | P0-15 | HIGH | HUMAN_REQUIRED becomes `no_gaps` |
| `ORPHAN-HIGH-423` | P0-09 | HIGH | specialist gate fails open in `standard` and `autonomous` |
| `ORPHAN-HIGH-424` | P0-01 | HIGH | summary counters pinned to zero; invalid state published |
| `ORPHAN-HIGH-425` | P0-14 | HIGH | installation token full-scope; TTL is fiction |
| `ORPHAN-HIGH-426` | P1-03 + operator direction | HIGH | HUMAN_REQUIRED waits on a human indefinitely, and the sweep that makes it visible has CLI-only callers |
| `ORPHAN-CRITICAL-427` | hunt | CRITICAL | The bash sandbox perimeter has no kernel caller |
| `ORPHAN-CRITICAL-428` | hunt | CRITICAL | HARD_FAIL_CHECKS is a pure-data registry with no callable field and zero production i… |
| `ORPHAN-HIGH-429` | hunt | HIGH | Gate B oscillation guard has no caller while the streak it reads only ever increments |
| `ORPHAN-HIGH-430` | hunt | HIGH | ARIA-Watchdog goes permanently silent after its first poll because the daemon's own g… |
| `ORPHAN-HIGH-431` | hunt | HIGH | The banned-phrase HARD-reject check scans envelope keys the production submission nev… |
| `ORPHAN-MEDIUM-432` | hunt | MEDIUM | Architecture Spine Gate drops unreadable or undecodable files from the invariant viol… |
| `ORPHAN-HIGH-433` | hunt | HIGH | The aria-tools publication integrity gate verifies only a small fraction of the decla… |
| `ORPHAN-HIGH-434` | hunt | HIGH | The daily report PR can never be staged |
| `ORPHAN-HIGH-435` | this session | HIGH | The kernel test suite inherits the agent container's global git config |
| `ORPHAN-MEDIUM-436` | this session | MEDIUM | The test_gate_canonical_suite policy named mutation and coverage gates that do not ex… |
| `ORPHAN-HIGH-437` | this session | HIGH | The hard-fail perimeter is one undifferentiated gate |
| `ORPHAN-HIGH-438` | this session | HIGH | Five declared pre-PR-open hard-fail checks have no implementation |
| `ORPHAN-HIGH-417` | this session | HIGH | the ID allocator and the trailer resolver each read only half the ORPHAN identifier space |
| `ORPHAN-CRITICAL-439` | this session | CRITICAL | no sandbox backend is installed anywhere, so write containment refuses every spawn |
| `ORPHAN-CRITICAL-440` | this session | CRITICAL | the observe burn-in rejects the runtime writes it exists to produce |
| `ORPHAN-HIGH-441` | this session | HIGH | the commit-msg traceability hook binds for nobody — `prepare` never runs under `--ignore-scripts` |
| `SUPPLY-HIGH-001` | this session | HIGH | four high advisories block a required check; the suggested fix breaks the build |
| `ORPHAN-MEDIUM-442` | self-audit of this branch | MEDIUM | a `# type: ignore` was added on the Gate C verdict — the value that decides whether the specialist gate blocks |
| `ORPHAN-HIGH-443` | self-audit of this branch | HIGH | the Gate C block policy is a denylist, so an unrecognised verdict passes as a clean review |
| `ORPHAN-MEDIUM-444` | self-audit of this branch | MEDIUM | the debt-plan repin script wrote all three mirror files before refusing, contradicting its own docstring |
| `ORPHAN-MEDIUM-445` | self-audit of this branch | MEDIUM | the ARIA authority hash had a checker and no writer, so refreshing it meant copying a value out of a Jest failure |
| `ORPHAN-CRITICAL-446` | adversarial re-audit | CRITICAL | the independence gate never receives the cross-reviewer's text, so the diversity layer computes neither comparison and every `converged` verdict is downgraded |
| `ORPHAN-HIGH-447` | adversarial re-audit | HIGH | the two tests pinning the specialist gate can silently skip themselves instead of failing |
| `ORPHAN-MEDIUM-448` | adversarial re-audit | MEDIUM | the repin script silently no-ops on anchor drift and exits 0, and was the one gate script nothing type-checked |

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

| ID | Status | Severity vs report |
|---|---|---|
| P0-01 invalid state published as `ok` | CONFIRMED | **worse** — 4 pinned counters, not 2 |
| P0-02 producer/executor share no queue | CONFIRMED | **worse** — structural certainty, not observation |
| P0-03 scheduled path never reaches code/PR | CONFIRMED | as described |
| P0-04 "read-only" roles are unrestricted Claude | CONFIRMED | **worse** — unconditional, all roles |
| P0-05 profile downgrade does not revoke authority | CONFIRMED | as described |
| P0-06 cross-host lease/CAS is a local file | CONFIRMED | **worse** — no compare at all |
| P0-07 budget + breaker are decoration | CONFIRMED | **worse** — literally zero callers |
| P0-08 role/request schema is not single-source | CONFIRMED | **worse** — mismatch is bidirectional |
| P0-09 specialist gate cannot complete, fails open | CONFIRMED | **worse** — autonomous is fail-open too |
| P0-10 "three independent agents" proves nothing | CONFIRMED | **worse** — 2 layers provably inert |
| P0-11 dual lanes + global PR scan | CONFIRMED | see Correction 2 |
| P0-12 intake/approval identity untrustworthy | CONFIRMED | as described |
| P0-13 required check is not merge authority | CONFIRMED | see Correction 1 |
| P0-14 credential/signer isolation absent | CONFIRMED | **worse** — `repositories` key absent entirely |
| P0-15 review can report `no_gaps` unverified | CONFIRMED | **worse** — HUMAN_REQUIRED becomes approval |

### P0-01 — four counters, not two
`cycle.py:646` pins `"incomplete_lifecycle_count": 0` in the per-cycle state dict.
`runtime_artifacts.py:756` then *sums that field across cycles* — so the aggregate is structurally
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
queue directory *cannot exist* in the executor's filesystem, and
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
adversarial judges, cross-reviewers and planners identically. `ci_executor.py:929-944` *audits* the
inherited `CLAUDE_*`/`ANTHROPIC_*`/`HOME`/`USER` environment into a governance event but never
strips it.

### P0-06 — the compare is missing, not just remote-invisible
The module docstring (lines 32-34) states plainly: *"The lease is NOT a mutex (no kernel-side
locking primitive). It is a TRUSTED-WITNESS contract."*

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

* `primary_revision_id=f"{plan_id}-r1"`, `challenger_revision_id=f"{plan_id}-c1"`,
  `cross_review_revision_id=None` — synthesized constants, never real revision ids;
* `primary_text="(primary plan text — not loaded at convergence; ...)"`,
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

| ID | Status | Note |
|---|---|---|
| P1-01 manifest covers half the surfaces | CONFIRMED | 129 raw `append_jsonl(` sites outside `ledger.py` vs 116 `append_declared_jsonl(` |
| P1-02 restore source unverified | CONFIRMED | takes `live[0]`; no run-conclusion/branch/commit/producer check; missing artifact → silent fresh bootstrap; only `aria-tools/` carried |
| P1-03 HUMAN_REQUIRED lost between views | CONFIRMED | `sweep_lease_lifecycle_for_human_required` has CLI-only callers (`cli.py:3457,3482`) |
| P1-04 cycle lifecycle not crash-safe | CONFIRMED | no outer `try/finally` terminal guarantee around the phase chain |
| P1-05 claim/worker heartbeat gaps | CONFIRMED | `heartbeat` + reaper reachable only from CLI |
| P1-06 bridge "replay" does not exist | CONFIRMED (root cause found) | see below |
| P1-07 memory counts repetition as confidence | CONFIRMED | `memory.py:589` unconditional `support_count + 1`; `:598` `+ min(0.05, support_count*0.005)`; no `evidence_hash` dedup |
| P1-13 ProfileGate injected, never called | CONFIRMED | `grep "profile_gate\."` → **zero hits**; defaulted to `NoOpProfileGate()` at `autonomy_orchestrator.py:469-471` |
| P1-15 daily report runs on empty state | CONFIRMED | `aria-daily-report.yml` has no state-restore step |

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
(`auto_action_gate.py:206-218`, comment: *"fail-closed-but-permissive"*), **every** failure mode of
the breaker subsystem resolves to "allow".

The module's in-code rationale inverts the correct direction: it argues that *"failing closed on a
single bad row should NOT block the breaker's current-state read"*. For a safety net the opposite
holds — unreadable failure evidence must read as `tripped`, never as `ok`. This is a Tier-1 fixable
defect (make the state derivation refuse to answer `ok` on a corrupt or unreadable ledger).

### NEW-02 (HIGH) — the independence check needs a decision, not a repair
Split out from P0-10 because the remediation differs. P0-10's fix is correct request-ID plumbing;
NEW-02 is that layers 2 and 3 are *decoration with a security-sounding name*. Either real revision
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
*before* any rewiring — require a non-empty result set intersected against an explicit
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

* `:55-57` requires `head_sha`, raising `merge_authority_head_sha_required` when absent;
* `:142-160` re-fetches the PR and re-evaluates immediately before merging;
* `:178-189` blocks with reason `"PR head SHA changed after green evaluation"`;
* `:191-197` passes `expected_head_sha` and arms `authority_token = f"merge-authority:{pr}:{head_sha}"`.

This is the right foundation. P0-13's fix is to **promote this existing kernel gate into the required
check**, not to design a head-binding mechanism from scratch.

### Correction 2 — the V9 merge path is already disabled, not merely orphaned
`evaluate_v9_implementation_merge` (`auto_merge_runners.py:564-591`) unconditionally returns
`eligible=False` with `rejection_class="v9_merge_path_disabled_use_merge_if_green"`. Its docstring
states it "must never call `gh pr merge`". So `auto_merge.merge_if_green` / `merge_pr_if_ready`
genuinely is the single merge executor. The report's §19.2 implication that enabling `autonomous`
re-opens a second merge executor is inaccurate. P0-11's real risk is the **candidate set** being
global, not two competing executors — which narrows the fix considerably.

### Correction 3 — `AutoActionGate` is fail-closed on a *tripped* breaker
`auto_action_gate.py:103-104` forces `human_ack_required = True` whenever `breaker_state != "ok"`,
and `AUTONOMOUS_AUTO_ACK_LANES` is empty so it returns `True` on every path today. The fail-open is
narrower than the report states: it is specifically the *unreadable-state* path, which NEW-01 now
covers with a concrete reproduction. Worth recording precisely, because the report's phrasing
suggests the tripped-breaker path itself is permissive, and it is not.

---

## 5. Live-branch and archive triage (report §19)

Re-verified against live remote heads:

| Claim | Result |
|---|---|
| 58 remote branches | 59 now (one added since the report) |
| `feat/aria-autonomous-mode` — 1 commit ahead, touches ARIA workflow | CONFIRMED (`aria-auto-cycle.yml` +130, `.gitignore` +4, `workflow_contract_registry.py` +7, 1 new test +88, docs) |
| `fix/production-host-control-plane` — 3 ahead, no ARIA paths | CONFIRMED. The report's own "23 aria matches" would be a false positive: those paths match the substring inside *inv**aria**nt* (`tests/invariants/**`, `backup-manifest-invariant.yml`). No ARIA kernel or ARIA workflow file is touched. |
| `dependabot/.../setup-node-7.0.0` — 1 ahead, no functional ARIA fix | CONFIRMED |
| Registry at ~1,033 entries on current `main` | CONFIRMED (`docs/reviews/_registry/findings.jsonl` = 1033 lines) |
| No P0 is closed on any other branch | CONFIRMED |

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

A six-lens hunt was run over the kernel, executors and workflows looking for the *shape* of NEW-01
— declared authority with no caller, and damaged evidence reading as success. Each finding was
handed to an adversarial verifier instructed to refute it by default and to reproduce it or drop it.
**Six were confirmed, none refuted.** Two further workflow findings were reproduced independently
here. All are registered.

| ID | Severity | Finding |
|---|---|---|
| `ORPHAN-CRITICAL-427` | CRITICAL | the bash sandbox perimeter has no kernel caller — `wrap_bash_in_sandbox` returns argv unchanged, so containment is prose addressed to the process being contained |
| `ORPHAN-CRITICAL-428` | CRITICAL | `HARD_FAIL_CHECKS` is 17 names with no callable field and zero iterators; `expert_review_gate.py` has zero production callers; a count-pinning test passes green |
| `ORPHAN-HIGH-429` | HIGH | Gate B oscillation guard has no caller while its streak only increments — fix/reopen loops unbounded, and a runbook points operators at a file that can never be written |
| `ORPHAN-HIGH-430` | HIGH | ARIA-Watchdog goes silent after its first poll: its own governance writes advance the read cursor past the events it should see (zero findings in 15 iterations) |
| `ORPHAN-HIGH-431` | HIGH | the banned-phrase hard-reject check reads keys the production envelope never has — 11 of 12 banned phrases present, `hits: []`, on 100% of submissions |
| `ORPHAN-MEDIUM-432` | MEDIUM | Architecture Spine Gate drops unreadable files from the violation count; deleting `apps/`+`libs/` scores as improvement (latent) |
| `ORPHAN-HIGH-433` | HIGH | **the publication integrity gate added in this session covers only a fraction of the declared state surfaces** |
| `ORPHAN-HIGH-434` | HIGH | the daily report can never be staged — `.gitignore` excludes the parent directory, so no chain-tip anchor has been committed since 2026-05-08 |
| `ORPHAN-HIGH-435` | HIGH | the kernel test suite inherits the agent container's global git config, so every fixture commit invokes an external signing binary and the suite can redden for reasons unrelated to the code under test |

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
**not** the full guarantee the commit implied. Closing 348 means extending coverage to every declared
surface, which is the same work as P1-01.

`ORPHAN-HIGH-434` also explains a data point visible from the start and not chased: the newest daily
anchor tracked in git is `2026-05-08.md`.

### Traceability correction for `f46324323`

That commit's footer reads `Closes: …#ORPHAN-CRITICAL-427`. That is wrong on both counts and is
corrected here rather than by rewriting history, since force-push is forbidden:

* the commit's subject is the **343** work (the executable hard-fail registry); 342 was closed by
  `873f038f8`, the preceding commit;
* **343 is NOT closed.** Five of its 17 checks are bound to real implementations; twelve bind an
  explicit failing `_not_implemented`, and the report is not threaded into
  `pr_manager.open_pr_for_action` or `auto_merge.merge_if_green` yet.

`ORPHAN-CRITICAL-428` stays `OPEN` — owner okan, deadline 2026-08-02 — until the twelve
implementations and the two call sites land. Autonomous merge stays closed until then. Read
`f46324323` as "partial progress on 343", never as a closure of anything.

**Phase A update.** The five mechanical pre-PR-open checks now have real implementations, so all ten
`pre_pr_open` entries are executable and the seven still bound to `_not_implemented` are exactly the
`pre_merge` set. Two things surfaced while building them, both worth recording because they change
what the registry means:

* `kernel_self_modification_blocked_at_envelope_mint` and `forbidden_scope_normalized` are **not**
  duplicates, and a reader who assumes they are would delete the wrong one. The mint check is purely
  lexical over the envelope's declared `affected_surfaces` — no filesystem — which is precisely why
  it works at mint time; the scope check resolves real paths through a workspace and returns
  `workspace_root_absent` at that point. A test asserts the difference directly.
* The registry described the canonical validation suite as "nx affected, type-check, mutation,
  coverage". This repository has **no** mutation-testing script and **no** coverage target, so that
  gate could never have been satisfied. It was invisible because the check bound `_not_implemented`
  and failed for that reason instead — an unsatisfiable requirement hiding behind an unbuilt one.
  The check is implemented against the three commands that exist and the description corrected to
  match; the genuine platform gap is registered as `ORPHAN-MEDIUM-436` rather than dropped.

`343` remains OPEN: the seven pre-merge checks and the two call sites
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
a self-attested `sandbox_available` with no production caller, sitting directly on top of 342 — was
found and not written up.

The method gap worth fixing: the caller census was a one-level AST scan classifying test versus
production by path. It did not resolve `python3 -m aria_kernel <subcommand>` strings inside workflow
YAML, nor compute reachability from real entrypoints — a symbol with one production caller that is
itself unreachable still counts as wired. The Tier-3 generalisation of 342/343/344 is a CI check that
diffs the gates *declared* in the plan and policy documents against the set actually reachable from
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
account. Remaining after the revert: two root advisories — `brace-expansion` (with
eslint/glob/minimatch/rimraf/gaxios/gcp-metadata transitive through it) and `typeorm`.

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

## 10. Limits of this verification

* The live GitHub Actions artifact was not re-downloaded. Every figure the report cited was instead
  explained from source (21/21 bridge `skipped` ⇒ P1-06; 0 tool runs ⇒ NoOp implementer; 13
  HUMAN_REQUIRED invisible ⇒ P1-03; cost dashboard 0 alongside 55 attribution rows ⇒ P0-07's zero
  callers). This is corroboration by mechanism rather than re-measurement.
* The report's P2 claim that 29 modules lack direct test imports was not independently re-derived;
  it is recorded as-is and remains a static signal, not proof of missing coverage.
* Branch protection rulesets and the GitHub App installation scope cannot be read from inside the
  repository and remain externally unverified — which is itself part of P0-14's exposure.
