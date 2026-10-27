# ARIA MF-2 review: non-blocking findings (2026-10-25)

The MF-2 package (the registry write side moves to per-finding event files and `findings.jsonl`
freezes) was reviewed on branch `feat/registry-event-store` under lenses ssot and evidence. The
points below did not block the merge. Each was re-checked at the branch head (960fae9e7) before
registration: every cited path and line still holds, and near-duplicates were merged. The review
raised 14 points; 13 of them are the nine findings below (three points about the specs that read
only genesis are one finding, as are the two points about autonomy-closure evidence and the two
about stale guidance).

The fourteenth point is already tracked and is not registered again: `system_one._finding`
(`aria-kernel/aria_kernel/system_one.py:362-382`) reads the frozen `findings.jsonl` at
`refs/aria-public/heads/main` as a finding's home. It refuses every finding born after the freeze as
`finding_not_registered`, and it returns the genesis title of a legacy finding whose title was
AMENDED. All its callers are shadow paths, recorded and never read: `system_one_points.py` (lines
127, 149, 187 and 244) and `judgment_funnel.py:146`. ARIA-MEDIUM-962 (owner Okan-wqm, deadline
2026-11-15) owns the fix, and asking the projection at the public ref answers both symptoms.

## ARIA-HIGH-983

The freeze is final only where a non-required workflow runs: pinGenesis re-pins a post-freeze
findings.jsonl without condition, and the always-run integrity spec holds the event logs to the
merge-base but never genesis.json

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens evidence), registered by the MF-2 findings clerk; non-blocking at
  merge.
- Plan item(s): MF-2; MF-3.
- Evidence:
  - `tests/invariants/finding-registry-integrity.spec.ts:622-659` (T7 compares `findings/**` with
    the merge-base and never genesis.json)
  - `tools/gates/finding-registry-events.ts:389-393` (GENESIS_REMEDY offers
    `npm run findings:genesis` for any pin mismatch)
  - `tools/gates/finding-registry-events.ts:437-465` (pinGenesis re-pins the blob on disk and never
    reads the base's pin)
  - `tools/gates/finding-registry-events.ts:587-623` (appendOnlyDefects, the one place genesis.json
    is held to the base)
  - `.github/workflows/closes-footer-check.yml:80-87` (the only caller of verify --base; the check
    is not in .github/manifests/main-required-status-checks.json)
- Rule: CLAUDE.md architectural-solution hierarchy tiers 1 to 3, MF-DESIGN section 6 steps 3 and 4:
  the freeze is final by construction or by a gate every PR runs; a rule enforced only by a check no
  merge requires is not enforced
- Failure scenario: A branch that appended a row to findings.jsonl after the freeze takes the remedy
  the pin-failure message names (`npm run findings:genesis`). The review's probe (a throwaway repo
  with the frozen store): genesis exits 0, `verify` exits 0, so the always-run T6 and T7 pass, and
  only `verify --base=main` in the Closes Footer Check exits 1 (genesis.json: changed since main,
  the freeze is final). That workflow is not a required context, so the frozen segment can be
  rewritten and merged.
- Close condition: pinGenesis refuses when merge-base(HEAD, origin/main) already carries a
  genesis.json that differs from the pin it would write, and GENESIS_REMEDY stops offering the
  re-pin then. T7 (or a new always-run invariant) holds genesis.json byte-equal to the base, as
  appendOnlyDefects does. A test where a branch based on a pinned main appends a findings.jsonl row,
  runs the re-pin, and fails the invariant spec. The pre-freeze landing step, where the base carries
  no pin, keeps working.

## ARIA-MEDIUM-984

Two always-run invariant specs read only the frozen findings.jsonl: finding-id-aliases.spec.ts
judges aliases against the genesis ids alone and finding-evidence-shape.spec.ts checks genesis rows
alone, so event-born findings and AMENDED evidence fall outside both

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot and evidence), registered by the MF-2 findings clerk;
  non-blocking at merge.
- Plan item(s): MF-2.
- Evidence:
  - `tests/invariants/finding-id-aliases.spec.ts:37-48` (ledgerIds reads findings.jsonl only)
  - `tests/invariants/finding-id-aliases.spec.ts:73-83` (the canonical-exists and no-shadow checks
    use that id set)
  - `tests/invariants/finding-id-aliases.spec.ts:139-152` (the reissue check claims the same partial
    set)
  - `tests/invariants/finding-evidence-shape.spec.ts:83` (REGISTRY_PATH is findings.jsonl)
  - `tests/invariants/finding-evidence-shape.spec.ts:99-104` (readEntries reads the genesis rows
    only)
  - `tools/gates/finding-registry-projection.ts:394-396` (readRegistryRows, the reader that folds
    genesis and events)
- Rule: CLAUDE.md one owner per concept (MF-DESIGN section 3): the registry is read through the
  projection (finding-registry-projection.ts), not by a spec's own read of findings.jsonl
- Failure scenario: An alias whose canonical id is an event-born finding (PROC-MEDIUM-062 has no row
  in findings.jsonl) fails 'every alias resolves'. An alias spelled like an event-born id passes 'no
  alias shadows a real ledger id' unnoticed, and the allocator reissue check runs on the same
  partial set. A finding born after the freeze, or one whose evidence an AMENDED event rewrote, is
  never held to the evidence-shape contract by the spec; only the write-time sink covers it. Latent
  today: no alias names a post-freeze id. ARIA-MEDIUM-962 does not cover either spec, since it names
  only the kernel readers.
- Close condition: Both specs take their rows from readRegistryRows. Tests with an alias to an
  event-born id (resolves), an alias equal to an event-born id (caught as a shadow), and an
  event-born row with non-canonical evidence (flagged).

## ARIA-MEDIUM-985

Autonomy-closure evidence pins and verifies only the frozen findings.jsonl blob: the event logs that
`project --stdin --ref` folds are neither chain-verified nor named in the evidence refs, so
registry_chain_valid_at_evidence_target claims more than it checks

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot and evidence), registered by the MF-2 findings clerk;
  non-blocking at merge.
- Plan item(s): MF-2.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_closure.py:78` (REGISTRY_PATH is findings.jsonl)
  - `aria-kernel/aria_kernel/autonomy_closure.py:312-333` (`_registry_snapshot` reads that blob and
    cites `{evidence}:findings.jsonl@<blob>` as the evidence ref)
  - `aria-kernel/aria_kernel/autonomy_closure.py:366` (`verify --stdin` runs the chain test on the
    blob's bytes alone)
  - `aria-kernel/aria_kernel/autonomy_closure.py:380` (`project --stdin --ref` then reads the event
    logs at the ref, with no chain test on them)
- Rule: MF-DESIGN section 4.3: an evidence pin of the registry is the git tree id of
  `docs/reviews/_registry` at the evidence commit, and the chain predicate verifies everything the
  closure verdict reads
- Failure scenario: The blob is frozen, so the cited ref `{evidence}:findings.jsonl@<blob>` is the
  same string for every event state. A corrupted or rewritten event log at the evidence commit
  leaves registry_chain_valid_at_evidence_target true and the ref unchanged, and the closure verdict
  is computed from logs whose hash chains nobody checked on this path. The verdict is correct for
  logs that hold; the claim of a verified registry is wider than the check. Read from the code, not
  probed.
- Close condition: The predicate verifies the whole store at the evidence target (the genesis blob
  and every event log's chain, through the registry CLI that owns the test) and the evidence ref
  names the tree id of `docs/reviews/_registry`. A test where a log with a broken chain at the
  evidence commit makes the predicate false.

## ARIA-LOW-986

The in-flight branch converter folds the registry with its own foldedById, a second fold beside
foldRegistry: it applies logs to genesis rows only and skips every event-born log

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot), registered by the MF-2 findings clerk; non-blocking at
  merge.
- Plan item(s): MF-2; MF-3.
- Evidence:
  - `tools/gates/finding-registry-migrate-branch.ts:222-230` (foldedById, the converter's own fold)
  - `tools/gates/finding-registry-projection.ts:375-387` (foldRegistry, the fold readers use)
  - `tools/gates/finding-registry-events.ts:236-239` (foldById, a map over foldRegistry)
- Rule: CLAUDE.md one owner per concept: the registry fold is foldRegistry in
  finding-registry-projection.ts
- Failure scenario: No wrong output today: a pre-freeze branch edits genesis rows only, which the
  copy folds. The copy is a second spelling of the fold that a change to the projection's rules (a
  new event type, a derived field) does not reach, so the converter's 'current' row can come apart
  from the row readers see. Read from the code, not probed.
- Close condition: foldedById is deleted and the converter takes its current rows from foldRegistry
  (through the events.ts map), or the whole converter is deleted first by PROC-MEDIUM-062. A grep of
  the converter for applyFindingEvent finds no fold of its own.

## ARIA-LOW-987

pinGenesis re-anchors event logs by rewriting them in place with atomicWriteFileWithRegistryLease,
bypassing planFindingEvents: a second, non-append write path into `findings/**` beside the
append-only writer

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot), registered by the MF-2 findings clerk; non-blocking at
  merge.
- Plan item(s): MF-2; MF-3.
- Evidence:
  - `tools/gates/finding-registry-events.ts:419-427` (reanchor re-chains every line of a log)
  - `tools/gates/finding-registry-events.ts:450-462` (pinGenesis writes the re-chained logs
    directly)
  - `tools/gates/finding-registry-events.ts:339` (appendFindingEvents, the planned append path)
- Rule: CLAUDE.md one owner per concept (MF-DESIGN section 4.1): every write into `findings/**` is
  an append that planFindingEvents has admitted
- Failure scenario: The rewritten lines skip the planner's admission test (row contract, owner rule,
  state fold) that every other event passes, and they rewrite bytes the append-only invariant
  otherwise forbids. Once the freeze is on main the branch never runs: pinGenesis re-anchors only
  when the previous tip differs from the new one, and the segment no longer changes. Read from the
  code, not probed.
- Close condition: The re-anchor branch and reanchor are deleted when the landing step they serve
  ends (the last pre-freeze branch has landed, the condition of PROC-MEDIUM-062), or they go through
  planFindingEvents. A test that the lines pinGenesis rewrites pass registryDefects.

## ARIA-LOW-988

AMENDABLE_FIELDS and AmendedFields hand-mirror the keys of finding-event.schema.json $defs/amended,
and no spec pins the TypeScript lists to the schema: T5 pins only the event-type list

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot), registered by the MF-2 findings clerk; non-blocking at
  merge.
- Plan item(s): MF-2.
- Evidence:
  - `tools/gates/finding-registry-projection.ts:270` (AMENDABLE_FIELDS)
  - `tools/gates/finding-registry-events.ts:99-106` (AmendedFields)
  - `docs/reviews/_registry/finding-event.schema.json:200-231` ($defs/amended)
  - `tests/invariants/finding-registry-events.spec.ts:189-232` (T5 pins the event vocabulary, not
    the amended keys)
- Rule: CLAUDE.md one owner per concept and the tier-3 rule: a list written in three places is
  derived from one or pinned by a test
- Failure scenario: A field added to the schema's amended keys (or removed) leaves AMENDABLE_FIELDS
  and AmendedFields as they were: the converter stops carrying the field, or the types admit a field
  the schema refuses, and nothing is red until a branch hits it.
- Close condition: AmendedFields is derived from the AMENDABLE_FIELDS tuple and a spec compares that
  tuple with the keys of the schema's $defs/amended fields, so adding a key in one place is red
  until the others follow.

## ARIA-LOW-989

The counters agentFindingIssuedTotal and agentFindingStateTransitionTotal have no incrementer since
FindingRegistryService was deleted, and the doc comment that names the writer is false

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot), registered by the MF-2 findings clerk; non-blocking at
  merge.
- Plan item(s): MF-2.
- Evidence:
  - `libs/backend-common/src/metrics/orchestrator-metrics.ts:99-110` (agentFindingIssuedTotal and
    its comment 'Incremented at finding-registry add-time')
  - `libs/backend-common/src/metrics/orchestrator-metrics.ts:112-121`
    (agentFindingStateTransitionTotal)
  - `libs/backend-common/src/metrics/orchestrator-metrics.ts:244-245` (their only other mention, the
    registration list)
  - `.github/workflows/rule-health-report.yml:224` (the report waits for agent_finding_issued_total)
- Rule: CLAUDE.md one owner per concept: a metric names a writer that exists; its only incrementer,
  FindingRegistryService, is gone
- Failure scenario: Both counters export no samples. rule-health-report.yml still names
  agent_finding_issued_total as the metric its rule-firing rate will read, and nothing can increment
  it.
- Close condition: Either the counters and their registration are deleted together with the
  rule-health-report wait text, or the event writer's CLI-side owner emits them and the comment
  names it. A grep finds no counter without an incrementer.

## ARIA-LOW-990

Agent guidance and the fuzz crash issue body still name `docs/reviews/_registry/findings.jsonl` as
the place to read finding state from or to file a finding under: an agent that follows them reads
the frozen segment, and a responder's filing fails the genesis pin

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens ssot and evidence), registered by the MF-2 findings clerk;
  non-blocking at merge.
- Plan item(s): MF-2.
- Evidence:
  - `.claude/agents/root-cause-auditor.md:34` (names findings.jsonl as the source of prior rulings)
  - `.claude/agents/root-cause-auditor.md:60`
  - `.claude/agents/root-cause-auditor.md:71`
  - `.claude/agents/root-cause-auditor.md:120` (the single source of state)
  - `.claude/shared/output-format.md:173`
  - `.claude/shared/tier-claim-syntax.md:80`
  - `.claude/knowledge/layer-1-ai.md:58`
  - `.github/workflows/fuzz-st-parser-nightly.yml:202` (the issue body step 4: file a finding under
    findings.jsonl)
- Rule: CLAUDE.md one owner per concept (MF-DESIGN section 6): guidance names the projection
  (`finding-registry project`) to read and the event writer (`finding-registry add`) to file, not
  the frozen segment
- Failure scenario: An agent told to read open rulings from findings.jsonl sees only the findings
  born before the freeze and misses every later one. A responder who follows step 4 of the fuzz
  issue and appends a row to findings.jsonl fails the genesis pin.
- Close condition: Each cited line points at `finding-registry project` for reading and
  `finding-registry add` for filing. A test (tier 3) that fails when a file under .claude/ or an
  issue-body step in .github/workflows names findings.jsonl as a read or write target other than as
  the frozen genesis segment.

## ARIA-LOW-991

The ledger migration ignores a constraint that already exists under the same name even when its
definition differs, and `finding-event-ledger mirror` refuses forever once an old-vocabulary row
exists without naming a remedy

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the MF-2 review (lens evidence), registered by the MF-2 findings clerk; non-blocking at
  merge.
- Plan item(s): MF-2.
- Evidence:
  - `apps/event-store-service/src/migrations/1801300000000-MirrorGitFindingEvents.ts:41` (EXCEPTION
    WHEN duplicate_object THEN NULL, up)
  - `apps/event-store-service/src/migrations/1801300000000-MirrorGitFindingEvents.ts:64` (the same
    on down)
  - `tools/gates/finding-event-ledger.ts:173-183` (mirror refuses rows that are not git lines and
    names the rows, not what to do)
- Rule: CLAUDE.md Architectural Approach: a mismatch is not hidden behind an ignored error, and a
  refusal names its remedy
- Failure scenario: A finding_events_git_mirror_chk that exists with another definition makes up() a
  silent no-op, so the new rows are bound by the old check. The ledger table is immutable by
  trigger, so one old-vocabulary row makes every later mirror run refuse; the refusal lists the rows
  but names neither the parity command nor the operator step. Read from the code, not probed; the
  ledger is not wired to a lane yet, so no row of the old vocabulary is known to exist.
- Close condition: up() reads the existing constraint's definition (pg_get_constraintdef) and fails
  when it differs from the intended one, instead of swallowing duplicate_object. The mirror refusal
  names `finding-event-ledger parity` and the operator step for rows the registry does not hold. A
  test for each.
