# ARIA mints a finding's event before it claims the finding's file (2026-10-07)

Context: ARIA-MEDIUM-330 was raised on 2026-10-03 and fixed on `fix/aria-finding-identity-lifecycle`
(PR #1759, commit 748c35937). That PR is being closed, so the `emit_finding` part is landed again on
current main. The reader half of the original finding is not fixed here, and no finding on main
tracks it yet: reflection and the F_FINDING plan source still glob `F-*.json` instead of reading
the event fold, so they count F-101 and F-102 until the mints described below retire them.

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
F-101.

Rule: no `finding_emitted` event names a finding whose file that mint did not create. A file at the
next id that no event owns must not block the allocator.

Fix (branch `fix/aria-finding-file-claim`), all in `aria-kernel/aria_kernel/finding.py` under the
existing allocation lock:

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

Tests: `aria-kernel/tests/test_finding_and_debt_emission.py` adds four cases:

- a legacy stray at the next id is retired, and the mint claims the id;
- an empty claim left by a killed mint is retired;
- a kernel-shaped orphan refuses the mint, and the ledger bytes are unchanged;
- a failed append releases the claim.

On `origin/main`, the first three fail: the second mint raises after its F-002 event is already in
the ledger.
