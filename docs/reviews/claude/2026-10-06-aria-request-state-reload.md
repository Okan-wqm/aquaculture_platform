# ARIA readers of every request reload the request ledgers once per row (2026-10-06)

Context: every `aria-agent-executor` run spent about half its wall clock in two "Handoff snapshot"
steps, and every `aria-auto-cycle` run spent about 105 minutes outside agent work. The cause is
one defect class: a reader that walks every request derives each state with the per-request form.

Owner: claude (implementation), okan (review). Deadline 2026-10-13.

## ARIA-HIGH-358

Measured from GitHub step timings (read-only):

| Run                            | Step                                           | Duration    |
| ------------------------------ | ---------------------------------------------- | ----------- |
| executor 37221168808 (10-04)   | Handoff snapshot, session_start / session_stop | 22 / 27 min |
| executor 37402217172 (10-06)   | the same two steps                             | 25 / 26 min |
| auto-cycle 37276160945 (10-05) | the same two steps                             | 22 / 23 min |
| auto-cycle 37408921871 (10-06) | the same two steps                             | 26 / 26 min |

Inside auto-cycle 37408921871 (cycle `cyc-20261006T035447Z-auto`), the timestamps across the
state-store ledgers show two more gaps of about 30 minutes each:

- 04:10:02 → 04:40:17: right after `human_required_opened`. This is the lease-lifecycle and
  anchor-stale sweep (`cycle.py:1651`).
- 05:25:10 → 05:53:12: between the reflection row and the next-cycle queue. This is
  `_write_daily_report`. Stack samples taken every 20 s on a copy of the store all sit in
  `reflection._render_plan016_section` → `plan_016_metrics._claim_active_count` →
  `derive_request_state`.

On a copy of the runner's store (1,866 requests), `derive_request_state` costs 0.96 s per request,
about 30 minutes for all of them. It reloads the request, claim and result ledgers on every call
and rewrites the tools index through `ensure_tools_dir`. The batch form, `derive_request_states`
(ORPHAN-HIGH-794), loads them once. It returns the same states for every row in 8.9 s.

Evidence (at `main@beb2d408d`):

- `aria-kernel/aria_kernel/handoff_ledger.py:145`: `_request_states` derives each row on its own.
- `aria-kernel/aria_kernel/human_required.py:504` and `:564`: both passes of
  `sweep_lease_lifecycle_for_human_required` do the same. The first pass also reloads the claim
  ledger for every record it creates.
- `aria-kernel/aria_kernel/plan_016_metrics.py:87`: `_claim_active_count`, read by the daily
  report.
- `aria-kernel/aria_kernel/judge_fanout.py:725`: `pending_arbitration_group_ids`, read every
  cycle by the consensus sweep.
- `aria-kernel/aria_kernel/agent_invocations.py:1906`: the `state=` filter of
  `list_agent_invocation_requests` (`agent-invocations list --state`).
- `aria-kernel/aria_kernel/agent_invocations.py:2713`: the per-request form's own docstring says
  that callers deriving many requests must use the batch form. Nothing enforced it.

Rule: a reader of every request derives their states with one ledger load. The per-request form
is called only where the loop is bounded by something other than the request ledger, and each
such call site says what bounds it.

Fix (branch `fix/aria-handoff-batch-request-states`):

- The five readers above call `derive_request_states` once. The human-required sweep loads the
  claim ledger at most once. Recording a human-required file writes no request ledger, so one
  derivation serves both passes.
- `aria-kernel/tests/test_request_state_batch_callers.py`:
  - The behavioural tests run each reader against a fixture and refuse any per-request
    derivation.
  - The static test lists every per-request call site in `aria-kernel/aria_kernel` and
    `tools/aria-poc` with the bound that holds it. A new site or a stale entry fails the build.

Measured on the store copy with the fix: the handoff request scan takes 9.6 s, the Plan 016 claim
count 8.3 s, the pending-arbitration set 9.2 s, and the human-required sweep 17.6 s. All four
previously took about 25 to 30 minutes.

## ARIA-MEDIUM-359

`aria-kernel/tests/test_signing_agent.py:167` failed `suite (3)` on #1786 (run 37247153756) with
`[] != ['SHA256:…']`, and it is a recurring red on unrelated PRs.

Evidence (at `main@beb2d408d`):

- `aria-kernel/aria_kernel/signing_agent.py`: `hold_signing_agent` lists the agent's keys after
  `ssh-add` and refuses unless the expected fingerprint is held. Only then does it yield.
- `aria-kernel/tests/test_signing_agent.py:165`: the test holds the key with a 1 s lifetime and
  lists it again at once. An empty list is possible only if the lifetime ran out between the
  holder's listing and the test's. The presence check raced the expiry it was set up to observe.

Rule: a test of a timed expiry asserts presence only from an observation it can place inside the
lifetime.

Fix: the test notes the time before the holder starts, which is before the key's clock starts. It
asserts presence only when its listing finished within `started + lifetime`, and it always asserts
the expiry. The lifetime is 2 s.

I could not reproduce the original failure locally: 0 failures in 10 runs under six busy cores.
The diagnosis rests on the holder's own check, not on a local reproduction.
