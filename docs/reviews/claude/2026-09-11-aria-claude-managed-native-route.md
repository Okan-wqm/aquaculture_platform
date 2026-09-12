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

## Addendum — ARIA-HIGH-083: the final message was the last frame, not the final turn

Trial nine, challenger (`AIR-aria-challenger-planner-4e66e9b99256`,
managed Claude, 1,230 s, 80,522 output tokens, 2026-09-12T02:58Z): the
CLI returned exit 0 and the executor refused the answer at pre-submit —
`plan_content:absent_or_not_object` — and requeued the request as a
request fault. The transcript shows why: the answer hit the CLI's output
token limit, the CLI injected a synthetic user turn ("Output token limit
hit. Resume directly — no apology, no recap …", `isSynthetic: true`), the
model resumed mid-JSON, and the `result` event carried only the resumed
frame — 3,795 of 42,661 characters. `extract_final_message` preferred
`result`; the envelope extractor found no object; the executor projected
a fallback envelope (`verdict: unverified`, a 4 KB tail as evidence).
Joined, the frames parse to a complete envelope with an eight-key
`plan_content`.

**Fix.** The final message is the final TURN: every assistant text frame
after the last real user event (a tool result); a synthetic continuation
joins the frames it separates; `result` wins only when it is not that
turn's suffix (an error-typed result, a shape the reader does not know).
Measured on the live transcript: 42,476 characters, the envelope with its
`plan_content`.

**Proof.** `test_claude_runtime_contract` (+2): frames split by a
synthetic user event are read whole and a preceding tool turn is not; an
error result that is not the turn's suffix still wins.

## Operator decision 2026-09-12 — fable is selected by nothing

"Fable'ı kullanmasın, sadece opus." Every selection moved to opus: the
kernel profiles `planner`, `planner_orchestrator`, `arbiter`; the seven
agent mirrors (`aria-acceptance-lead`, `aria-autonomy-planner`,
`aria-challenger-drafter`, `aria-challenger-planner`,
`aria-consensus-arbiter`, `aria-primary-drafter`, `aria-primary-planner`);
`agent_runtime_profile.DEFAULT_MODEL`, `claude_runtime.CLAUDE_DEFAULT_MODEL`
and the dispatcher's `claude_model`. The tier name stays in
`MODEL_TIER_ORDER` (ordering for the write-protection rule), the pricing
table (old rows) and the fallback ladder. ORPHAN-HIGH-760's two-distinct-
models anchor still holds: evidence judge opus, adversarial judge glm-5.3,
arbiter opus. `tests/invariants/test_fable_is_selected_by_nothing.py` pins
all three selection surfaces.

## Addendum — ARIA-HIGH-084: the Codex prompt rode argv, and the round-3 revision did not fit

Trial nine, round-3 primary revision (`AIR-aria-primary-planner-7c5f3102c977`,
2026-09-12T05:18Z): admission chose Codex and the spawn died before the
model — `codex_native_execution_unavailable:OSError`,
`control_or_transport_unavailable`. The request prompt was 97,705 bytes
(it carries the round's primary and challenger plans and the surfaced
risks since ARIA-HIGH-081) and the agent contract 35,273 bytes;
`build_codex_argv` appended their concatenation as the last argument of
`codex exec`. Linux caps one argument at `MAX_ARG_STRLEN` = 131,072 bytes:
`/bin/true` with a 135,000-byte argument raises `OSError [Errno 7]
Argument list too long`, 131,000 passes. The round-2 cross-review (92 KB +
contract) had fitted by a few kilobytes.

**Fix.** `codex exec` reads its instructions from stdin when no `[PROMPT]`
argument is given, and stdin has no size limit. `build_codex_argv` no
longer takes a prompt; `run_codex_exec` passes `input=prompt` and the
managed path passes `input_text=prompt` through the spawn seam it already
used with an empty stdin. The argv contract tests read the prompt from
the launch's `input`; the live fake `codex` reads it from stdin.

## Addendum — ARIA-HIGH-085: the claim metadata rode an environment string

Trial nine, round-3 cross-review (`AIR-aria-cross-reviewer-d56ccafa2f21`):
the planner dispatch hook could not even start the executor —
`subprocess.run` raised `OSError: [Errno 7] Argument list too long:
'python3'`. The hook exported the fused claim envelope (plans, risks,
must-satisfy, evidence references) as the VALUE of `ARIA_CLAIM_METADATA`;
an environment string is bounded like an argument (`MAX_ARG_STRLEN`), and
a round-3 cross-review's envelope carries both plans. The same class as
ARIA-HIGH-084, one hop earlier.

**Fix.** The metadata crosses as a file: the hook writes it 0600 under
`<tools>/runtime/claim-metadata/<claim_id>.json`, names it in
`ARIA_CLAIM_METADATA_FILE`, and removes it once the child has exited
(`subprocess.run` returns only then, so nothing can race a read); the
executor reads the file the variable names and refuses by name when it
cannot. The payload schema, the forbidden-key checks at both boundaries
and the ledger-hash integrity verification are unchanged; the lease token
still transits only via `ARIA_LEASE_TOKEN`. The hook's live-path test
reads the file through the transport seam and asserts its mode and its
removal; the single-claim executor tests reproduce the file.

Found next to it: the hook's task-binding gate admitted an UNBOUND store
only in the schema-3 spelling (`bound_canonical_identity` present and
None); a fresh `ensure_tools_dir` store is schema 2 with
`bound_repo_root`/`bound_repo_hash` None and no canonical-identity field,
and was refused as `planner_dispatch_task_binding_unavailable` — five hook
fixtures red on the candidate since the integration. "Unbound" is now a
property of the binding fields (every one absent or None, no unknown
fields), not of the schema version; any non-None binding value still has
to validate.

## Addendum — ARIA-HIGH-086: a stale envelope was buried before the reaper could requeue it

Trial nine had run three full rounds on real models (challenger,
cross-review, primary revision ×2, all accepted and folded) when the
round-3 cross-review's spawn died before the executor started
(ARIA-HIGH-085). The hook had already claimed the request; the lease
expired at 07:23; the next drainer step, at 07:44, read the request as
STALE, `_live_request_id` returned nothing, `_ensure_envelope` raised
`_EnvelopeDead('cross_review')` and the plan was forced to
`HUMAN_REQUIRED` (`convergence_envelope_dead`, verdict `split`). The
reaper (`reap_stale_claims`) would have requeued the same request — a
lease expiry is one request-fault requeue, and two are allowed — had it
run first. The drainer decided a fate that belongs to the reaper.

**Fix.** `_live_request_id` counts STALE as live: the step keeps waiting
for the reaper's verdict (REQUEUED, or HUMAN_REQUIRED once the requeue
budget is spent) instead of ending the round on a race between two kernel
phases. **Proof.** `test_drainer_stale_envelope_is_alive` — a real claim
with a one-second lease, the request derived STALE after expiry, still
live for the drainer; the real reaper requeues it and it stays live.

## Addendum — ARIA-MEDIUM-087: the policy the kernel obeys sat inside the agent's write scope

Raised by the adversarial review of tonight's commits (a parallel review
agent, 2026-09-12): `bound_workspace_root` (ARIA-HIGH-079) routes the
cost gate, the breaker thresholds and the anchor age to
`<workspace>/aria-config/genesis_policy.json` — the file native admission
had read all along — and that path was not in `READONLY_PATHS`. The
sandbox ro-binds and the write hook denies exactly `READONLY_PATHS`; the
implementer and worker profiles carry write scope `**`. A write-capable
spawn could have set `monetary_admission: managed_subscription` or raised
`circuit_breaker.failure_threshold` in its own tree and the next dispatch
of the same store would have obeyed.

**Fix.** `aria-config/` joins `READONLY_PATHS`: the sandbox mounts it
read-only, the hook refuses writes under it, and the scope subtraction
keeps it out of an implementation's declared surfaces. An invariant pins
that every path `genesis_policy` loads from the workspace
(`OVERRIDE_RELPATH`) sits under a read-only prefix. The review's other
observation — that decision nodes moved to opus now fall back to sonnet
on credit exhaustion through `MODEL_FALLBACK_TIER` — is an operator
decision, put to the operator with the audits.

## ARIA-MEDIUM-082 — closed: the qualification budget is policy

Implemented in an isolated worktree by a parallel agent and reviewed here.
The literal `+ 2` lived in `snapshot._ScopedSourceBudget` and three
readers inherited it (the twin projection at refresh, the twin
re-observation at mint, the pinned evidence-excerpt reads). It is now the
`source_qualification.deadline_seconds` policy block (default 2.0 in
`genesis_policy_default.json`, typed accessor
`genesis_policy.source_qualification_policy` refusing non-numeric,
negative and above-ceiling values, ceiling 300 s so a mint-time
qualification stays bounded); `_ScopedSourceBudget` has no default any
more — a caller states exactly one of `deadline_seconds` or
`deadline_monotonic`; twin.py resolves the allowance from policy at every
call site and discloses it as `work.qualification_deadline_seconds`. The
fixture seam is the real operator override (`aria-config/genesis_policy.json`
in the fixture workspace, 120 s): the three PlannerTwinContextTests
fixtures and the twin-wiring helper assert the disclosed allowance, so
"available" is earned under an ample budget rather than assumed from host
speed. Pre-fix proof: the new assertions fail on the reverted kernel
(`4 failed`, `KeyError: 'qualification_deadline_seconds'`). On the
candidate: genesis-policy, snapshot, evidence-excerpt, twin-wiring and
resumable-step suites, 127 OK.
