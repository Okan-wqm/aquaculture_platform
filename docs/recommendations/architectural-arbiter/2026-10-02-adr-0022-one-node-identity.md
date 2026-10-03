# ADR-0022 — One Node Identity Across Graph, Memory and Findings

**Status:** accepted (operator, 2026-10-02)
**Date:** 2026-10-02
**Owner:** okan
**Decision deadline:** before the first node ID is written to a committed or published surface
(program plan rev2, constraint K-8); target 2026-10-16
**Resolves:** architectural-arbiter program-review rulings 2 (identity defined three times) and 13
(identity listed among the undecided one-way doors), 2026-10-02
**Enables:** CONTRACT-MEDIUM-006 and ARIA-MEDIUM-271 (both registered by PR #1711, not yet on
`main` at 44983f55d)
**Plan reference:** `/root/.claude/plans/crystalline-purring-hare.md` rev2, constraint K-8
**Related:** ADR-0023 (the `aria-operator-journey` namespace that signs journey anchors)

## Context

The ARIA memory and repository-knowledge program (plan rev2) links everything through one node: a
finding, a memory act, an operator label, a pin, a runtime window, a critical journey and a persona
verdict all point at the same element of the repository. The program's first draft defined that
element's identity three times, in three phases: the journey graph's `node_id` (design B, decision
D4), the calibration lane's `subject_key` (design C, step C-M2) and the memory's `locus_id`
(design A, PR-8), with critical-journey anchors signed separately (CJ-0, CJ-1). The architectural
arbiter ruled that identity is decided once, before any of them writes an ID (ruling 2), and listed
identity among the one-way doors no ADR covered (ruling 13).

Three measurements show what the identities in use today cost.

- **Line-based identity re-mints the same defect.** The drift seeder dedupes on a hash of the
  evidence refs (`tools/aria-poc/seed_drift_findings.py:210-215`, through
  `aria-kernel/aria_kernel/finding.py:165-171`), and the scan writes each ref as `path:line`
  (`tools/aria-poc/poc.py:524` for TypeScript enums; `:766`, `:784`, `:805` and `:823` for the UI
  option groups behind F-001 to F-008). When a line moves, the hash changes and a new finding is
  minted; the old one never closes. On `aria/state` 05c5d3160, F-001 to F-008 are eight OPEN
  findings for three drift pairs: F-003, F-005, F-007 and F-008 cite the same `LeavesPage.tsx` /
  `leave-request.entity.ts` pair at lines 346, 358, 355 and 353; F-001, F-004 and F-006 cite the
  same `CategoriesTab.tsx` / `finance-events.ts` pair at lines 106, 107 and 201. F-007 is the
  finding the operator's first signed request targets (ADR-0018); a fix verified on it leaves its
  three twins open.
- **Name-keyed identity collapses distinct elements.** The dead-contract scan keys GraphQL
  operations by constant name (`tests/invariants/lib/dead-contract-scan.ts:32`, `:76`), so 81
  operation names defined in more than one file collapse into one (CONTRACT-MEDIUM-006). Every
  runtime pressure gets the id `pressure:runtime_signal:unknown`, because the id is the source
  plus a discriminator that runtime signals never set, falling back to the pressure type
  (`aria-kernel/aria_kernel/pressure.py:507-508`, `:1002-1005`; ARIA-MEDIUM-271), and a runtime
  signal's own id hashes its summary text
  (`aria-kernel/aria_kernel/runtime_signal_bridge.py:43-47`).
- **Line-free identity without lineage does not survive refactors.** The program review's
  accounting reviewer replayed 90 days of history at 7166e2f5e: 12.2% of 2,392 input IDs were
  retired, `git diff -M` recovered none of them (it reported 2 renames while 50 files were deleted
  and 102 added), and 94 component names repeat across 258 files, so a name without its path is
  ambiguous. Labels, pins and memory loci on a retired ID are orphaned, a detector no longer sees
  an orphaned subject, and design C's absence-based closure would then close the finding falsely.

The kernel reads a rename as a deletion plus an addition, on purpose: every reader that decides
something from a change's path set goes through `git diff --name-status -z --no-renames`
(`aria-kernel/aria_kernel/change_paths.py:1-15`, `:37`; ARIA-CRITICAL-214), and the twin's
source-membership check does the same (`aria-kernel/aria_kernel/twin.py:913-918`). Identity
lineage cannot come from git's rename heuristics without contradicting what those safety readers
see.

## Decision

### One identity under one name

`node_id`, `locus_id` and `subject_key` are one value with one definition: the node ID of the
pack's ontology. Every schema written from now on carries it under the field name `node_id`, or
`node_ids` for a set: a memory event's `subject.node_ids` (design A's `subject.locus_ids` under its
final name), a finding's `subject.node_ids`, a label item, a pin, a runtime window and a
critical-journey anchor. No subsystem defines, hashes or maps an identity of its own.

### The ID grammar

```text
node_id = pack "/" kind ":" scope "#" local
pack    = 1*( %x61-7A / DIGIT / "-" )      ; the pack id, e.g. software-repo
kind    = 1*( %x61-7A / "_" )              ; a record kind of that pack's ontology
scope   = segment *( "/" segment )         ; repository-relative POSIX path, no "." or ".."
local   = part *( ">" part )
segment = 1*( pchar except "/" )
part    = 1*pchar                          ; may hold "/" and ":" (route and REST paths)
pchar   = printable ASCII except "#", ">", "%" and space, or "%" 2HEXDIG
```

`pack` ends at the first `/`, `kind` at the first `:`, `scope` at the first `#`; the rest is
`local`, split on `>`.

- **The kernel sees an envelope.** It validates `pack`, `kind`, `scope` and the part charset and
  treats the rest as opaque, so a second pack defines its own kinds without a kernel change
  (design B, decision D5).
- **Line-free.** No line, column, byte offset or sibling ordinal is ever a part. Spans
  (`start_line`, `end_line`) are node attributes for display and evidence, never identity.
- **Path-qualified.** `scope` is a repository-relative path. Code-local kinds use the declaring
  file. Contract kinds, whose names the platform keeps unique inside a project, use the owning Nx
  project root, so a file move inside that project does not change their ID.
- **ASCII, sorted by code unit.** Anything outside the part charset is percent-encoded UTF-8, so
  byte order, code-point order and UTF-16 code-unit order coincide. ID lists, lineage lists and
  digests are sorted by code unit. `localeCompare`, `Intl.Collator` and locale case mapping are
  banned from pack extractor code: a `tr_TR` locale orders ı, I, i and İ differently from
  `C.UTF-8`.
- **No numbered siblings.** Elements that share every canonical part are one node with a
  `multiplicity` attribute. Elements rendered from data (a `.map` over rows) are the
  `data_multiplicity` bucket.

### Canonical parts per record kind

"Owner" is the nearest named declaration (exported component, function or class) that contains the
element. "Project" is the Nx project root.

| Kind          | scope               | local parts                                               |
| ------------- | ------------------- | --------------------------------------------------------- |
| route         | declaring project   | resolved path pattern, parents joined, params by name     |
| screen        | component file      | component symbol                                          |
| tab           | tab owner file      | owner > tab-set key (state, param or query) > tab value   |
| form          | file                | owner > submit handler, or the state object fields write  |
| input         | file                | owner > [form >] bound key: state path, `name`, then `id` |
| action        | file                | owner > event prop > handler (inline: first callee)       |
| gql_op        | declaring file      | operation type > operation name                           |
| gql_field     | subgraph project    | parent type > field name                                  |
| rest_endpoint | service project     | method > effective path (global prefix, version applied)  |
| dto_field     | DTO file            | DTO class > property name                                 |
| entity        | service project     | schema > table (module schema for per-tenant tables)      |
| column        | service project     | schema > table > database column name                     |
| event         | event-contracts lib | `eventType`                                               |
| subscriber    | consumer project    | subject pattern > handler class > method                  |

Examples from the hr slice the program starts with:

```text
software-repo/input:web/modules/hr-module/src/pages/leaves/LeavesPage.tsx#LeavesPage>filter.status
software-repo/gql_op:web/modules/hr-module/src/graphql/leave.operations.ts#query>GetLeaveRequests
software-repo/gql_field:apps/hr-service#Query>leaveRequests
software-repo/gql_field:apps/hr-service#LeaveRequest>status
software-repo/column:apps/hr-service#hr>leave_requests>status
```

They come from `LeavesPage.tsx:41` and `:397-398` (owner and bound key),
`leave.operations.ts:55-56`, `apps/hr-service/src/leave/leave.resolver.ts:191`,
`leave-request.entity.ts:62-63`, `:86` and `:153-155`, and the `hr` module schema
(`libs/backend-common/src/database/schema-manager.service.ts:608-609`).

The ontology has more kinds than these fourteen (design B counts about 33). Each kind's parts are
defined once in the pack ontology under the rules above. Adding a kind is a pack version. Changing
the parts of a kind that has written IDs is an amendment of this ADR.

### Lineage: the pack emits it, the kernel stores and resolves it

Five events form a closed vocabulary (`aria/node-lineage/v1`):

- `born` (none to one): an ID appears with no predecessor, or an ID that was retired or renamed
  away becomes live again (a revert);
- `renamed` (one to one): file move, symbol rename, key rename, extraction into another owner;
- `split` (one to two or more);
- `merged` (two or more to one);
- `retired` (one to none): the matcher found no successor.

**The pack emits lineage.** Its structural matcher takes the IDs live at the base commit and absent
at the head commit, and compares their structural fingerprints with those of the head's new IDs of
the same kind. A fingerprint covers the element's normalized AST (comments, whitespace and local
identifier names normalized away; shape and literals kept) and its owner symbol's shape. Pairing is
deterministic, with ties broken by code-unit order. Normalizations and thresholds are pack data,
named by a matcher digest.

**Each event is evidence.** It records the base and head commits, the pack id and version, the
matcher digest, the fingerprints and the match score. Valid time is the head commit and record time
is when it was written (bitemporal, design A), so a better matcher can add lineage for an old
commit without rewriting anything.

**The kernel only stores and resolves.** It validates the envelope and the arity, refuses an event
whose source IDs are not live at its commit or whose target IDs already are, appends to the one
lineage store (the memory event log of A3, under a kernel-owned kind; `record_graph.py` reads it
and keeps no copy), and answers `resolve(node_id, at_commit)` by following events in commit order:
`renamed` and `merged` give one successor, `split` gives a set, `retired` gives none. The kernel
never parses a kind's local parts and never runs a matcher.

### ID churn never closes a finding

A finding's subject is `subject.node_ids`, and dedupe is on detector class plus that set, never on
refs or lines (C-M2). When a detector run does not re-observe a finding, the kernel resolves its
subject at the run's commit:

- every subject resolves to a live node and the run's coverage includes it: the run records
  `finding_absent_verified`, which may resolve the finding (design C);
- any subject resolves to nothing (retired, or absent with no lineage event): the finding's subject
  state becomes `absent_due_to_id_churn`; the finding keeps its status, is listed in the weekly
  report and enters the label queue;
- the run did not cover the subject: nothing is recorded, because not observed is not absent.

`absent_due_to_id_churn` is a subject-resolution state beside the status, not a member of
`STATUSES` (`aria-kernel/aria_kernel/finding.py:43`), so no transition in `STATUS_TRANSITIONS`
(`finding.py:68-79`) leads from it to RESOLVED. The two new events, `finding_reobserved` and
`finding_absent_verified`, enter the closed finding-event vocabulary (`finding.py:55-66`) in C-M2,
which is the route that vocabulary requires for any new event type.

### Refactor survival gates the first ID

Before any extractor writes IDs, the pack's matcher passes a refactor-survival test with at least
95% carry-over in each of five mutation classes, measured separately: file move, symbol rename,
component extraction, state-variable rename and sibling reorder. Carry-over is the share of base
IDs whose element still exists at the head and whose `resolve` at the head is that element's head
ID. The test runs on a fixture mini-repository and on seeded mutations in a clean worktree of this
repository (design B's mutation harness), on hosted runners (constraint K-7′). Sibling reorder
must reach 100% without any lineage event, because IDs carry no ordinal. The 90-day replay that
measured 12.2% retired IDs is re-run and reported against that baseline.

## Consequences

- **No node ID before acceptance.** B-P1 (the journey-graph core) does not emit IDs, the hr-slice
  extractor prepared during Faz 0b writes none to a committed or published surface, and the
  operator does not sign critical-journey anchors (CJ-0, CJ-1), which are node IDs. CJ-1 also
  needs ADR-0023's `aria-operator-journey` namespace.
- **C-M2 and A PR-8 are one kernel change**, `ID` (K17 in plan rev2): subject dedupe, the subject
  field, lineage storage and `resolve`. It lands after A3, whose event log is the lineage store,
  and before A7 and RT-5 (arbiter ruling 7). The matcher and its survival test live in
  `packs/software-repo/`, and the ID change does not merge before the matcher passes the gate.
- **The seeder's ref-hash dedupe is replaced** by subject dedupe. F-001 to F-008 fold into three
  findings once the chain is closed; design C waits for that because the F-007 request's signed
  grounding digest binds its refs (ADR-0018, decision 2).
- **Collisions get a key.** Path-qualified `gql_op` IDs keep same-named operations in different
  files apart (CONTRACT-MEDIUM-006), and RT-5 can discriminate runtime pressures by node and class
  (design D), which gives each its own id (ARIA-MEDIUM-271).
- **The kernel stays domain-free.** No kind name, ID parser or git rename heuristic enters
  `aria_kernel/`.
- **The losing side.** Extractors compute canonical parts per kind instead of `path:line`; every
  indexed commit costs a matcher pass on a hosted runner; a churned subject stays open and costs an
  operator label; IDs are longer than line refs.

## Rejected alternatives

- **Line-based IDs** (`path:line`, or a hash of refs that contain lines). This is the seeder today:
  eight open findings for three defects, none of which can close.
- **Per-subsystem IDs reconciled later.** Memory is immutable, so the first scheme written stays
  forever. Reconciling would need a permanent mapping layer between schemes, the compatibility shim
  the root rules forbid, and per-subsystem keys already collide (CONTRACT-MEDIUM-006,
  ARIA-MEDIUM-271). Arbiter ruling 2 rejected this shape.
- **Rename tracking through `git -M` alone.** Measured: it recovered none of the retired IDs. It
  pairs whole files by content similarity, so it cannot see component extraction, symbol or state
  renames, or an element moving between files. It is specific to git, while the kernel must serve
  other packs (arbiter ruling 18), and it would contradict the kernel's deliberate `--no-renames`
  reading of a change (`change_paths.py:1-15`).
- **Opaque IDs minted at first sight and kept in a sidecar map.** The map becomes a second identity
  registry, needs the same structural matcher to survive refactors, and cannot be recomputed from a
  commit, so CI could not check a local graph digest against its own.
- **The structural fingerprint as the ID.** Every edit to an element would retire it.

## One-way doors

- **The grammar, the field name `node_id`, and each kind's canonical parts.** Memory rows are
  hash-chained: a row's hash covers its content and its predecessor's hash
  (`aria-kernel/aria_kernel/ledger.py:1263-1268`), a rewrite is a migration through
  `rewrite_declared_jsonl` (`ledger.py:1627-1640`), and the memory program refuses at publish a
  memory surface that shrinks (A1a, plan rev2 K2) and a sealed segment that changes (A4, K19). The
  first scheme written therefore stays readable forever. A later change to a kind's parts is
  expressed as lineage, a `renamed` event from each old ID to its new ID under a migration matcher
  digest, never as a rewrite; old IDs never leave history.
- **The five lineage events and their arity.**
- **The meaning of `absent_due_to_id_churn`:** churn never closes a finding.

Not doors: the matcher's fingerprints and thresholds, extractor rules and new kinds. They are pack
versions, and every lineage event names the matcher digest it came from.

## Verification

- **Grammar and line-freedom:** every emitted ID parses; inserting blank lines and comments into
  the fixture repository leaves the ID set byte-identical; the kernel refuses an ID with non-ASCII
  bytes or an empty part.
- **Refactor survival:** at least 95% carry-over per mutation class, as decided above, plus 100%
  on sibling reorder with no lineage event.
- **Determinism:** one commit extracted under `tr_TR.UTF-8` and `C.UTF-8` with two Node majors
  gives byte-identical ID sets and graph digests; a lint test refuses `localeCompare`,
  `Intl.Collator`, `toLocaleLowerCase` and `toLocaleUpperCase` in pack code.
- **Lineage store:** wrong arity is refused; a source that is not live, or a target that already
  is, is refused; a revert (A renamed to B, then B renamed to A) resolves to A; a split resolves
  to a set and a retirement to none; an event recorded late changes resolution only for commits at
  or after its valid time.
- **Churn never closes (a test that fails before C-M2):** a subject retired between two detector
  runs leaves the finding open with `absent_due_to_id_churn`; only a covered subject that resolves
  to a live node produces `finding_absent_verified`.
- **Dedupe regression:** replaying the drift seeder over the commits that minted F-001 to F-008
  yields three findings, and a line shift re-observes a finding instead of minting one.
- **Collision:** two files that define an operation with the same name yield two `gql_op` IDs.

## Status of this record

Accepted by the operator on 2026-10-02 after review of the draft, as the header records. From the
first node ID written to a committed or published surface (constraint K-8), every extractor,
finding, label, pin and critical-journey anchor uses this `node_id`. A change to this decision is
an amendment: a new record that names this one.
