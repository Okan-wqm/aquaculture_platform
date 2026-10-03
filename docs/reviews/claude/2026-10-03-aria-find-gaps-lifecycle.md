# ARIA finding lifecycle — identity, mint order and stale evidence (2026-10-03)

Context: a read-only investigation of how ARIA mints, deduplicates and re-reads its own findings,
measured on `main` 405f2ecac and on `origin/aria/state` (the durable store the runner publishes).
The store holds 14 `finding_emitted` events (F-001..F-014) and 16 `F-*.json` files; eight of the
fourteen are drift findings for three subjects, and F-007, the finding the operator's first signed
request names (ADR-0018), cites a line that no longer holds what the finding saw. Each gap below was
re-checked against 405f2ecac before it was registered.

Owner: claude (implementation), okan (review). Deadline 2026-10-17.

## ARIA-MEDIUM-330

`emit_finding` appends the `finding_emitted` event before it checks that the finding's file is
free. When the next id collides with a file the ledger never emitted, the mint raises after the
event is already in the ledger: the ledger then names a finding whose file belongs to someone else.
Two such files exist on `aria/state`: F-101 and F-102, written by the pre-ORPHAN-702 seeder writer
that is still in `tools/aria-poc`, kept alive only by its own tests. The ledger reaches F-100 in 86
mints. Readers already disagree about what exists: the daily report and the F_FINDING plan source
glob `F-*.json` (16 findings; F-101/F-102 become plan candidates the admission then refuses as
`finding_unknown`), while `cycle_guard` reads the index built from the ledger (14).

Evidence:

- `aria-kernel/aria_kernel/finding.py:482` (the event is appended) and `:497` (the collision is
  checked only after the append)
- `tools/aria-poc/seed_drift_findings.py:42` (`FINDING_ID_BASE = 101`) and `:105-156`
  (`render_finding`, `render_index`, `write_findings`: files written outside the ledger)
- `aria-kernel/tests/test_seed_drift_findings.py:60-87` (the only callers of the legacy writer)
- `aria-kernel/aria_kernel/reflection.py:391` and `aria-kernel/aria_kernel/plan_synthesizer.py:602`
  (both glob `F-*.json`)
- `aria-kernel/aria_kernel/cycle_guard.py:86` (reads the ledger-built index)

Rule: The finding-event ledger is the one authority for which findings exist. No event names a
finding whose file that mint did not create, and every reader counts and selects findings from the
folded ledger (`finding.fold_findings`), never from files beside it.

Fix: `emit_finding` claims the finding's file with an exclusive create before it appends the event,
so a collision is refused by name (`finding_file_collision`) with the ledger unchanged. The legacy
writer and its tests are deleted. The daily report and the F_FINDING source read the fold, which
also shows status changes the frozen JSON never sees. The two stray files on `aria/state` are inert
for every reader after the fix; deleting them is a store action for the operator before the ledger
reaches F-100, otherwise that mint is refused by name.

## ARIA-HIGH-331

A finding's dedupe key is a hash of its evidence refs, lines included, and their summary text. The
drift seeder's only dedupe compares that hash, so a cited line that moves mints a new F-NNN and the
old one never closes. F-001..F-008 are eight OPEN findings for three subjects. F-001, F-004 and
F-006 cite `CategoriesTab.tsx` at lines 106, 107 and 201 against `finance-events.ts:38`. F-003,
F-005, F-007 and F-008 cite `LeavesPage.tsx` at 346, 358, 355 and 353 against
`leave-request.entity.ts:18`; F-002 pairs the same page with the mobile app's type. On 405f2ecac
the LeavesPage status filter has moved again (its `id` is at line 396), so the next seeder run that
still sees that drift mints another record. The kernel itself never refuses a second open finding
on one subject.

Evidence:

- `tools/aria-poc/seed_drift_findings.py:210-215` (dedupe on `_evidence_chain_id`)
- `aria-kernel/aria_kernel/finding.py:178-185` (`_evidence_chain_id` hashes `path:line` and summary)
- `aria-kernel/aria_kernel/finding.py:373` (`emit_finding`: no subject refusal)
- ADR-0022 `:28` (line-based identity re-mints the same defect) and `:177` (dedupe on detector class
  plus a line-free subject)

Rule: ADR-0022 — a finding is deduped on its detector class and its line-free subject, never on
refs or lines. The kernel refuses a mint whose declared subject an open finding of the same
`originating_skill` and `claim_type` already cites, so every producer gets the rule.

Fix: the tier-1 step of ADR-0022, before node IDs exist. An evidence may declare the `symbol` it
points at (the enum, the select, the concept name); the subject is the set of (path, symbol) pairs,
with lines stripped. When every evidence of a mint declares a symbol, `emit_finding` refuses it
under the allocation lock with `subject_already_open:F-xxx` if a non-terminal finding of the same
detector class cites the same subject, writing no id and no event. A recorded ref that declared no
symbol names its whole file, so the eight pre-symbol drift records keep blocking re-mints of their
subjects. A mint that declares no symbol has no line-free subject and keeps its producer's own
dedupe (consensus fingerprints, watchdog signatures). The seeder declares each side's name and drops
its ref-hash dedupe. Folding the eight existing records into three, and re-grounding an open
finding when its subject is re-observed at a new line, stay with ADR-0022 design C (C-M2, plan rev2
K17, owner okan, target 2026-10-16).

## ARIA-HIGH-332

Nothing re-grounds or retires a finding's evidence. `finding_grounding.admit_finding` checks that a
cited file is tracked at the anchor commit and never reads the cited line, so a finding whose
evidence no longer says what the finding saw still grounds a plan. F-007 cites
`LeavesPage.tsx:355`: a `<select` at its mint commit 0fb5f096b, a `placeholder=` attribute on
405f2ecac.

Evidence:

- `aria-kernel/aria_kernel/finding_grounding.py:443-450` (admission judges `tracked_files_at` only)
- `aria-kernel/aria_kernel/main_anchor.py:171` (`committed_blob`, the hardened reader no admission
  uses for line content)
- `web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:355` (F-007's cited line)

Rule: A finding grounds a plan only on evidence that still says what the finding saw. Each
`path:line` ref's line at the commit the finding verified it against equals the same line at the
anchor commit, or the finding is refused by name.

Fix: admission reads each cited line at the commit the evidence envelope was verified against
(`evidence_envelope.target_sha`, falling back to the mint event's `target_sha`) and at the anchor,
both through `main_anchor`'s hardened reader. A changed line is refused per ref as `ref_stale`, a
line ref with no recorded commit as `ref_origin_unrecorded`, and either refuses the finding as
`finding_evidence_stale`, a request-intrinsic reason. A commit the checkout cannot read is the
runner's fault (`checkout_unavailable`). No schema change: every record `emit_finding` wrote already
carries the commit. On merge, F-007 and the operator request that names it are refused until the
finding is re-grounded (ARIA-HIGH-331's design C step).
