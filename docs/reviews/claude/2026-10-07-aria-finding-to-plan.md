# ARIA finding → plan path (2026-10-07)

Scope: how the autonomous planner picks the candidate for its one planning slot, and what an F
plan is built from. Evidence comes from the aria/state store on the runner
(`.aria-state-store/tools/governance.jsonl`, `tools/plans/events.jsonl`,
`findings/aria-findings/finding-events.jsonl`), read on 2026-10-07.

## ARIA-HIGH-369 — the F finding → plan path was starved and template-seeded

Severity HIGH · owner claude / okan · deadline 2026-10-14

### Measurements

| Measure                                            | Value                          |
| -------------------------------------------------- | ------------------------------ |
| `plan_candidate_source_selected` events            | 32                             |
| ... failing_ci / f_finding / operator_feedback     | 21 / 10 / 1                    |
| last 12 automated selections                       | all failing_ci                 |
| plans started / converged                          | 20 / 0                         |
| failing_ci plans, start to terminal state          | 0.25–2.39 days (5 plans)       |
| F files the scan offers / fold findings / subjects | 18 / 16 / 10 distinct          |
| F-007 cited line at mint (0fb5f096b) vs main       | `<select` at :355, now at :389 |

The 2026-10-05 plan was failing CI on `aria-auto-cycle.yml`, which is ARIA's own code
(`self_improvement.SELF_CHANGE_ALLOWED_PREFIXES`) and is parked for a human anyway. By
ARIA-HIGH-363's subject key, F-003/F-005/F-007/F-008/F-015 are one subject and
F-001/F-004/F-006 another; F-101/F-102 are files that the finding fold never emitted.

### Root cause

1. `plan_synthesizer.py:1080`: the rank is a fixed source order. Failing CI ranks 1 and
   F ranks 3, and `plan_source.py:205` gives the slot to the first candidate that converts.
   So whenever any main workflow was red, the F source never got the slot.
2. `plan_synthesizer.py:1183`: the F secondary key is `age_seconds` ascending, so the
   youngest finding came first. Duplicates of one subject were all offered.
3. `plan_synthesizer.py:1473`: the F plan's summary was a fixed template.
   `finding_grounding.py:472` checks only that each cited file is tracked, never the line,
   so a plan was built from the mint-time line even after the code had moved.

### Fix

- `aria_kernel/plan_slot_policy.py` (new) re-orders candidates before admission:
  - An operator request is always offered first.
  - A failing-CI candidate on an `aria-*` workflow is dropped.
  - A workflow whose last automated plan failed less than 3 days ago is dropped. Three days
    covers the measured plan lifetime of 2.39 days.
  - F candidates that the fold does not hold, or that are not OPEN, are dropped with
    admission's reasons. The rest collapse to one per subject: the highest severity, then the
    oldest.
  - F and the other automated sources alternate on the newest automated `plan_started`. A
    lane with nothing convertible hands the slot on.
  - What was dropped is disclosed in one `plan_slot_policy_applied` event per synthesis.
- `aria_kernel/finding_seed.py` (new) re-grounds an admitted finding at the anchor commit:
  - A drift finding asks its own detector, the registry 363 closes merged findings with:
    - `reproduces` seeds the plan from the refs found now. A moved line is re-anchored and
      the move is named.
    - `absent` returns `f_finding_subject_absent`.
    - `unverifiable` returns `f_finding_subject_unverifiable`.
    - In both of those cases the finding is not planned and is never closed here.
  - Any other finding has each `path:line` re-read at the commit it was verified at. A line
    found exactly once at a new place is re-anchored. A line that is gone or ambiguous makes
    the finding unverifiable.
  - An operator request is never refused by the seed. It cites the re-anchored refs when
    there are any, and the refs it signed otherwise.
- `plan_synthesizer.convert_candidate_to_plan_content`: an F plan is built only from the
  seed. The title, summary and one key change per surface name only ids, paths, closed-set
  severity and claim type, and the subject's side identifiers. Without a seed, the result is
  `f_finding_unseeded`.

### PR #1759 disposition

- 332 (`REF_STALE` refuses a moved line) is superseded. Re-anchoring keeps F-007 plannable,
  and its operator request is not spent.
- 331 (kernel subject refusal on a declared `symbol`) is superseded by 363's read-time
  subject key.
- 330's scan of the fold is covered: the slot policy drops F candidates that the fold does not
  hold. 330's `O_EXCL` claim of the finding file before its event is independent and was not
  folded in. It should land as its own PR before the ledger reaches F-100, where it would
  collide with F-101.json.

### Tests

`aria-kernel/tests/test_finding_plan_path.py` has 12 tests. All 12 fail on origin/main
958eed5b7: the provider picks failing_ci, the plan cites :355 and :12, and the template
summary is present.

### Review corrections (PR #1826)

- **H1, re-anchoring onto an unrelated line.** The first seed matched the cited line's text. A
  deleted statement could "move" to a one-off `});` elsewhere, and an equal trivial line at the
  old line number counted as unchanged. `finding_line_map.map_cited_line` now maps the line
  through `git diff -U0 --no-renames <origin> <anchor> -- <path>`:
  - a line inside an old-side hunk is gone;
  - any other line is shifted by the hunks above it;
  - text is never matched.
- **M1, operator requests.** A seed may only move a signed ref within its own file
  (`FindingSeed.signed_refs_moved`). The surfaces stay the signed ones. If the moved refs are
  refused, the signed refs are judged instead, so a seed never gets a request spent.
- **M2, detector faults.** A detector that raises (`OSError`, subprocess error, `ValueError`)
  or answers a non-object is `f_finding_subject_unverifiable` with the error named.
  `DriftSubjectDetector` now returns `unverifiable` for an `OSError` from `subprocess.run` and
  for valid JSON that is not an object. The synthesis, and the operator request in it,
  continues.
- **M3, per-subject guards.** F candidates are grouped by subject, and every member is offered,
  best first. The representative is whichever member admission and the seed accept. The loop
  guards (cool-off, quarantine) judge the plans of the whole subject
  (`finding_grounding._subject_ids`). So a sibling cannot re-plan a subject that another
  sibling's failed plan cooled off, and a subject does not starve behind a member that was
  refused for its own reasons.
- **M4, detector cost.** While a plan is in flight
  (`plan_convergence.in_flight_plan_id`, which reads the plan
  `resume_candidate_plan_id` adopts and abandons nothing), the envelope is never started. So
  no detector runs: seeds use the diff line map, and `plan_slot_policy_applied` records
  `seed_detectors: skipped_plan_in_flight`.
- **`ui_option_drift` without `ARIA_SUPERGRAPH`.** Outside the cycle step, the scan judges no
  UI pair and the detector answers `unverifiable` (`wire_unavailable:*`). The F finding is
  disclosed with that reason, is not planned, and stays OPEN. An operator request falls back to
  its signed refs.

`aria-kernel/tests/test_finding_plan_path_review.py` adds 13 tests. 10 of them fail on
e5d4e8f13. The 3 that pass there pin behaviour that was already correct: a line shifted by
hunks, an operator request whose subject is absent, and a UI drift without the wire.
