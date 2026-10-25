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
