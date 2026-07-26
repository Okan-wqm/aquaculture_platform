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
| `ORPHAN-CRITICAL-333` | NEW-01 | CRITICAL | corrupting the failure ledger un-trips the breaker |
| `ORPHAN-CRITICAL-334` | P0-02 | CRITICAL | producer and executor share no queue |
| `ORPHAN-CRITICAL-335` | P0-07 | CRITICAL | budget + breaker have zero production callers |
| `ORPHAN-HIGH-336` | P0-10 / NEW-02 | HIGH | all three independence layers non-functional |
| `ORPHAN-HIGH-337` | P0-15 | HIGH | HUMAN_REQUIRED becomes `no_gaps` |
| `ORPHAN-HIGH-338` | P0-09 | HIGH | specialist gate fails open in `standard` and `autonomous` |
| `ORPHAN-HIGH-339` | P0-01 | HIGH | summary counters pinned to zero; invalid state published |
| `ORPHAN-HIGH-340` | P0-14 | HIGH | installation token full-scope; TTL is fiction |
| `ORPHAN-HIGH-341` | P1-03 + operator direction | HIGH | HUMAN_REQUIRED waits on a human indefinitely, and the sweep that makes it visible has CLI-only callers |

Remaining confirmed P0/P1 findings (P0-03, P0-04, P0-05, P0-06, P0-08, P0-11, P0-12, P0-13, NEW-03,
NEW-04, and the P1 set) are registered in the wave that closes them, so an OPEN finding always has a
current owner rather than a placeholder.

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
| `ORPHAN-CRITICAL-342` | CRITICAL | the bash sandbox perimeter has no kernel caller — `wrap_bash_in_sandbox` returns argv unchanged, so containment is prose addressed to the process being contained |
| `ORPHAN-CRITICAL-343` | CRITICAL | `HARD_FAIL_CHECKS` is 17 names with no callable field and zero iterators; `expert_review_gate.py` has zero production callers; a count-pinning test passes green |
| `ORPHAN-HIGH-344` | HIGH | Gate B oscillation guard has no caller while its streak only increments — fix/reopen loops unbounded, and a runbook points operators at a file that can never be written |
| `ORPHAN-HIGH-345` | HIGH | ARIA-Watchdog goes silent after its first poll: its own governance writes advance the read cursor past the events it should see (zero findings in 15 iterations) |
| `ORPHAN-HIGH-346` | HIGH | the banned-phrase hard-reject check reads keys the production envelope never has — 11 of 12 banned phrases present, `hits: []`, on 100% of submissions |
| `ORPHAN-MEDIUM-347` | MEDIUM | Architecture Spine Gate drops unreadable files from the violation count; deleting `apps/`+`libs/` scores as improvement (latent) |
| `ORPHAN-HIGH-348` | HIGH | **the publication integrity gate added in this session covers only a fraction of the declared state surfaces** |
| `ORPHAN-HIGH-349` | HIGH | the daily report can never be staged — `.gitignore` excludes the parent directory, so no chain-tip anchor has been committed since 2026-05-08 |
| `ORPHAN-HIGH-350` | HIGH | the kernel test suite inherits the agent container's global git config, so every fixture commit invokes an external signing binary and the suite can redden for reasons unrelated to the code under test |

### `ORPHAN-HIGH-350` — the gate that every other gate depends on

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

### `ORPHAN-HIGH-348` corrects a claim made in this same session

The `ORPHAN-HIGH-339` commit message says publication is now fail-closed. That is true only for the
surfaces `integrity verify` actually hashes. `STATE_SURFACES` declares **160** surfaces while
`covered_tool_ledgers()` returns a small subset — 4 in a bare tree, ~28 once conditional files
exist. Uncovered surfaces include `enterprise_acceptance_events`, `autonomy_state`,
`cost_attribution`, `cost_budget`, `cost_telemetry` and `handoffs`. A cycle killed mid-append to any
of those still yields `status: ok`, so `state_valid=true` and the damaged tree is published under the
canonical name with `overwrite: true`, destroying the last good copy.

So the gate is a real improvement over the unconditional `if: always()` upload it replaced, and it is
**not** the full guarantee the commit implied. Closing 348 means extending coverage to every declared
surface, which is the same work as P1-01.

`ORPHAN-HIGH-349` also explains a data point visible from the start and not chased: the newest daily
anchor tracked in git is `2026-05-08.md`.

### Traceability correction for `f46324323`

That commit's footer reads `Closes: …#ORPHAN-CRITICAL-342`. That is wrong on both counts and is
corrected here rather than by rewriting history, since force-push is forbidden:

* the commit's subject is the **343** work (the executable hard-fail registry); 342 was closed by
  `873f038f8`, the preceding commit;
* **343 is NOT closed.** Five of its 17 checks are bound to real implementations; twelve bind an
  explicit failing `_not_implemented`, and the report is not threaded into
  `pr_manager.open_pr_for_action` or `auto_merge.merge_if_green` yet.

`ORPHAN-CRITICAL-343` stays `OPEN` — owner okan, deadline 2026-08-02 — until the twelve
implementations and the two call sites land. Autonomous merge stays closed until then. Read
`f46324323` as "partial progress on 343", never as a closure of anything.

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

## 9. Limits of this verification

* The live GitHub Actions artifact was not re-downloaded. Every figure the report cited was instead
  explained from source (21/21 bridge `skipped` ⇒ P1-06; 0 tool runs ⇒ NoOp implementer; 13
  HUMAN_REQUIRED invisible ⇒ P1-03; cost dashboard 0 alongside 55 attribution rows ⇒ P0-07's zero
  callers). This is corroboration by mechanism rather than re-measurement.
* The report's P2 claim that 29 modules lack direct test imports was not independently re-derived;
  it is recorded as-is and remains a static signal, not proof of missing coverage.
* Branch protection rulesets and the GitHub App installation scope cannot be read from inside the
  repository and remain externally unverified — which is itself part of P0-14's exposure.
