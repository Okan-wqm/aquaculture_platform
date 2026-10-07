# ARIA mints a finding's event before it claims its file, and reads findings from files (2026-10-07)

Context: ARIA-MEDIUM-330 was raised on 2026-10-03 and fixed on `fix/aria-finding-identity-lifecycle`
(PR #1759, commit 748c35937). That PR is being closed, so both halves are landed again on current
main: the mint (`emit_finding`) and the readers that glob `F-*.json`.

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

## ARIA-MEDIUM-330

Evidence (at `main@a8b885be5`):

- `aria-kernel/aria_kernel/finding.py:491`: `emit_finding` appends `finding_emitted` to the
  finding-event ledger.
- `aria-kernel/aria_kernel/finding.py:506`: only after that append does it check whether
  `F-NNN.json` already exists. A collision raises, but the event is already in the ledger. The
  ledger then names a finding whose file belongs to something else, and the next mint allocates
  the same id again.
- `aria-kernel/aria_kernel/finding.py:217`: the next id is the highest emitted id plus one.
- `aria-kernel/aria_kernel/reflection.py:398`: the daily report globs `F-*.json`. It counts every
  file, including ones no event emitted, and reads each status from a file frozen at mint.
- `aria-kernel/aria_kernel/plan_synthesizer.py:656`: the F_FINDING plan source globs `F-*.json`, so
  F-101 and F-102 become plan candidates, aged by a file mtime that a store restore resets.
- `tools/aria-poc/measure_watchdog_fp_rate.py:109`: the Gate-B FP harness globs `F-*.json` and reads
  `raised_at`, a field the mint never writes. A WITHDRAWN status never reaches its numerator.

Runner store (read-only, `.aria-state-store/findings/aria-findings/`, 2026-10-07):

| Item                   | Fact                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `finding-events.jsonl` | 16 `finding_emitted` rows, F-001..F-016; next mint is F-017   |
| `F-001`..`F-016.json`  | kernel records, one per event                                 |
| `F-101.json`           | 1105 B, sha256 `86600014…22b8`, no event                      |
| `F-102.json`           | 1384 B, sha256 `d3affd1b…e9ec7`, no event                     |
| F-101/F-102 shape      | `source: seed_drift_findings`, `id`, no `$schema`; 2026-08-05 |
| F-101/F-102 subject    | `financescope` / `leaverequest` UI drift, as in F-001/F-002   |

On main, the mint that reaches F-101 appends its event and then refuses. Every later mint
allocates F-101 again and repeats this, so the ledger grows phantom events and never moves past
F-101. Until then the daily report counts 18 findings over 16 events, and the plan source offers
F-101 and F-102 as candidates.

Rule: the finding-event ledger is the one authority for which findings exist. No
`finding_emitted` event names a finding whose file that mint did not create, a file at the next id
that no event owns does not block the allocator, and every reader counts and selects findings from
the fold (`finding.fold_findings`), never from files beside it.

Fix, mint side (branch `fix/aria-finding-file-claim`), in `aria-kernel/aria_kernel/finding.py`
under the existing allocation lock:

- `_retire_unledgered_finding_file`: the ledger proves that no finding was emitted under the
  allocated id. A file at that id that is not a kernel-shaped record is therefore not a finding.
  This covers the legacy seeder output, and an empty claim left by a mint killed between the
  claim and the append. The function records the file's id, sha256 and size once per content as
  `finding_file_unledgered_retired` in tools governance, then removes the file. Its bytes stay in
  aria/state history. A kernel-shaped record with no event means the ledger lost rows, so this
  function keeps it.
- `_claim_finding_file`: creates the file with `O_EXCL` before the event is appended. A remaining
  collision is refused as `finding_file_collision:<id>`, and the ledger and the file stay as they
  were. This covers a kernel-shaped orphan, or a writer outside the lock. If the append fails, the
  claim is released.

The repair runs inside the mint, so it is deterministic and idempotent. F-101 is retired by the
mint that allocates F-101, and F-102 by the next mint. No operator store action is needed.

Fix, reader side: every reader reads the fold, so a file with no event is not a finding.

- `reflection._summarize_findings` replaces the `F-*.json` scan. Status is the folded status, and
  the fold is read strictly: a ledger that fails verification fails the report.
- `plan_synthesizer.scan_f_findings` yields one candidate per folded finding. Age comes from the
  record's `created_at`, and an undateable record is as young as now. Status stays admission's
  question.
- `measure_watchdog_fp_rate.measure_fp_rate` buckets folded statuses and places the window by
  `created_at`. A missing ledger is `unmeasured`, and the `unreadable` count is gone because no
  file is parsed.

Overlap with ARIA-HIGH-369 (`fix/aria-finding-plan-path`, PR #1826): its slot policy drops F
candidates the fold does not hold. It does not change `scan_f_findings`, which still globs on that
branch. This change touches only that source's read. One assertion overlaps:
`test_f_finding_loop_guards.py` `CycleDetectionTests` expects F-081 before F-080. On main, the rank
offers the younger candidate first. Under #1826's slot policy, the oldest member of a subject comes
first. Whichever PR lands second sets that expectation to F-080, then F-081.

Tests, mint side: `aria-kernel/tests/test_finding_and_debt_emission.py` adds four cases:

- a legacy stray at the next id is retired, and the mint claims the id;
- an empty claim left by a killed mint is retired;
- a kernel-shaped orphan refuses the mint, and the ledger bytes are unchanged;
- a failed append releases the claim.

On `origin/main`, the first three fail: the second mint raises after its F-002 event is already in
the ledger.

Tests, reader side. Each fails on `origin/main`:

- `tests/invariants/v3_1/test_aggregator_filesystem_ssot.py`: a stray F-101.json is not counted,
  and a WITHDRAWN in the fold beats the frozen OPEN file. I-V3.1-06 now pins the fold.
- `tests/invariants/v9/test_phase_v9_4_pressure_sources.py`: a stray F-101.json is never a
  candidate, and the order comes from `created_at`.
- `tools/aria-poc/test_measure_watchdog_fp_rate.py`: the rate is 1/1 from the fold, never read from
  the frozen file or the stray. No CI step runs this file; it ran locally.
- `test_f_finding_loop_guards.py`: the fixture stamps `created_at` instead of a file mtime.
