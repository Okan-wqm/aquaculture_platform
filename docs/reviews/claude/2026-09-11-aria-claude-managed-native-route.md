# The managed Anthropic session joins the native lane

**Date:** 2026-09-11 · **Agent:** claude · **Cycle:** 2026-09-11 Codex handoff — native routes
**Finding:** ARIA-HIGH-074 — closed by this branch; this document is its evidence.

## Symptom

Every native admission on the connected candidate reported the Anthropic
row as `auth_observation: unknown`, `status_reason:
supported_auth_status_unavailable`, `controls: unknown` — the executor's
`observe_status` had a Codex branch, then a Z.ai branch, and a comment
saying the legacy version/file preflight "is not supported native auth
proof". So the one provider with a logged-in `max` subscription on this
host could never be selected natively, and a native run could not reach
the write-capable route ARIA needs for implementation.

Two more defects surfaced when the route was first exercised. The legacy
`invoke_claude_cli` still applied the ARIA-AUDIT-021 nominal-dollar
reservation under the managed-subscription policy that ORPHAN-HIGH-472
had retired for the dispatch budget, and both of its refusal branches
passed a **string** as `failure` to a writer that reads
`.failure_class` — `AttributeError: 'str' object has no attribute
'failure_class'` on every refusal.

## Fix

- `claude_runtime._probe_claude_auth_status`: runs `claude auth status
--json` (a non-model command; the mirror of `codex login status`) under
  a scrubbed environment and classifies its typed answer: logged in on
  `claude.ai` → `available` / `subscription` /
  `managed_session_logged_in`; logged in another way → `unavailable` /
  `api_key_auth_not_managed` (the binding table admits only the
  subscription); logged out → `managed_session_logged_out`; non-JSON,
  non-zero or slow → `unknown`. Email and org fields are not recorded.
- `ManagedClaudeContext` carries the auth method, the config dir and the
  same `spawn_settings_hash` the session fingerprint uses, so the attempt
  row and the fingerprint agree.
- `ci_executor.observe_status` admits the route when the status is
  available and the containment backend exists; `_invoke_native_claude`
  reserves the attempt, runs the existing `invoke_claude_cli` (agent_env
  build, bwrap containment, cancel polling, contract prefix, sealed
  envelope, usage attribution), rebinds the sealed envelope to the attempt
  ledger hash, refuses a result without usage, and writes the finished row
  with the session id, the usage row and the contract hash. The
  exception classification is by type inside one generic handler so the
  module keeps exactly one `except ClaudeAuthFailure` — the one that
  releases the claim (test_claude_auth_failure_classification).
- `model_fleet._native_runtime_admission`: the Anthropic route runs the
  agent's declared tier (its frontmatter) as the legacy spawn does, unless
  that tier belongs to another provider.
- `invoke_claude_cli`: the dollar reservation applies under the metered
  policy only; both refusal branches build a typed `DispatchFailure`
  (`policy_violation`, `cost_reservation_refused[_pricing_unknown]`), and a
  non-zero child exit now surfaces a bounded, lease-redacted
  `claude_stderr_tail` — the first run of this lane failed silently with
  `bwrap: execvp claude: No such file or directory` until it did.

## Proof

`tests/test_ci_executor_native_claude.py` (3): the ACTUAL executor child,
ACTUAL kernel claim/submit, a fake `claude` that answers `--version`,
`auth status --json` and the `-p` stream-json run — a logged-in claude.ai
session admits, the sandboxed spawn receives the contract-prefixed prompt
with no provider key in its environment, the result is sealed with the
attempt hash and ACCEPTED, the finished row names the session, usage and
contract; an API-key login is refused as `api_key_auth_not_managed` and a
logged-out session as `managed_session_logged_out`, both leaving the
request PENDING with no attempt burned. Affected suites (153) OK.

Live: `claude auth status --json` on this host reports the operator's
`max` subscription as `claude.ai` — the probe returns
`available / subscription / managed_session_logged_in`.

## Addendum — ARIA-HIGH-075: one stalled probe starved the fleet

**Finding:** ARIA-HIGH-075 — closed by this branch; this section is its evidence.

Trial four on Codex (`AIR-aria-challenger-planner-1809efa4dcb9`), second
dispatch, 2026-09-11T21:24Z, host at 96 % swap: the Anthropic probe hit its
20 s limit — `status_timeout`, honest; the same command ran in 0.35 s once
the pages were back — and the Codex row, third in fleet order, was recorded
`status_deadline_elapsed` with an empty status command. It was never asked.
The executor had set the admission deadline to `now +
recheck_timeout_seconds`: one probe's budget handed to the whole fleet.

`recheck_timeout_seconds` is a per-probe budget (the loop already bounded
each member by `min(recheck, remaining)`); the fleet now owns the
arithmetic — `native_admission_budget_seconds(policy)` is one recheck per
fleet member, `_native_runtime_admission` computes its own deadline from it
and no longer takes one — so a first probe that stalls to its limit costs
nobody behind it, and an overrun that ignores its limit costs only the
members behind it, named as such. `tests/test_native_admission_status_budget.py`
(4) pins both, plus the executor's absence of any deadline of its own.

## Addendum — ARIA-HIGH-076: the limiter was probed in one environment and launched in another

**Finding:** ARIA-HIGH-076 — closed by this branch; this section is its evidence.

Trial six, cross-review (`AIR-aria-cross-reviewer-1da71e60e0ee`, dispatch
two, 2026-09-11T21:57Z): the managed Anthropic route was admitted natively
for the first time — `runtime_attempt_started` with provider `anthropic`,
runtime `claude`, auth `subscription`, model `opus` — and the spawn exited
1 four seconds later with `claude_stderr_tail: Failed to connect to bus: No
medium found`. `runtime_attempt_finished` recorded it as `provider_nonzero`
with no usage: the model was never reached.

`run_claude_exec` called `apply_resource_limits` with no environment, so
the kernel's cached host probe ran `systemd-run --user … /bin/true` in the
**executor's** environment — which, under an operator session, carries
`DBUS_SESSION_BUS_ADDRESS` — and selected the cgroup limiter; the spawn then
launched that limiter with the **built** agent environment (an allowlist the
bus is not on). ORPHAN-HIGH-470's own text names the rule: a host cache
cannot establish capability for a different child control environment. The
Codex lane already obeyed it by hand (probe in the launch environment,
`/usr/bin/env` prefix for the limiter, bwrap `--clearenv` for the model).

The kernel helper owns both halves for every lane now:
`LIMITER_CONTROL_ENV_NAMES` names the plumbing, `limiter_control_environment`
reads it by name, and `apply_resource_limits(argv, environ=…,
control_environment=…)` probes in `environ ∪ plumbing` and, when
`systemd-run` is selected, emits `env NAME=VALUE … systemd-run … env -u
NAME … <command>` — the limiter gets the bus, the command gets exactly the
environment its lane built. The Codex wrapper drops its hand-rolled prefix
and the Claude spawn passes its built environment and `os.environ` as the
plumbing source. On a runner without a user bus the probe fails as before
and the `timeout` limiter is selected — nothing about that path changed.

Proof: `test_ci_executor_native_claude.test_the_limiter_receives_the_bus_and_the_agent_does_not`
— a limiter that refuses without the bus, an executor environment that has
it, an agent that records the names it sees: the probe and the run both
carry the bus, the request is ACCEPTED, the agent saw neither name. On the
pre-fix spawn the same test fails with the live message. The existing Codex
plumbing test passes unchanged through the shared helper.

## Addendum — ARIA-HIGH-077: what the attempt named was not what ran

**Finding:** ARIA-HIGH-077 — closed by this branch; this section is its evidence.

Trial six, cross-review, dispatch three (2026-09-11T22:22Z), with the
limiter fixed: the spawn ran 164 s and exited 1 — `Settings file not found:
/tmp/aria-spawn-settings/aria-settings-AIR-aria-cross-reviewer-1da71e60e0ee.json`.
The file existed on the host (0600, written 22:22:37). Three things were
wrong at once, all inside the write-containment sandbox the judge shape
runs under:

- **A different CLI ran.** The spawn named `claude`; the sandbox binds
  `/usr` and not `~/.local`, so `PATH` inside it resolved
  `/usr/local/bin/claude` — the npm install, 2.1.233 — while the executor
  had probed `~/.local/bin/claude`, 2.1.269. The attempt row's identity
  and the process were two installations.
- **The spawn's own documents were hidden.** Settings and MCP config were
  written under the host `/tmp`; the sandbox mounts a fresh tmpfs there.
  On the CI runner `RUNNER_TEMP` moves them elsewhere, which is why this
  never surfaced in a nightly — and why it would have, on the next host.
- **The operator's whole login directory was bound read-only.** The CLI
  writes its own state into its config dir; on a read-only mount it stalls.
  Measured with the real CLI in the real sandbox, one-turn haiku run: 37 s
  with the directory bound, 2.7 s with a private home holding only the
  credential file.

And one more, observed on the same dispatch: the operator session's own
child exports (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, …) reached
the executor and passed the `CLAUDE_CODE_` configuration-prefix filter into
the agent — nesting it under the interactive session instead of the
kernel's `--session-id`.

**Fix.** `implementation_safety.wrap_managed_claude_in_sandbox` — the
mirror of the Codex lane's runtime-state wrapper — binds exactly what the
spawn depends on: the executable resolved OUTSIDE the sandbox (run by that
absolute path), the parent directories of the documents written for this
spawn (refused by name if they overlap the workspace), and the login
directory's `.credentials.json` alone, into the private home's `.claude`,
which `--setenv CLAUDE_CONFIG_DIR` makes the CLI's config dir; a login
carried by `CLAUDE_CODE_OAUTH_TOKEN` binds nothing. `run_claude_exec`
resolves the CLI once on the built environment's PATH
(`_resolve_claude_executable`, symlinks followed) and runs that path in
every shape. `agent_env.CLAUDE_INSTANCE_ENV_NAMES` names the session's
child exports and keeps them out.

**Proof.** `tests/test_managed_claude_sandbox.py` (6) pins the wrapper's
mounts; the executor lane test now records, from inside the real sandbox,
the executable that ran, the visibility of both documents, the config dir
and the credential file, and the absence of the host login directory;
`I-V12-ENV-03` follows the new contract with a fixture binary; the env
invariants gain the session-identity exclusion. Live evidence follows in
the next section.

## Live evidence — the first managed-Claude native run, and ARIA-HIGH-078

Trial six, cross-review, dispatch four (`AIR-aria-cross-reviewer-1da71e60e0ee`,
claim `claim_f7acce6ca4be2ad1`, 2026-09-11T22:39:15Z → 22:44:03Z): with
ARIA-HIGH-075/076/077 in place the managed Anthropic route ran end to end for
the first time — `runtime_attempt_started` (`anthropic` / `claude` /
`subscription`, model `opus`, effort `max`), the real CLI inside the real
sandbox, `claude_returned_exit=0` after 334 s, the usage row ledgered
(`usage_ledger_hash` on `runtime_attempt_finished`, `result_admission
pending_native_submit`), `pre_submit_validation_passed`. The 23.6 KB answer
is a grounded bidirectional review: 13 evidence references, two blocking
risks against the seed primary ("a restatement of the task, not a plan"),
a narrowing recommendation for the challenger's surfaces.

The kernel rejected it at submit: `response_schema:
satisfaction_matrix[0].note required when verdict='contradicted'`. The
model had put its reason under `evidence` — exactly as anchor 3 of its own
contract said (`{id, verdict, evidence_refs?, evidence?}` … "the kernel
reads `id` + `verdict` only"), and as the canonical-envelope SSoT skeleton
showed (no `note` field). The validator has required `note` +
`evidence_refs` on `blocked`/`contradicted` all along. The contract and
the validator disagreed, and the model obeyed the contract.

Then the executor tried to release the claim (`reason=submit_rejected`),
the kernel refused — `claim … result already terminal`, because a REJECTED
result row IS the claim's terminal effect — and the executor printed "The
request stays CLAIMED and no later run can pick it up", which is false:
`derive_request_state` returns `REJECTED` from that row, and the drainer
escalates the plan (`convergence_envelope_dead:cross_review`).

**Fix (ARIA-HIGH-078).** `agent_contract.render_response_validator_contract()`
renders the validator's rules — required fields, statuses, verdicts, the
`note` + `evidence_refs` requirement, banned phrases, refusal classes — from
the constants the validator itself uses, and `agent_contract_delivery`
appends it to every delivered contract, after the inlined knowledge: the
validator speaks last, and prose can no longer promise what submit refuses.
The three prose sites are corrected too. `ci_executor` releases only when
the submit refused BEFORE a result row (`_rejected_result_recorded` reads
the kernel's own answer); a recorded rejection is logged as the terminal
effect it is. The lifecycle-leak invariant — red on the candidate since the
executor's `main` → `_main` split — follows `_main` and scopes its check
to the window in which a claim is actually held.

**Proof.** `test_agent_contract_delivery` (2 new): the delivered contract
ends with the rendered rules, and the live envelope's shape is rejected by
`validate_response` exactly as recorded while the same entry with `note`
passes. `test_agent_claim_lifecycle_leak` (2 new): the kernel's rejected
document is recognised, a pre-row refusal is not, and the release sits in
the `else` of that test.

**Not this finding.** The trial-six plan is now `HUMAN_REQUIRED`
(`convergence_envelope_dead:cross_review`) by design — one rejected
envelope ends the round. The next live cross-review runs on a fresh trial
with the corrected contract.

## Addendum — ARIA-HIGH-079: the dollar gate read the wrong policy and gated a subscription

Trial eight, cross-review (`AIR-aria-cross-reviewer-f7ddfbedc372`,
2026-09-12T00:46Z), after an accepted challenger on managed Claude (fable,
829 s): admission chose the Anthropic route and the spawn was refused before
any model — `cost_budget_daily_cap_exceeded: projected=6.227328 cap=5.0`,
twice, `control_or_transport_unavailable`. The workspace's own
`aria-config/genesis_policy.json` says `monetary_admission:
managed_subscription`; the gate never read it. `cost_budget._load_caps`
took `Path(base_dir).parent` for the workspace — the `<workspace>/aria-tools`
layout — while this store is bound at `trial/store/tools`, so it read the
shipped defaults. `circuit_breaker` and the agent-request anchor policy made
the same assumption.

**Fix.** `tool_registry.bound_workspace_root(base_dir)` is the one owner:
the `bound_repo_root` a bound store records, the parent for a legacy store.
The three policy readers go through it. And `assert_within_budget` applies
the policy it now reads: under `managed_subscription` notional dollars are
telemetry (ORPHAN-HIGH-472 retired them for the dispatch budget,
ARIA-HIGH-074 for the spawn reservation) — the projection is returned as
`status: telemetry_only`, nothing is refused, the breaker does not trip.
The metered policy keeps every cap exactly as before.

**Proof.** `test_spawn_budget_gate` (+2): a store bound outside its
workspace reads that workspace's caps and, under `managed_subscription`,
passes an over-cap estimate through the real spawn gate as telemetry; a
legacy store still resolves its parent.

## Addendum — ARIA-HIGH-080 / 081: the round-2 primary revision, accepted and then declared dead

Trial eight ran the kernel's own convergence loop end to end on real
models for the first time (driver: the trial tools' `run_round_chain.py`,
one drainer step then one normal dispatch per turn): challenger accepted
on managed Claude (fable, 829 s), cross-review accepted on Codex
(gpt-6-astra, 333 s; `material_risks_present`), the drainer minted the
round-2 primary revision, and the revision was accepted at the request
layer on managed Claude (fable, 1,133 s, 2026-09-12T01:38Z). The next
drainer step forced `HUMAN_REQUIRED` (verdict `split`, branch
`defensive_default`, `convergence_envelope_dead:primary_plan`).

Two defects, both in what the kernel does with a revision it accepted:

- **ARIA-HIGH-080.** `agent_bridge_warning: revision round must match
current critique round`. The planner had echoed the envelope's
  `round_number` (2) as `details.revision.round`; the plan's critique
  round was 1. `_canonicalize_revision_payload` says in its own docstring
  that agent-supplied values must be ignored for kernel state — and then
  honoured the supplied `round` and `parent_revision_hash`. The reducer
  refused, the fold was skipped, and the drainer — finding no live
  `primary_plan` envelope for the round it had minted — declared the
  accepted one dead. `round` and `parent_revision_hash` now come from
  `fold_plan_state` only; the agent's `revision_id` label is kept.
- **ARIA-HIGH-081.** The revision's own note: "no round-1 primary plan,
  challenger plan or cross-review envelope was readable". The revision
  envelope's `suggested_prompt` was one sentence — "addressing
  cross-review findings" — and carried none of them; the planner was
  expected to read the store, which a tool-less route (Codex, Z.ai)
  cannot and a sandboxed spawn with the store bound outside its workspace
  cannot see. `issue_primary_envelope` now builds the prompt from the
  plan state it already folds for its legal-state check: the latest
  primary body, the challenger body and the last round's surfaced risks,
  inside `<untrusted_*>` tags exactly as the cross-review envelope
  carries its plans, with the instruction that the kernel owns the round.

**Proof.** `test_plan_convergence_bridge` (+1): a supplied `round: 2` /
stale parent against `current_round: 1` is recorded as round 1 with the
kernel's parent hash. `test_primary_revision_envelope_carries_findings`
(4): the prompt carries plans and risks in tags, names absence instead of
inventing content, and `issue_primary_envelope` builds it by default.
The trial-eight plan stays `HUMAN_REQUIRED` — the ledger is not rewritten;
the next trial runs the loop on the fixed kernel.

## Tracked, not closed here — ARIA-MEDIUM-082

Running the convergence suites beside the pre-push run (load ≈ 5), three
`PlannerTwinContextTests` fixtures failed on `implemented.status
'unknown' != 'available'`; alone at load ≈ 4 the same fixture reports
`available / selected_source_definition`. The twin's self-feature
qualification runs under `_ScopedSourceBudget()`'s literal two-second
deadline and answers `qualification_deadline` when it expires — honest at
runtime, host-dependent in a fixture. Owner: the budget as a policy value
with a fixture seam; deadline 2026-09-26.
