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
