# ARIA provider exhaustion, routing and stall reasons (2026-10-02)

Context: the end-to-end diagnosis of ARIA's drafter lane (16 failure episodes, five root causes,
`aria/state@5351fcb18`, `main@8b304425b`) left two code causes on the path from a minted plan to a
converged one. RC4: the runner's Claude CLI shares the operator's claude.ai weekly quota, and when
that quota ran out the executor neither recognised the notice nor stopped asking the exhausted
provider. RC5: a plan that stopped moving was abandoned as `stalled` with the blocking reason
dropped. The operator decided the provider policy on 2026-10-02: role-based routing with automatic
failover, Z.ai `glm-5.3` primary for the high-volume roles and one judge of the pair, Claude Opus
primary for the primary planner and the implementer, as policy data the operator can flip in one
edit.

Owner: claude (implementation), okan (review, runner quota and login). Deadline 2026-10-05.

## ARIA-HIGH-290

Context: on 2026-10-01 the managed session answered every dispatch with
`You've hit your weekly limit · resets 6am (UTC)` on exit 1 (request
`AIR-aria-challenger-planner-83a038b1b7ac` and its siblings; 27 of 30 drained requests failed per
run). The same notice arrived on 2026-08-21/22 on exit 0 and was sealed as judge evidence
(`resets Aug 23, 10am (UTC)`).

Evidence (at `main@d3adb0f89`):

- `tools/aria-poc/claude_runtime.py:1758` — `USAGE_LIMIT_MARKERS` names `usage-credits` and
  `switch models with /model`; `:1992` matches only the `reached your` + `limit` co-occurrence.
  `hit your weekly limit` matches neither, so the run was a plain `claude_exit_1`, classified
  retryable, and no cooldown was written.
- `tools/aria-poc/ci_executor.py:2427` — the recorded tail is the last 2,000 characters of stderr
  alone. On 2026-10-01 stderr held only `Ignoring 481 permissions.allow entries from
.claude/settings.local.json: this workspace has not been trusted ...`; every
  `runtime_attempt_finished` row named that notice and none named the cause, which lived in the
  stream's `result` event.
- `aria-kernel/aria_kernel/provider_cooldown.py:118` — a cooldown row is appended per exhausted
  request, and the row's reason is fixed to `quota_unavailable`: an expired credential at spawn
  time (`tools/aria-poc/ci_executor.py:5125`) cools nothing, and a stated reset is never read.
- Routing has no data surface. The vendor a role runs on is the model of the agent's runtime
  profile (`aria-kernel/aria_kernel/data/runtime_profiles.json:6`, `:42`), the ladder order is
  code (`aria-kernel/aria_kernel/native_admission.py:148`), the legacy lane's auth failover is a
  second code table (`tools/aria-poc/claude_runtime.py:95`), and a third, test-only role striping
  policy sits in `aria-kernel/aria_kernel/model_fleet.py:214`. The native Claude route spawns the
  profile's model, not the admitted route's (`tools/aria-poc/ci_executor.py:3550`), so a glm-profile
  role that fails over to Anthropic is handed `glm-5.3` again. The primary planner and the
  challenger share the `planner` profile, so both always ran on one vendor.

Rule: a provider-exhaustion wording is a member of a closed, tested signature set; each signature
cools its provider once per transition, until the stated reset or a declared default; a cooled
provider is not attempted and its roles route to their failover provider; the recorded tail ends
with the cause; the provider a role runs on is policy data in one place, and the two seats of an
independence pair never share a vendor while two vendors can serve them.

Fix (branch `fix/aria-provider-routing-and-quota`):

- `provider_cooldown.PROVIDER_EXHAUSTION_SIGNATURES` — the closed table (Claude: limit notice,
  `/usage-credits` hint, API credit error, auth failure; Z.ai: quota refusal, auth refusal; Codex:
  quota, auth). `record_provider_cooldown` refuses a detection without a member for its provider,
  reads `resets 6am (UTC)` / `resets Aug 23, 10am (UTC)` (bounded to seven days, else the policy's
  900 s), and returns the standing row without writing while a cooldown stands. Auth signatures
  cool as `auth_unavailable`.
- `claude_runtime.USAGE_LIMIT_NOTICE_RX` (a whole notice line), `failure_cause_text` (notices
  first, the result event's text last), `ZaiRunResult.exhaustion_signature`, signatures on the
  Codex records; `ClaudeAuthFailure` names its provider, and the native lane cools it.
- `runtime_profiles.json` `provider_routing`: the role table and its ladders, validated at load;
  `native_admission` walks the role's ladder and applies the vendor-diversity guard; the native
  Claude route spawns the admitted model; the legacy lane's primary and auth failover come from the
  same ladder. `AUTH_FAILOVER_TIER`, `fleet_ladder_for` and `assign_mixed_models` are gone.

Not done, and why: the implementer cannot fail over to `glm-5.3`. The Z.ai transport is one chat
completion with no tool loop and no write containment (`model_fleet.Provider.admits_writes` is
false for it), and the 2026-09-11 policy forbids handing the Z.ai credential to the Claude CLI.
The `implementation` role routes to Anthropic only; while Anthropic is cooled or suspended an
implementation request waits by name (`no_eligible_provider`) with its requeue budget intact.

## ARIA-MEDIUM-291

Context: between 2026-09-21 and 2026-10-01 no lane consumed requests (cycles failed, then the
operator disabled the auto-cycle and the executor), 832 requests expired as `anchor_expired`, and
the 72 h stall rule abandoned the plans they belonged to.

Evidence:

- `aria-kernel/aria_kernel/plan_convergence.py:998` — `resume_candidate_plan_id` abandons a plan
  whose newest event is older than `STALE_PLAN_MAX_AGE_HOURS`; `:1001` records only
  `stalled: no plan event since <stamp>`. The release reason of the plan's newest request
  (`anchor_expired`, `provider_quota_unavailable:anthropic`, or no claim at all) is not read, so the
  operator and any lane-failure classifier see `stalled` for every cause.

Rule: an abandoned plan records why it stopped: the last release or refusal reason of its newest
request, or the fact that nothing consumed it.

Fix (same branch): the stall rule reads the plan's newest request in the invocation ledgers and
abandons with `stalled:<cause>` (`stalled:no_consumer`, `stalled:anchor_expired`,
`stalled:provider_quota_unavailable:anthropic`, `stalled:no_request`); the `plan_abandoned` event
carries the cause, its fault domain and the request it was read from, and the folded plan state
exposes it.
