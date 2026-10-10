# ARIA — the doctor tells the truth about notifications, and the self-improvement loop can repair a failing cycle (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-MEDIUM-417 — a silent lane read healthy, and the repair loop could not have repaired a failed cycle

### Symptom

On an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z):

- `notifications/outbox.jsonl` holds 268 rows from 2026-09-04 to 2026-10-10. Every one is
  `unconfigured` (266 `human_required_opened`, 1 `breaker_tripped`, 1 `cycle_failed`). Nobody
  was told anything for five weeks.
- The doctor read that store as `[ok] notifications — no_channel_configured`
  (`doctor.py:353-363` before this change: the organ had no FAIL branch).
- `missions/mission-events.jsonl` holds 169 `opened` missions: 83 `pressure`,
  56 `service_hardening`, 21 `capability_gap`, 6 `shadow_run_summary`, 3 `proactive_priority`,
  and none from `self_improvement`. `governance.jsonl` has no `gateway_action_ran` row: the
  doctor and the opener have never run on the live lane (ARIA-HIGH-415 adds them to the workflow).

ARIA-HIGH-415 (5b3970b05) puts `schedule run --action doctor` and `--action self_improve` into the
nightly. Before
this change, the first night they ran would have met three defects in the opener and one in
the doctor.

### Root cause

1. **The notifications organ judged nothing.** It returned `ok` whether or not a channel
   existed. On a CI lane, no channel means no one hears anything. The env names that would
   configure a channel live in the workflow, so a regression there was invisible.
2. **A failed cycle had one mission identity, forever.** `scan_signals` keyed every failing
   organ on its name (`self_improvement.py:224-231`). The mission id is a hash of
   `(source_kind, source_id, repo_hash)` with no cycle in it (`mission.py:305-311`, pinned by
   I-W1-05). `open_mission` returns the existing mission for a known source whether it is open
   or terminal (`mission.py:638-721`). So the first streak of failed cycles minted
   `doctor_fail:orchestrator`. Every later streak, whatever its cause (another phase, the store
   failing integrity), folded into that mission. Once the mission was terminal, no failed
   cycle could ever mint again.
3. **`max_new` counted re-sightings.** `open_self_improvement_missions` stopped at
   `len(opened) >= max_new`, and `opened` included idempotent re-opens
   (`self_improvement.py:265-275`). Once `max_new` missions existed, they took the whole budget
   every night after that. No later signal was ever minted.
4. **A configuration fault would have become a code-change mission.** Every doctor FAIL became
   `doctor_fail`, which has the `self_change` remedy (`self_improvement.py:44-53`). A
   notifications FAIL means the workflow's env is missing. The answer to that is an edit to
   `.github/workflows/`, which is an `AUTHORITY_SURFACE` (`self_improvement.py:81`). The mission
   could only be refused at accept time, after its HIGH `self_change_adjudication` was
   opened.

### Fix

- **Doctor, notifications organ (tier 3, detectable):** on a GitHub Actions lane
  (`GITHUB_ACTIONS=true`), `configured_channels() == ()` is a FAIL:
  `no_notification_channel_in_ci`. The check looks at channels, not the selector. The selector
  is optional, and `github_issue` is configured only by `ARIA_NOTIFY_GITHUB_REPO`
  (`notify.py:40-45`). `ARIA_NOTIFY_CHANNELS=none` is an operator's explicit choice and reads
  `ok — notifications_disabled_by_operator`. `none` combined with a channel is a FAIL anywhere
  (`notify.ChannelSelectorInvalid`, from ARIA-HIGH-415). Off CI, a store with no channel keeps
  `ok — no_channel_configured`. The CI step's job summary and `::error` line make the verdict
  visible without any channel. They are the doctor step's lines in `aria-auto-cycle.yml`
  (5b3970b05), written to this finding's specification.
- **Doctor, failing causes as identity (tier 1):** `DoctorCheck.causes` is a tuple of
  `DoctorCause(key, summary)`. `key` comes only from closed vocabularies. The orchestrator
  organ names one cause per distinct `<phase>:phase_failed` among its streak's failed cycles,
  or `cycle:<runtime_status>` (`unrecorded` outside `RUNTIME_STATUSES`) when a cycle names no
  phase. The phase row's own text (ARIA-MEDIUM-413's `error`, an exception message) goes only into
  `summary`. Before the cycle's runtime status was fixed it read `ok` on payload-failed nights,
  so it is not used for a phase row's key.
- **Opener (tier 1):** `doctor_signals(check)` keys a signal `<organ>` or
  `<organ>:<cause key>`. A new signature mints a new mission. The same signature, open or
  terminal, mints nothing (`mission_id_for`). The title is the cause's summary, or the reason's
  leading code, never a slice of a row list. `max_new` counts only missions the call opened.
- **Routing (tier 1):** a new signal kind `config_missing` with the `announce` remedy.
  `DOCTOR_ORGAN_SIGNAL_KINDS = {"notifications": "config_missing"}` routes that organ's FAIL
  to it. A test pins that every routed organ is one the doctor runs and that every routed
  kind is announce-only.

### Production evidence

- Before, I ran the opener twice (`max_new=3`) on a copy of the bound store with the kernel at
  7ded78260. `scan_signals` gave 6 self-change signals: `doctor_fail:deadlines` and five
  `capability_gap` rows. Night 1 opened 3. Night 2 returned the same 3 rows as idempotent and
  opened 0. `capability_gap:shadow_run:lint-rules-adapter`, `…:tenant-scoping-adapter` and
  `…:test-gap-adapter` could never have been minted.
- After, the fixed opener on that same missions ledger (the six measured signals replayed,
  `max_new=3`): night 3 returned 6 rows and opened the 3 starved gaps. Night 4 opened none.
- notify's dry run of `schedule run --action self_improve` on its own copy (current code):
  `new=3`, namely `doctor_fail:deadlines` (titled with a 200-character slice of 223 AIR ids),
  `capability_gap:repo:evidence_gap:jsonl` and `capability_gap:shadow_run:doc-staleness-adapter`.
  It took doctor 229 s, self_improve 245 s and deliver 4.6 s.
- Doctor wall time on this host: 222–224 s. The slow organs are integrity 88 s,
  runtime_artifacts 74 s, tools 36 s and queue 17 s. `self_improve` runs the doctor once
  inside `scan_signals`.

### Not done here

- **A recurrence after a terminal mission is not minted again.** The mission id carries no
  cycle by design (I-W1-05). The same cause failing again after its mission closed is still a
  doctor FAIL, a `doctor_unhealthy` notice and a CI `::error`, so it is not silent. It does not
  get a second mission. Changing mission identity is not this finding.
- **`doctor_fail:deadlines` stays a self-change.** On the bound store it is the first mission
  the opener will mint, because 223 HUMAN_REQUIRED SLAs have lapsed. Its routing was decided
  deliberately in ARIA-MEDIUM-128 (`test_self_improvement_remedy.py:126-129`). The lapsed SLAs
  are HR-queue hygiene (ARIA-HIGH-418).
- **Other organs that fail for host reasons** (`providers`, `sandbox_backend`, `claude_cli`,
  `gateway_heartbeat_fresh`) still route to `doctor_fail`. None of them failed on the bound
  store or this host. Adding one is a one-line entry in `DOCTOR_ORGAN_SIGNAL_KINDS` once a
  failure shows its answer is configuration.
- **The doctor runs twice a night** (the doctor step, then inside `self_improve`), costing
  about 7.5 minutes. Sharing one report between them is an optimisation, and the plan puts
  correctness first.
