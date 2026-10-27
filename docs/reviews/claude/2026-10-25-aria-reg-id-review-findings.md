# ARIA REG-ID review: non-blocking findings (2026-10-25)

The REG-ID package (one owner of the finding-id grammar per language, a four-digit sequence, and the
invariant that fails a second spelling; closes PROC-HIGH-063) was reviewed on branch
`feat/registry-finding-id-4digits` at 2aae4bede under lenses ssot (single owner) and evidence
(integrity). Neither lens found a blocker. The review raised 14 non-blocking points; each was
re-checked at that head before registration: every cited path and line still holds and no point was
dropped. Near-duplicates were merged: the two points about the Closes-trailer mirror are one
finding, the two about check-advisory-ignore-sync.ts are one, and the loose width-agnostic readers
(two lenses) together with the review file's wording are one, so the 14 points are the 10 findings
below.

## ARIA-MEDIUM-1000

The byte-for-byte mirror between the gate's Closes-trailer regex and the kernel's was deleted, and
nothing pins the part that is still typed twice: the trailer frame and the F-NNN, F-AUTO-V and DEBT
forms

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens ssot and evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `aria-kernel/aria_kernel/plan_origin.py:65-72` (CLOSES_TRAILER_RE; its comment says the F and
    DEBT forms are mirrored verbatim)
  - `tools/gates/commit-msg-validator.ts:114-116` (CLOSES_TRAILER_REGEX: the same frame and the same
    F-NNN, F-AUTO-V and DEBT alternatives)
  - `aria-kernel/tests/test_registry_finding_id_four_digits.py:51-57` (the refused values leave out
    F- and DEBT- values and whitespace)
  - `aria-kernel/tests/test_registry_finding_id_four_digits.py:62-76` (the trailer tests match only
    the registry-id group of the table)
- Rule: CLAUDE.md one owner per concept and the architectural-solution hierarchy tier 3: a copy that
  cannot move to an owner is held to its twin by a test that turns red when one side changes
- Failure scenario: Commit 9019036f2 removed test_closes_trailer_regex_mirror, which compared the
  whole Python CLOSES_TRAILER_RE with the gate's source. The registry id inside the trailer now
  comes from each language's owner and the table test covers it. The prefix `Closes:\s+(\S+?)#`, the
  F-NNN, F-AUTO-V and DEBT alternatives and the closing `\s*$` are still typed in both tools, and no
  test compares them: `git grep CLOSES_TRAILER_REGEX -- aria-kernel` finds comments only. Changing
  the F or DEBT form in the gate leaves the kernel minting trailers the gate refuses, or refusing
  ones the gate accepts, with every test green.
- Close condition: The trailer frame and the F-NNN, F-AUTO-V and DEBT alternatives have one source
  per language that the gate and the kernel both build from, as the registry id already does, or one
  table of trailer lines (accepted and refused: F-001, F-AUTO-V1.2-X, DEBT-2026-05-08-001, a
  trailing space, a missing #) is evaluated by both tools. A test that edits one side's F or DEBT
  form turns red.

## ARIA-MEDIUM-1001

The restatement invariant has narrow recall: finding-id-grammar.spec.ts matches only the shapes the
repository carried at the base, so a new fixed-digit finding-id regex of another shape passes it

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `tests/invariants/finding-id-grammar.spec.ts:189-227` (DIGITS, RESTATEMENT_SHAPES and
    restatementsIn: the four-severity alternation, a [A-Z0-9]+ classifier, the ORPHAN heading form,
    padStart(3, parseInt(...slice(-3)))
  - `tests/invariants/finding-id-grammar.spec.ts:249-291` (the self-test lists only sites the base
    carried)
  - `tests/invariants/finding-id-grammar.spec.ts:25-29` (the header says the shapes cover the
    domain-classifier-sequence segments; the classifier segment is only [A-Z0-9]+)
- Rule: CLAUDE.md architectural-solution hierarchy tier 3: a detector that only recognises
  yesterday's spellings does not make the next spelling detectable
- Failure scenario: The review's probe evaluates the spec's own shape table on seven natural
  restatements and misses six: `/^[A-Z]+-(HIGH|MEDIUM|LOW)-\d{3}$/`,
  `/^([A-Z]+)-([A-Z]+)-(\d{3})$/`, Python `re.compile(r"[A-Z]+-[A-Z]+-\d{3}")`, a template RegExp
  `^${domain}-[A-Z]+-\\d{3}$`, `id.split("-").pop().padStart(3, "0")` and `Number(id.slice(-3))`.
  Only the exact four-severity alternation with a `[A-Z0-9]` classifier is detected. The clerk
  re-ran the probe at 2aae4bede with the same result. A later restatement of any other shape passes
  the invariant, and the next widening finds the sites by hand again.
- Close condition: The detector flags any regex literal or RegExp source that joins a
  classifier-like segment ([A-Z]+, [A-Z0-9]+, a severity word list) to a fixed digit class (\d{n} or
  [0-9]{n}, n >= 3) with a hyphen, and the slice(-3) and padStart(3) forms outside the present
  shapes. The self-test lists the seven lines of the probe and each is detected, the
  NOT_RESTATEMENTS lines (F-NNN, DEBT, the NIT dialect, an unrelated counter) stay clean, and the
  scan of tools/, tests/ and aria-kernel/ is clean or each new hit is decided.

## ARIA-MEDIUM-1002

The reservation ledger is one file shared by every worktree, and code from before REG-ID throws on
any record above 999, so the first ARIA-...-1000 reservation makes `add` fail for every domain in
every worktree not yet on the new code, with no rollout note

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `tools/gates/finding-registry.ts:189` (the ledger path, join(commonDir,
    'finding-id-reservations-v1.json'): one file for every worktree of the clone)
  - `tools/gates/finding-registry.ts:227-262` (loadReservationLedger validates the whole file; the
    check it replaced was `reservation.sequence > 999`)
  - `tools/gates/finding-registry.ts:733` (loadReservationLedger runs on every allocated add; also
    :829 add-explicit and :937 narrative import)
  - `docs/reviews/_registry/README.md:18` (the ledger's only description; it says nothing of the
    sequence width)
- Rule: CLAUDE.md architectural-solution hierarchy tier 4: old code already present in 121 worktrees
  cannot be made to refuse by construction, so a change to a shared persisted format is documented
  where its failure is read
- Failure scenario: Code from before REG-ID validates the whole ledger on every `add`,
  `add-explicit` and narrative import and refuses a record whose sequence is above 999. Once the
  first ARIA-...-1000 reservation is written, every worktree still on that code fails those commands
  for every domain, not only ARIA, with 'Finding ID reservation ledger has an invalid ARIA record'.
  The host has 121 worktrees of this clone. The failure is loud and fail-closed, nothing is recorded
  wrongly, and a worktree is cured by merging the branch that carries finding-id-grammar.ts, which
  until REG-ID lands on main is this branch alone. The review's live dry run allocated ARIA-LOW-1000
  across 121 sibling registries without writing; the reservations that registered this review's
  findings are the first real ones.
- Close condition: A rollout note where an operator looks when `add` fails: the ledger entry of
  `docs/reviews/_registry/README.md` names the width change, the error older code prints and the
  cure (merge the branch or main that carries tools/gates/finding-id-grammar.ts). The landing PR of
  REG-ID repeats it and states that the first four-digit reservation breaks `add` in every worktree
  not yet on that code.

## ARIA-LOW-1003

scripts/ci/check-advisory-ignore-sync.ts spells a finding id with a fixed three-digit width for the
CI and CVE classifiers; it sits outside the invariant's scanned roots and is not among the sites the
closing commit lists as left in place

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens ssot and evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `scripts/ci/check-advisory-ignore-sync.ts:64` (FINDING_ID_RE:
    `(?:CI|CVE)-\d{3}\b|\bRUST-CVE-\d{3}\b`)
  - `tests/invariants/finding-id-grammar.spec.ts:185` (SCANNED_ROOTS is tools, tests and
    aria-kernel; scripts is not scanned)
- Rule: CLAUDE.md one owner per concept and the architectural-solution hierarchy tiers 1 and 3: the
  grammar of a finding id has one owner per language, and a second spelling of it is detected at
  build time
- Failure scenario: The file is TypeScript and could call the owner's parseFindingIdShape, which
  accepts any [A-Z0-9]+ classifier. It keeps its own three-digit spelling for RUST-CVE-NNN style
  ids, outside the invariant's roots and absent from the commit's decision list. It is not reachable
  from the allocator, which issues severity classifiers only, and no RUST-CVE sequence is near 1000,
  so nothing is refused today.
- Close condition: The file takes the id shape from the owner (parseFindingIdShape), or the
  invariant's scanned roots include scripts/ and this site is a decided exception with its reason
  and a table pin.

## ARIA-LOW-1004

Loose finding-id readers remain that accept 0999 and five or more digits, so the kernel and the
tests are not literally one grammar, and the review file says every restatement moved to its owner

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens ssot and evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `aria-kernel/aria_kernel/system_one.py:78` (`_FINDING_ID_RE`, `-[0-9]{1,6}`: accepts 12, 0999
    and six digits; used at :364)
  - `aria-kernel/aria_kernel/system_one.py:80-82` (`_SUBJECT_RE`, the same bound; used at :532)
  - `aria-kernel/aria_kernel/system_one_points.py:57-59` (`_CLOSES` with `\d+` and `_FINDING_ID`
    with `[0-9]{1,6}`)
  - `aria-kernel/aria_kernel/plan_synthesizer.py:659` (`_ORPHAN_HEADING_RE`, `\d+`)
  - `aria-kernel/aria_kernel/closure_reachability.py:44` (`_LEDGER_HEADING`, `\d+`)
  - `tests/invariants/admin-mutation-audit-coverage.spec.ts:75` (`/^[A-Z]+-[A-Z]+-\d+$/`)
  - `tests/invariants/platform-capability-coverage.spec.ts:76` (the same pattern)
  - `tests/invariants/web-design-system-ratchet.spec.ts:392` (the same pattern)
  - `tools/gates/banned-phrase.ts:169` (`#[A-Z]+-[A-Z]+-\d+` and the NIT dialect `\d{2,3}`)
  - `docs/reviews/claude/2026-10-25-aria-reg-id-finding-id-space.md:32` (the Fix paragraph: 'Every
    restatement moved to its owner')
- Rule: CLAUDE.md one owner per concept and the architectural-solution hierarchy tiers 1 and 3: the
  grammar of a finding id has one owner per language, and a second spelling of it is detected at
  build time
- Failure scenario: These readers accept 1000..9999, so no id the registry issues is refused. They
  also accept ids the owner refuses (0999, 12, five and six digits), so the kernel's system_one
  readers, the tests' finding-id checks and the owner disagree on what an id is. The closing commit
  (1406e93ee) declares the ORPHAN readers and the NIT dialect as decided, but does not name
  system_one.py, whose two patterns have a digit bound of their own. The Fix paragraph of the review
  file says every restatement moved to its owner while these remain, which is a wording error and
  not a false close: the Closes: trailer on 1406e93ee matches the finding's own close condition.
- Close condition: Each site either takes the owner's grammar (parse_finding_id, parseFindingIdShape
  or FINDING_ID_SOURCE, system_one.py and system_one_points.py first, since they accept 12, 0999 and
  six digits) or is a decided exception in the invariant's table with its reason (the width-agnostic
  ORPHAN heading readers, the NIT dialect). The Fix paragraph of the review file names the sites
  that stay loose instead of saying every restatement moved.

## ARIA-LOW-1005

The registry severity vocabulary still has spellings next to the new owners: Finding.severity keeps
its own literal union, plan_convergence keeps KNOWN_SEVERITIES, and the validator's usage text
spells the four severities again

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens ssot), registered by the REG-ID findings clerk; non-blocking at
  merge.
- Plan item(s): REG-ID.
- Evidence:
  - `tools/gates/finding-registry-chain.ts:86` (Finding.severity, a literal union)
  - `aria-kernel/aria_kernel/plan_convergence.py:130` (KNOWN_SEVERITIES; the module imports
    parse_finding_id from the owner at line 16)
  - `tools/gates/commit-msg-validator.ts:752` (the usage text
    `{PREFIX}-(CRITICAL|HIGH|MEDIUM|LOW)-NNN`)
  - `tools/gates/finding-registry-store.ts:26` (FindingSeverity, derived from the owner's
    FINDING_SEVERITIES: the form the others do not take)
- Rule: CLAUDE.md one owner per concept and the architectural-solution hierarchy tiers 1 and 3: the
  grammar of a finding id has one owner per language, and a second spelling of it is detected at
  build time
- Failure scenario: The store's FindingSeverity now derives from the TypeScript owner, but the
  Finding interface it describes keeps a union typed by hand, the Python plan convergence keeps a
  set typed by hand next to an import of the Python owner, and the usage text of the gate repeats
  the list and the three-digit placeholder. Adding a severity to the owner leaves these three
  behind.
- Close condition: Finding.severity is FindingSeverity (or the store's type moves to the chain),
  plan_convergence builds KNOWN_SEVERITIES from finding_id_grammar.FINDING_SEVERITIES or uses it
  directly, and the usage text is built from the owner's list. The three spellings are gone.

## ARIA-LOW-1006

Owner surface with no production caller: Python format_finding_id, finding_id_sort_key,
FINDING_SEQUENCE_MAX and FINDING_SEVERITIES, and TypeScript FINDING_ID_REGEX, FINDING_DOMAIN_SOURCE
and FINDING_SEVERITY_SOURCE are used only inside the owners or by tests

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens ssot), registered by the REG-ID findings clerk; non-blocking at
  merge.
- Plan item(s): REG-ID.
- Evidence:
  - `aria-kernel/aria_kernel/finding_id_grammar.py:82` (format_finding_id)
  - `aria-kernel/aria_kernel/finding_id_grammar.py:97` (finding_id_sort_key)
  - `aria-kernel/aria_kernel/finding_id_grammar.py:43` (FINDING_SEQUENCE_MAX)
  - `aria-kernel/aria_kernel/finding_id_grammar.py:36` (FINDING_SEVERITIES)
  - `tools/gates/finding-id-grammar.ts:66` (FINDING_ID_REGEX; callers are the plan-catalog and
    scheduled-jobs specs and the table test)
  - `tools/gates/finding-id-grammar.ts:50` (FINDING_DOMAIN_SOURCE)
  - `tools/gates/finding-id-grammar.ts:59` (FINDING_SEVERITY_SOURCE)
- Rule: CLAUDE.md Behavioral Rules (nothing more than asked) and one owner per concept: an owner
  exports what its readers use, and an export only a test calls is unused surface kept alive by the
  test
- Failure scenario: `git grep` of these names over aria-kernel/aria_kernel and tools/gates finds no
  importer beyond the owner files and tests. The Python formatter and sort key mirror the TypeScript
  ones, but no kernel code formats or orders an id, so the table test is the only thing that
  exercises them and a change in what production needs would not move them.
- Close condition: Each name is either used by a production reader (the kernel readers that order or
  format an id take format_finding_id and finding_id_sort_key) or deleted from the owner with its
  table-test lines.

## ARIA-LOW-1007

eventLogRelativePath derives a finding's domain with `findingId.split('-')[0]` while its reader
eventLogFindingId asks the grammar owner, so the writer-side path function accepts any string

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens ssot), registered by the REG-ID findings clerk; non-blocking at
  merge.
- Plan item(s): REG-ID.
- Evidence:
  - `tools/gates/finding-registry-projection.ts:130-133` (eventLogRelativePath, the writer side:
    `split('-')[0]`)
  - `tools/gates/finding-registry-projection.ts:136-140` (eventLogFindingId, the reader side:
    parseFindingIdShape)
- Rule: CLAUDE.md one owner per concept and the architectural-solution hierarchy tiers 1 and 3: the
  grammar of a finding id has one owner per language, and a second spelling of it is detected at
  build time
- Failure scenario: The reader refuses a path whose id the owner does not parse, and the writer
  builds a path from any string. An earlier event-schema check in the append path keeps a malformed
  id from reaching the writer today, so the pair is consistent only because of that check; a caller
  outside the append path gets a path the reader then refuses.
- Close condition: eventLogRelativePath takes the domain from parseFindingIdShape and throws on a
  string that is not a finding id, so the writer and the reader of the path are one pair of one
  owner. A test hands it a malformed id.

## ARIA-LOW-1008

A degenerate zero-sequence ORPHAN heading (## ORPHAN-LOW-000) now makes every ORPHAN allocation
throw a RangeError, where the base reserved ORPHAN-RESERVED-000

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `tools/gates/finding-registry-store.ts:417-428` (readOrphanMarkdownStore keeps the sequence 0 of
    a 000 heading)
  - `tools/gates/finding-registry-store.ts:438-447` (orphanMarkdownReservedIds, reservedFindingId
    and formatFindingId)
  - `tools/gates/finding-id-grammar.ts:102-118` (isAllocatableSequence refuses 0 and formatFindingId
    throws RangeError)
  - `tools/gates/finding-registry.ts:689-691` (claimedIdsForDomain reads the ORPHAN headings on
    every ORPHAN allocation)
- Rule: CLAUDE.md Architectural Approach: a malformed input is refused where it is read, with a
  message that names it, not by an unrelated range check deep in a later step
- Failure scenario: With `## ORPHAN-LOW-000` in the markdown, readOrphanMarkdownStore returns the
  sequences [0, 31] and orphanMarkdownReservedIds throws 'RangeError: Finding sequence must be an
  integer between 001 and 9999: 0', reached through claimedIdsForDomain('ORPHAN') on every ORPHAN
  allocation. The base returned ORPHAN-RESERVED-000. No such heading exists today (grep of
  docs/reviews/orphan-findings.md is clean), so the allocator is not broken now.
- Close condition: readOrphanMarkdownStore refuses, or reports by name, a heading whose sequence the
  owner does not allocate, so the error names the heading and not a range check in formatFindingId.
  A test with a `## ORPHAN-LOW-000` file.

## ARIA-LOW-1009

The grammar-owner call in `plan_convergence._valid_evidence_ref` decides nothing: `_valid_repo_path`
accepts any string that is not absolute or `..`-escaping, so every id parse_finding_id accepts is
already a valid repo path

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the REG-ID review (lens evidence), registered by the REG-ID findings clerk;
  non-blocking at merge.
- Plan item(s): REG-ID.
- Evidence:
  - `aria-kernel/aria_kernel/plan_convergence.py:4109-4113` (`_valid_repo_path`)
  - `aria-kernel/aria_kernel/plan_convergence.py:4116-4120` (`_valid_evidence_ref`:
    `parse_finding_id(ref) is not None or _valid_repo_path(ref)`)
- Rule: CLAUDE.md Architectural Approach: if the upstream were correct would this code need to
  exist; a call that cannot change the result is dead code or the check is missing
- Failure scenario: The commit text of 9019036f2 says plan_convergence's own FINDING_ID_RE is
  deleted because it took a multi-segment domain and any number of digits. `ARIA-HIGH-0999` is still
  an accepted evidence reference, now as a repo path, so the owner call neither refuses it nor
  changes any answer. The structure predates REG-ID; the commit's implication that the old
  acceptance was removed is what does not hold.
- Close condition: `_valid_evidence_ref` says what an evidence reference is in a way the id branch
  can change (a ref shaped like a finding id must be a valid id, so `ARIA-HIGH-0999` is refused) or
  the branch is removed and the reader of the function is told a ref is a repo path. A test pins
  `ARIA-HIGH-0999` and `ARIA-HIGH-1000`.
