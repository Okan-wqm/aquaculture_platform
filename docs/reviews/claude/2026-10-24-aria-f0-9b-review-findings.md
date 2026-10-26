# ARIA F0.9b review: non-blocking findings

**Owner agent:** claude · **Cycle:** 2026-10-21-aria-quality-learning-program-v2 · **Branch:**
`feat/aria-f09b-atlas-generator`

The F0.9b package review (lenses ssot and arch, one round, lean process of 2026-10-24) raised
thirteen non-blocking points against the ownership atlas generator and its one-owner invariants. The
findings clerk re-read every cited line at b0665ee73. Two points no longer hold there and are not
registered (below), five overlap and were merged into two findings, and the other six are one
finding each: eight findings in all. None blocks the F0.9b landing.

Companion file: `docs/reviews/claude/2026-10-24-aria-f09b-ownership-atlas.md` registers the two copy
families (ARIA-MEDIUM-903, ARIA-MEDIUM-904) the atlas shows.

## ARIA-MEDIUM-924

`one_owner_offenders` matches a ledger write only when `expected_surface` is a string literal or a
bare name that resolves to a module constant, or when a path literal ends with the family's relpath,
and matches a computer only by the exact name FAMILIES lists. A call it cannot resolve is attributed
to no family instead of being refused, so the invariant fails open. The digest.py pattern it cites
scans the concept's spelling; here the spelling is one name and one literal.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens arch and ssot (three review points merged), registered
  by the findings clerk.
- Plan item(s): F0.9b (one-owner invariants, test-first); CLAUDE.md tier 3 (make it detectable).
- Evidence:
  - `aria-kernel/aria_kernel/source_facts.py:300-311` (`_surface_call` reads expected_surface only
    as a string constant or a bare name; an attribute, a forwarded parameter and `**` are dropped)
  - `aria-kernel/aria_kernel/ownership_atlas.py:111-127` (`_surface` returns None when a name does
    not resolve; `_sites` matches the callee against LEDGER_WRITERS and a path against a literal)
  - `aria-kernel/aria_kernel/ownership_atlas.py:143-154` (one_owner_offenders, the invariant's only
    detector)
  - `aria-kernel/aria_kernel/ledger.py:1650-1675` (the runtime guard refuses a raw append only for
    enterprise_required surfaces, so it does not cover the non-enterprise ledgers)
  - `aria-kernel/aria_kernel/verification_gate.py:118` (generic writer: the surface is a variable
    resolved from the path)
  - `aria-kernel/aria_kernel/agent_genesis.py:65` (generic writer: the surface is a variable
    resolved from the path)
  - `aria-kernel/aria_kernel/genesis_adapter_custody.py:223` (generic writer: the surface is a
    function parameter)
  - `aria-kernel/aria_kernel/enterprise_readiness.py:241` (generic writer: the surface is a function
    parameter)
  - `aria-kernel/aria_kernel/knowledge_graph.py:268` (generic writer: the surface is a function
    parameter; none of these five modules names a single-owner family's surface today)
- Rule: F0.9b: a second writer or computer of a single-owner family is red, by the digest.py
  pattern; an invariant that cannot resolve a write must fail closed, not pass.
- Failure scenario: A package adds
  `ledger.append_declared_jsonl(path, row, expected_surface=surfaces.PLAN_EVENTS)` beside
  plan_convergence, or a `quote_matches` that copies `quote_matches_at` under another name; every
  one-owner test stays green and the atlas still prints the family as single-owner. Probes at
  b0665ee73: a constant read through a module attribute, a relative-import attribute, a helper
  passing the surface on, a positional surface through `**kw`, a renamed computer, a path in a
  variable, an aliased writer import, a reused events_path helper and a local surface variable are
  all MISSED; the literal control is CAUGHT.
- Close condition: A call to a ledger writer in a production module whose surface or path the scan
  cannot resolve is attributed to a family, listed in a named exemption table (the five generic
  writers above), or makes the invariant red; the planted shapes above are red in
  test_atlas_one_owner. Renamed computers are caught by the spelling of the concept's value (the
  digest.py pattern), or the atlas states the shapes it cannot see.
- Note: Merged from three review points (a literal-and-name-based scan, a surface passed as a
  parameter, raw-append evasions); the highest severity of the three is kept. The review also listed
  state_snapshot.py:1754 as a sixth generic writer; it is a verifier (verify_jsonl_chunks), not a
  writer, and is left out. The review's probes are under
  /root/aria-handover/2026-10-21/build/F0.9b/reviewer-r1-arch and reviewer-r1-ssot.

## ARIA-MEDIUM-925

Four places say F0.9b removes `recursive_impact` and `impact.plan_impact`. F0.9b registers the
impact family and leaves the modules in place (ARIA-MEDIUM-903, package SE-4). After F0.9b lands,
the allowance labels name a package that landed without doing the fold, and the allowance entries
that were to be dropped when F0.9b landed stay.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens ssot, registered by the findings clerk.
- Plan item(s): SE-4, F0.9b, service-expertise PLAN section 2 row 'Path to service/project key'
  item 3.
- Evidence:
  - `docs/reviews/_registry/findings.jsonl:3125` (ARIA-MEDIUM-794: recursive_impact tombstone 'in
    F0.9b, which is its fold')
  - `docs/reviews/_registry/findings.jsonl:3126` (ARIA-MEDIUM-791: three path to service
    attributions 'until the F0.9b tombstones')
  - `docs/reviews/_registry/findings.jsonl:3162` (ARIA-MEDIUM-903: the same computers assigned to
    SE-4)
  - `aria-kernel/tests/invariants/test_service_key_single_owner.py:94-99` (docstring: the holdouts
    'go in F0.9b')
  - `aria-kernel/tests/invariants/test_service_key_single_owner.py:121-125` (`_TOMBSTONED_ELSEWHERE`
    labels 'F0.9b, ARIA-MEDIUM-791')
  - `tools/gates/event-consumer-index.ts:1475` (comment: recursive_impact, 'its F0.9b tombstone')
  - `tools/gates/event-consumer-index.spec.ts:1412` (comment: tombstoned 'with the module in F0.9b')
  - `aria-kernel/aria_kernel/ownership_atlas.py:96-98` (impact_analysis: plan_package SE-4, finding
    ARIA-MEDIUM-903)
- Rule: One owner per concept: a tombstone has one package and every label names that package.
- Failure scenario: A reader of the allowance or of ARIA-MEDIUM-791 concludes the tombstone landed
  with F0.9b, or that SE-4 is a duplicate; the two packages each assume the other removes the
  modules, and the three holdout attributions stay live.
- Close condition: One package is named as the owner of the tombstones (SE-4 per ARIA-MEDIUM-903,
  unless F0.9b is extended to do them) and ARIA-MEDIUM-791, ARIA-MEDIUM-794, the docstring and
  labels in test_service_key_single_owner and the two event-consumer-index comments are re-pointed
  to it in one commit.

## ARIA-MEDIUM-926

state_manifest owns which path belongs to which declared surface. FAMILIES carries a second copy of
that mapping as (surface, relpath) pairs, and `_names_path` compares path-literal components to the
relpath. The two already disagree in spelling for plan_convergence_events: the manifest pattern is
`plans/*.jsonl`, the atlas writes `plans/events.jsonl`.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens ssot, registered by the findings clerk.
- Plan item(s): F0.9b (generator reads the one manifest), PLAN-v2 section 2 'one owner per concept'.
- Evidence:
  - `aria-kernel/aria_kernel/ownership_atlas.py:57` (plan_convergence_events -> plans/events.jsonl;
    the same (surface, relpath) pair is restated at lines 59, 61, 75, 83 and 100)
  - `aria-kernel/aria_kernel/ownership_atlas.py:119-133` (`_sites` and `_names_path` match a literal
    path against the relpath)
  - `aria-kernel/aria_kernel/state_manifest.py:815` (plan_convergence_events path_pattern
    '`plans/*.jsonl`')
  - `aria-kernel/aria_kernel/state_manifest.py:1178` (surface_for_path, the manifest's own
    path-to-surface rule)
  - `docs/aria/generated/OWNERSHIP-ATLAS.md:24` (plan_events_ledger row: 'plans/events.jsonl' under
    ledgers written, '`plans/*.jsonl`' under ledgers read)
- Rule: One owner per concept: the path-to-surface mapping has one owner, state_manifest.
- Failure scenario: A surface's path_pattern changes in state_manifest (a rename, a split into
  per-segment files); FAMILIES keeps matching the old relpath, the scan stops seeing writes of the
  ledger, and the atlas keeps printing the old spelling beside the new one.
- Close condition: FAMILIES names a ledger by its surface only, the relpath and the path match come
  from state_manifest (iter_surfaces, surface_for_path), and the regenerated atlas spells each
  surface once.

## ARIA-MEDIUM-927

Hand atlas items 9 and 10 (F0.9, d42f5488b) are copy families. The package scope requires every copy
family to be registered with its plan package. The generated atlas has no row for either. The
implementer left them out deliberately (the commit calls the consensus entry 'one writer, two entry
points' and the TS root list a refuted copy); item 10 is a weaker bar on the same engine, and the
skeptic marked item 9 contested, not refuted.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens ssot, registered by the findings clerk.
- Plan item(s): Item 9: PLAN-v2 B1 (derived authority set, one function). Item 10: no package names
  it; nearest F2.3.
- Evidence:
  - `aria-kernel/aria_kernel/cli.py:6541-6550` (consensus run -> run_consensus with tool_id,
    cycle_id, min_confidence, base_dir only)
  - `aria-kernel/aria_kernel/judgment_bridge.py:611-644` (run_consensus, the wrapper)
  - `aria-kernel/aria_kernel/cycle.py:2123-2141` (the cycle's call adds workspace_root,
    judge_weights, conformal_floor, judge_calibration and calibration_gate)
  - `aria-kernel/aria_kernel/feedback_store.py:1377` (the evidence_not_repo_verified refusal runs
    only when workspace_root is given)
  - `aria-kernel/aria_kernel/implementation_safety.py:91` (`_IMPLEMENTER_READONLY_ANCHORS`, the hand
    anchor list)
  - `aria-kernel/aria_kernel/implementation_safety.py:214-233` (readonly_paths unions the anchors
    with kernel_authority_set)
  - `tools/gates/aria-authority-hash.ts:49` (AUTHORITY_ROOTS; the skeptic: a provenance digest
    input, boundary disputed)
  - `aria-kernel/aria_kernel/self_improvement.py:691` (realized_diff_authority_violations; no
    production caller, only aria-kernel/tests/test_derived_authority_set.py)
  - `/root/aria-handover/2026-10-21/build/F0.9/ATLAS.md:29-31` (items 9 and 10)
- Rule: F0.9b scope: a family with copies is registered with its plan package; one owner per concept
  family (PLAN-v2 section 2, 'consensus engine' and 'derived authority set').
- Failure scenario: An operator runs `aria_kernel consensus run` and mints ai_consensus rows the
  cycle would refuse as evidence_not_repo_verified, with no weights, no conformal floor and no
  calibration gate; the atlas shows no family for consensus minting or for the perimeter, so nothing
  flags either copy.
- Close condition: Each item is either declared in ownership_atlas.FAMILIES with its plan package
  and a finding (item 9 under B1, item 10 under the package that makes the CLI take the cycle's
  inputs or stop writing ai_consensus), or the atlas records, with evidence, why it is not a copy.
- Note: Merged from one review point naming both hand-atlas items; the skeptic's counter-evidence
  for item 9 is in /root/aria-handover/2026-10-21/build/F0.9/contested.json.

## ARIA-LOW-928

ledger.py owns the list of ledger writers. The atlas keeps its own six-name set.
`append_segment_rows` is in ledger.py's `__all__` and is the writer of the segmented ledgers; a
planted call to it is MISSED. Latent: no single-owner family is segmented today.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens ssot, registered by the findings clerk.
- Plan item(s): F0.9b (one-owner invariants).
- Evidence:
  - `aria-kernel/aria_kernel/ownership_atlas.py:35-38` (LEDGER_WRITERS: six names)
  - `aria-kernel/aria_kernel/ledger.py:47` (append_segment_rows in `__all__`)
  - `aria-kernel/aria_kernel/ledger.py:619` (append_segment_rows, the state-transaction method)
  - `aria-kernel/aria_kernel/ledger.py:2855` (append_segment_rows, the module function)
  - `aria-kernel/aria_kernel/ledger.py:2689-2692` (SEGMENTED_LEDGERS: agent_invocation_requests and
    agent_invocation_prompts)
- Rule: One owner per concept: ledger.py owns its writer API; the atlas reads it, it does not
  restate it.
- Failure scenario: memory_procedural (or any single-owner ledger) becomes segmented, a second
  module calls `append_segment_rows(..., expected_surface='memory_procedural')`, and the scan sees
  no write.
- Close condition: The writer names come from ledger.py (one exported tuple the atlas imports) with
  a test that every public ledger writer is in it, and a planted append_segment_rows is red.

## ARIA-LOW-929

Pinning the owners as a test oracle is legitimate; the docstring claim is wrong, and nothing ties
the oracle to FAMILIES. The same shape holds for NAMED_PACKAGES in the atlas test.
`one_owner_offenders` does scan judgment_funnel (owner set, no finding), but
`test_every_planted_shape_is_caught_by_family` iterates `_PLANTED`, which has no entry for it.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens ssot and arch (two review points merged), registered by
  the findings clerk.
- Plan item(s): F0.9b (one-owner invariants).
- Evidence:
  - `aria-kernel/tests/invariants/test_atlas_one_owner.py:12-13` (docstring: the family table is not
    restated)
  - `aria-kernel/tests/invariants/test_atlas_one_owner.py:36-46` (SINGLE_OWNER: no judgment_funnel)
  - `aria-kernel/tests/invariants/test_atlas_one_owner.py:50-70` (`_PLANTED`: no judgment_funnel)
  - `aria-kernel/aria_kernel/ownership_atlas.py:74-75` (judgment_funnel: owner set, no finding, so
    single-owner)
  - `aria-kernel/tests/test_ownership_atlas_ssot.py:55-61` (NAMED_PACKAGES restates the packages)
- Rule: One owner per concept: the family table is the owner; a test oracle that restates it is tied
  to it.
- Failure scenario: A second `route_judgment_sample` or a second writer of
  judgment-funnel/routing.jsonl is planted in review: the scan flags it, but no test proves it; a
  future single-owner family can be left out of the oracle the same way.
- Close condition: The docstring says the tables are a pinned oracle, a test asserts the oracle
  covers every FAMILIES entry that has an owner and no finding, and judgment_funnel has planted
  shapes (a second route_judgment_sample, a second writer of its routing ledger) that are red.
- Note: Merged from two review points about the same two test tables.

## ARIA-LOW-930

Both tests read the whole kernel tree as data (production_sources), which the import graph cannot
show. With changed=aria_kernel/reflection.py, a caller listed in the atlas, the selector returns 138
tests and neither atlas test. The selector has a mechanism for exactly this (SURFACE_CONTRACTS).

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens ssot, registered by the findings clerk.
- Plan item(s): F0.9b (byte-for-byte atlas test).
- Evidence:
  - `scripts/ci/aria-import-graph.py:213` (select) and :84-86 (SURFACE_CONTRACTS, one entry)
  - `docs/aria/generated/OWNERSHIP-ATLAS.md:13` (callers cell lists
    aria_kernel/reflection.py:run_reflection)
  - `aria-kernel/tests/test_ownership_atlas_ssot.py:89`
    (test_committed_atlas_matches_render_byte_for_byte)
- Rule: Make it detectable at the earliest gate: a test that pins a derived file runs when its
  inputs change.
- Failure scenario: A push that edits reflection.run_reflection (or adds a writer in any kernel
  module) passes the pre-push selection and turns red only in the CI shards, a round trip later.
- Close condition: The selector selects the two atlas tests for a change to any production module of
  the kernel or executor (a SURFACE_CONTRACTS-style entry or an equivalent), or the cost of that is
  measured and the decision recorded here.

## ARIA-LOW-931

CLAUDE.md forbids 'deferred' and 'out of scope' without an owner, a deadline and a finding ID. The
commit body names two pieces of F0.9b as not done. Bullet 4 (the plan contract field) is carried by
F3.8 in PLAN-v2; bullet 3 and the atlas side of the provenance layer are carried by no package.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.9b package review, lens arch, registered by the findings clerk.
- Plan item(s): F0.9b (PLAN-v2 bullet 3 and the provenance layer); F4.1/F4.4/F4.5 read the
  provenance graph.
- Evidence:
  - `/root/aria-handover/2026-10-21/PLAN-v2.md:167` (bullet 3: change_intelligence verifies the
    atlas on every merge)
  - `/root/aria-handover/2026-10-21/PLAN-v2.md:169-176` (the provenance layer, the no-orphan-memory
    invariant)
  - `aria-kernel/aria_kernel/cycle.py:1891` (`_phase_change_intelligence`; no reference to the atlas
    anywhere in it)
  - `aria-kernel/aria_kernel/docs_ssot.py:10` (the one production importer of ownership_atlas: the
    regen CLI)
- Rule: CLAUDE.md: 'deferred' and 'out of scope' are forbidden without an owner, a deadline and a
  tracked finding ID.
- Failure scenario: Nothing at merge time compares the committed atlas with the render, and the
  chain finding, plan, change, merge, outcome, lesson cannot be read from code, so the
  no-orphan-memory invariant the plan adds under F4.1/F4.4/F4.5 has no input.
- Close condition: The change_intelligence phase verifies the committed atlas against the render on
  each merge and records the result; the atlas extracts which ledger rows cite which other ledgers'
  ids (finding_id, plan_id, change_id, merge_sha, judgment_group_id); each lands, or is moved to a
  named plan package that this finding then lists.
- Note: The deferral is stated in the body of commit fef3a2b19 under 'Not done here'.

## Points not registered

Dropped because the cited evidence no longer holds at b0665ee73, the head of the branch after the
review round:

- The review point that twin_symbols is a second Python parser beside aria-import-graph and twin
  (`aria_kernel/twin_symbols.py`). Commits b955a9d7e and b0665ee73 deleted that module;
  `aria_kernel.source_facts` now owns the parse and its primitives, aria-import-graph and the atlas
  hold its function objects, and test_ownership_atlas_ssot pins that with assertIs and a check that
  neither consumer binds the ast module. The cited lines no longer exist and the three-input
  disagreement cannot be reproduced. What remains is `twin._static_pilot_callers`, a callers walk
  that predates F0.9b and is not an atlas input; it is an overlap between two of the three existing
  graph engines, not something this package adds, so it is not registered here.
- The review point that production_sources scans non-package scripts through rglob
  (`aria_kernel/ownership_atlas.py`). `production_sources` now iterates `source_facts.iter_modules`,
  the import graph's walk, and the rglob is gone; at b0665ee73 it returns 485 modules and none under
  a `scripts/` or `migrations/` directory.
