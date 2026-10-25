# MF-2 registry event store: tracked follow-up (2026-10-25)

MF-2 freezes `docs/reviews/_registry/findings.jsonl` as a pinned genesis segment and records every
later registry change as an event in the finding's own log (MF-DESIGN §5 MF-2). Branches opened
before the freeze still carry edits to the frozen file, so the package ships an in-flight
converter. Its removal is MF-3 and is tracked here.

## PROC-MEDIUM-062

Retire `tools/gates/finding-registry-migrate-branch.ts` once no open PR touches
`docs/reviews/_registry/findings.jsonl` (MF-3).

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-25.
- Raised by: the MF-2 implementer; registered through the event writer
  (`finding-registry add PROC`), the first `CREATED` event of the store.
- Evidence:
  - `tools/gates/finding-registry-migrate-branch.ts` (the converter: a second path into the event
    store, valid only while branches opened before the freeze are open)
  - `docs/reviews/_registry/genesis.json` (the pin the converter restores the frozen segment to)
- Rule: one owner per concept: after the last pre-freeze branch lands, every event is written by
  the registry CLI through `appendFindingEvents`, and a converter nobody needs is a writer nobody
  maintains.
- Done when: `gh pr list --state open` shows no PR whose diff touches
  `docs/reviews/_registry/findings.jsonl`, and the converter, its spec
  (`tests/invariants/finding-registry-migrate-branch.spec.ts`) and the remedy it names in
  `GENESIS_REMEDY` (`tools/gates/finding-registry-events.ts`) are deleted in one change.

## ARIA-MEDIUM-962

Two kernel readers still treat the frozen `findings.jsonl` as a finding's home: `system_one` cannot
resolve a finding born after the freeze, and the registry view cites `findings.jsonl` as every
row's source.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-15.
- Raised by: the MF-2 implementer; not in MF-2's change list (MF-DESIGN §5), registered through
  the event writer.
- Evidence:
  - `aria-kernel/aria_kernel/system_one.py:362-382` (`_finding` reads `findings.jsonl` at
    `refs/aria-public/heads/main` and refuses an id it does not hold as `finding_not_registered`)
  - `aria-kernel/aria_kernel/report_ingestion.py:97` (`read_registry_view` stamps every row with
    the source `docs/reviews/_registry/findings.jsonl`)
  - `aria-kernel/aria_kernel/report_ingestion.py:314-319` (that source becomes an evidence ref of
    the ingested finding)
- Rule: the store layout has one reader (`tools/gates/finding-registry-projection.ts`), and the
  kernel reads the registry only through `run_registry_cli`.
- Failure scenario: PROC-MEDIUM-062 (or any finding `add` records from now on) is asked about by a
  System One question that cites it: the answer is the refusal `finding_not_registered`, not its
  title and rule. The same finding ingested by `report_ingestion` carries an evidence ref to a file
  that does not contain it.
- Done when: `system_one` asks the projection at the public ref (`project --ref=… --ids …`) and the
  view's source for a finding with an event log is that log, each with a test on an event-born
  finding.
