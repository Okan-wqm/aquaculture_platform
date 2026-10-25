# ARIA OWN-874 review: non-blocking findings (2026-10-25)

The OWN-874 package (ADR-050 and the agent prose, the Tier-1 gate and the invariants that follow it,
recording the operator's ratification of the routing-table owner changes) was reviewed on branch
`chore/aria-routing-ownership-ratified` at head `4a609a355` under lenses ssot and arch. Neither lens
found a blocker. Round 1 left twelve non-blocking review points. Each one's path and line were
re-read at the head before registration, and none was dropped: every evidence line holds.
Near-duplicates are merged, so the twelve points become ten tracked findings: the two points about
the hard-coded ADR-050 filename and the second store of the owner are one finding, and the two
points about the writer-primary prose rule are one finding. Line numbers differ from the review in
two places: ADR-050 decision 3 is on lines 56-58 and its Consequences bullet on lines 74-76, where
the review cited 57-59 and 73-76. One review point cited log files outside the repository, so its
evidence cites the test file instead. The clerk re-ran the one failing module test at the head and
it failed again.

## ARIA-MEDIUM-952

ADR-050's 'Ratified rows' table is read by a spec that hard-codes the ADR-050 filename and a count
of eight globs, so the ADR is a second store of the per-glob primary owner and a superseding
ownership ADR has no written path: it lands only by editing the accepted ADR-050 or the spec

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens ssot (MEDIUM) and lens arch (LOW, the same hard-coded
  filename); registered by the OWN-874 findings clerk; non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `tests/invariants/agent-ownership-uniqueness.spec.ts:311-318` (a later change of owner has to
    supersede the ADR; the expected owners live only there)
  - `tests/invariants/agent-ownership-uniqueness.spec.ts:321-326` (`RATIFIED_ROWS_ADR` is the
    ADR-050 filename)
  - `tests/invariants/agent-ownership-uniqueness.spec.ts:365-367` (the ratified glob count is pinned
    to 8)
  - `docs/adr/050-routing-table-ownership-of-agent-knowledge-skill-research-paths.md:34-44` (the
    Ratified rows table)
  - `docs/adr/050-routing-table-ownership-of-agent-knowledge-skill-research-paths.md:64`
    (Enforcement row: a later primary change has to supersede this ADR)
- Rule: One owner per concept (ADR-050 decision 1): the routing table is the one owner of who
  reviews a path; a ratification record is history the table is checked against, and the way a later
  record replaces it is written down and tested.
- Failure scenario: A later ownership ADR (call it ADR-051) changes the primary of one ratified
  glob. The spec still reads ADR-050 and expects exactly eight globs, so the check 'the routing
  table names the ratified primary for every ratified glob' fails after the table edit until someone
  edits the accepted ADR-050 table or the spec. A superseding ADR cannot pass the gate without
  rewriting the record it supersedes.
- Verified: Re-read at 4a609a355: the spec's header comment (:311-318) states the supersede rule;
  `RATIFIED_ROWS_ADR` joins the ADR-050 filename (:321-326); the size check is :365-367. The two
  review points (the second store and the unwritten supersede path) are one finding.
- Related: ARIA-MEDIUM-954 (decision 3 of the same ADR has no gate either).
- Close condition: The invariant finds the current ratification record without a hard-coded filename
  and row count (for example the Accepted ADR that no later ADR supersedes, by a Supersedes header),
  and ADR-050 says what a later owner change edits: a new ADR with a Supersedes line, then the
  table. A test where a superseding ADR changes one row and the spec stays green, and a test where a
  table change with no ratifying ADR fails.

## ARIA-MEDIUM-953

supply-chain-auditor.md claims primary on package.json, package-lock.json, Cargo.toml and Cargo.lock
while the routing table gives those rows to infra-expert and edge-expert; ADR-050 says the drift is
reported for its own finding and the registry has none, and the ownership invariants pass with the
text in place

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens ssot (MEDIUM); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `.claude/agents/supply-chain-auditor.md:31` (package.json and package-lock.json, primary)
  - `.claude/agents/supply-chain-auditor.md:32` (Cargo.toml and Cargo.lock, primary)
  - `.claude/shared/orchestrator-routing-table.md:65-66` (the table's primaries: infra-expert,
    edge-expert)
  - `docs/adr/050-routing-table-ownership-of-agent-knowledge-skill-research-paths.md:77-80`
    (Consequences: the drift is reported for its own finding)
- Rule: One owner per concept (ADR-050 decision 1): an agent prompt does not restate a different
  primary owner than the routing table.
- Failure scenario: Two prompts tell their readers they are primary on package-lock.json:
  infra-expert (the table's primary) and supply-chain-auditor. The jest invariants of the ownership
  suite passed in the review run at the head with this text in place, because the ratified-rows
  block pins only the eight ratified globs. ADR-050's Consequences promise a finding for this drift;
  a search of findings.jsonl for 'supply-chain-auditor.md' returns no row.
- Verified: Re-read at 4a609a355: both claim lines are untagged 'primary', rows 65 and 66 name
  infra-expert and edge-expert, and the registry holds no row whose text names
  supply-chain-auditor.md. The drift predates the branch.
- Close condition: supply-chain-auditor.md calls itself secondary reviewer (primary: infra-expert,
  edge-expert) on those four paths, as its Dockerfile line already does, or the table is changed and
  recorded in an ownership ADR. The uniqueness invariant compares an agent's untagged primary claim
  with the table for every row, not only the ratified globs, and fails on the current
  supply-chain-auditor.md text.

## ARIA-MEDIUM-954

ADR-050 decision 3 (the arbiter does not ratify a change to a routing row that names it) exists only
as agent prose at Tier 4: no invariant or gate detects an arbiter ruling that ratifies such a diff,
and the ADR says only the operator gate stops it while no such gate exists for Lane-A rulings

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens arch (MEDIUM); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `.claude/agents/architectural-arbiter.md:142` (the 'Your own rows' rule)
  - `docs/adr/050-routing-table-ownership-of-agent-knowledge-skill-research-paths.md:56-58`
    (decision 3)
  - `docs/adr/050-routing-table-ownership-of-agent-knowledge-skill-research-paths.md:74-76`
    (Consequences: only the operator gate stops it from approving its own scope)
- Rule: CLAUDE.md Architectural Approach: prefer the highest tier that applies (make it detectable
  before documenting it); a rule that stops the arbiter ratifying its own scope is enforced by a
  check, not by the arbiter's own prompt.
- Failure scenario: A later diff adds or edits a routing row that names architectural-arbiter as
  primary. The arbiter reviews it, and its prompt permits only a 'proposed' ruling, but nothing
  reads the ruling's status. An APPROVE ruling merges, and the arbiter has ratified its own scope
  with no independent check, the case decision 3 exists to stop. The ADR names an operator gate that
  does not exist for Lane-A rulings.
- Verified: Re-read at 4a609a355: the arbiter prompt rule is on line 142. The ADR lines are 56-58
  (decision 3) and 74-76 (Consequences); the review cited 57-59 and 73-76. A search of tests, tools,
  aria-kernel and the workflows for a check on an arbiter ruling's status over routing rows finds
  only comments that cite past rulings, no check.
- Close condition: A gate that fails when a routing-table diff touching a row whose primary or
  also-notify cell names architectural-arbiter is covered by an arbiter ruling that is not
  'proposed' without an operator-ratifying ADR, with a fixture diff of such a row; or ADR-050 and
  the arbiter prompt say that no gate exists, and a tracked finding names the gate that will.

## ARIA-MEDIUM-955

gdpr-erasure-executor.md:51 still claims 'secondary reviewer' of
libs/event-contracts/src/tenant-events.ts, which contradicts ADR-050 decision 2 (writers stay out of
reviewer sets) and the line above it, which this branch edited to say the agent never reviews; the
primary-claim check cannot see a secondary claim

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens arch (MEDIUM); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `.claude/agents/_maintenance/gdpr-erasure-executor.md:50` (this agent never reviews its own
    handlers)
  - `.claude/agents/_maintenance/gdpr-erasure-executor.md:51` (secondary reviewer of
    tenant-events.ts)
  - `docs/adr/050-routing-table-ownership-of-agent-knowledge-skill-research-paths.md:52-55`
    (decision 2: writers stay out of reviewer sets)
  - `aria-kernel/tests/invariants/test_path_agent_map_single_owner.py:510-521`
    (`writer_primary_claims` matches 'primary' forms only)
- Rule: ADR-050 decision 2: writers stay out of reviewer sets; an agent prompt does not claim a
  reviewer role for an agent the table and the Tier-1 gate keep out of them.
- Failure scenario: gdpr-erasure-executor sits under `_maintenance`/ and writes the TenantErased
  consumer handlers; the table names compliance-expert as their reviewer and data-expert as primary
  of tenant-events.ts. Line 51 still tells the reader the same agent is a secondary reviewer of the
  event contract those handlers consume, so the prompt and ADR-050 disagree, and no check reads
  'secondary reviewer' claims of a writer.
- Verified: Re-read at 4a609a355: line 50 says the agent never reviews, line 51 says secondary
  reviewer. The line predates the branch (origin/main:51); the branch edits line 50 of the same
  file.
- Related: ARIA-LOW-960 (the eight db-audit agents make the same claim).
- Close condition: Line 51 drops the reviewer role (the contract's reviewer is data-expert, named by
  the table), and a prose check fails any agent that is under `_maintenance`/ or holds a
  file-writing tool and claims 'secondary reviewer' in its Primary Ownership section, tested on a
  fixture with the old line. The db-audit lane's agents are a separate finding registered from the
  same review.

## ARIA-LOW-956

Text outside .claude/agents still names prompt-writer as owner or reviewer of rows ADR-050 moved
away from it: add-shared-table.md calls CLAUDE.md a prompt-writer-owned file (row 101's primary is
architectural-arbiter) and product-audit-orchestrator-routing.md asks for a prompt-writer review;
neither new invariant scans .claude/skills or .claude/shared

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens ssot (LOW); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `.claude/skills/add-shared-table.md:88` (CLAUDE.md is a prompt-writer-owned file)
  - `.claude/shared/product-audit-orchestrator-routing.md:12` (a prompt-writer review)
  - `.claude/shared/orchestrator-routing-table.md:101` (CLAUDE.md: architectural-arbiter primary)
- Rule: One owner per concept (ADR-050 decision 1): text outside the table does not restate an owner
  or reviewer the table gives to another agent, and prompt-writer is a writer that never reviews.
- Failure scenario: A reader of the add-shared-table skill is told prompt-writer owns CLAUDE.md and
  is to be notified, while the table and ADR-050 give the review to architectural-arbiter. A reader
  of the product-audit routing note is told a new Lane-B auditor needs a prompt-writer review, a
  review the writer never performs. The new ratified-rows spec reads only .claude/agents prompts and
  the Python prose rule scans only agent prompts, so neither sees these two files.
- Verified: Re-read at 4a609a355: both lines exist as quoted; both predate the branch. prompt-writer
  lives under .claude/agents/\_maintenance/ and holds Edit and Write.
- Related: ARIA-LOW-958 (the same prose rule is too narrow in form).
- Close condition: Both lines name the table's owner or point at the table without restating an
  owner. The writer-never-owns prose check reads .claude/skills and .claude/shared as well, with the
  forms these two lines use (`<writer>-owned`, `a <writer> review`), tested on the old text of both
  lines.

## ARIA-LOW-957

The never-reviewer set (agents under `_maintenance`/ or holding a file-writing tool) has two
definitions: the test helper `_writer_or_maintenance_agents` (recursive, parent-name check, every
agent) and `validate_maintenance_agent_isolation` (a non-recursive `_maintenance` glob, only agents
selected as reviewers); one exported helper should own it

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens ssot (LOW); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `aria-kernel/tests/invariants/test_path_agent_map_single_owner.py:501-507`
    (`_writer_or_maintenance_agents`: rglob, parent name, `FILE_WRITE_TOOLS`)
  - `aria-kernel/aria_kernel/surface_manifest_validator.py:331-355` (`maintenance_dir` glob, then
    write-tool check of selected reviewers)
- Rule: One owner per concept: the definition of 'never a reviewer' is one function that the gate
  and the invariant both call.
- Failure scenario: A maintenance agent placed in a subfolder of `_maintenance`/, or an agent whose
  tools line is parsed differently by the two readers, is a never-reviewer to one definition and an
  ordinary agent to the other, so the test and the Layer 6 gate can disagree on the same agent.
- Verified: Re-read at 4a609a355: the helper uses rglob and `p.parent.name == '_maintenance'` over
  every agent prompt; the validator builds `maintenance_names` from `maintenance_dir.glob('*.md')`
  and checks write tools of selected reviewers only.
- Related: ARIA-LOW-960 (the helper counts those agents as writers).
- Close condition: One helper (exported from `runtime_profiles` or `surface_manifest_validator`)
  returns the never-reviewer set, and the test and `validate_maintenance_agent_isolation` both call
  it. A test that an agent in a `_maintenance`/ subfolder and a Write-tool agent outside it are both
  in the set.

## ARIA-LOW-958

The `writer_primary_claims` prose rule is case-sensitive and matches only `<agent> primary` and
`primary: <agent>`, so a writer's self-claim such as `**PRIMARY**` (the original
gdpr-erasure-executor.md form), `primary is <agent>` or 'Primary' escapes it; no live instance
today, so this is a hardening gap

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens ssot (LOW) and lens arch (LOW, the same pattern);
  registered by the OWN-874 findings clerk; non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `aria-kernel/tests/invariants/test_path_agent_map_single_owner.py:510-521`
    (`writer_primary_claims` and its two-form pattern at :518)
- Rule: CLAUDE.md Architectural Approach tier 3: a check that stops a wrong state matches every
  spelling the claim grammar allows, not the two forms found so far.
- Failure scenario: A writer prompt says '- `apps/x/**` - **PRIMARY**' (the form
  gdpr-erasure-executor.md had on origin/main, line 50) or 'primary is legal-hold-auditor'. The
  pattern needs the agent name next to 'primary' in lower case, so the line passes the new
  invariant. The TypeScript spec catches a self-claim only on the eight ratified globs.
- Verified: Re-read at 4a609a355: the pattern at :518 is case-sensitive with the two alternatives. A
  wider case-insensitive probe over the agent prompts found no live instance (its one hit,
  architectural-arbiter.md:69, is about two agents claiming primary for one file). The two review
  points are one finding.
- Related: ARIA-LOW-956 (the same prose rule does not reach skills and shared text).
- Close condition: The rule matches a claim in every spelling the handoff grammar allows (any case,
  `**PRIMARY**` under a writer's own Primary Ownership bullet, `primary is <agent>`, `<agent> is
primary`), with one fixture line per form, or the grammar is cut to one spelling the rule matches.

## ARIA-LOW-959

aria-suite-changed.mjs reports one of 42 modules failing at the branch head:
`test_validation_matrix_cmd_correlation_end_to_end`, where a real nx jest run on
libs/event-contracts inside a fixture repo returns status 'failed'; it reproduces here but this diff
does not touch its inputs, so it is environmental or already red, and CI must confirm

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens ssot (LOW), seen by the arch lens as well; registered by
  the OWN-874 findings clerk; non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `aria-kernel/tests/test_validation_matrix_cmd_correlation_end_to_end.py:207-211` (the fixture
    symlinks the source `node_modules`)
  - `aria-kernel/tests/test_validation_matrix_cmd_correlation_end_to_end.py:262-273` (the nx command
    runs and the assertion status == 'ok' fails)
- Rule: CLAUDE.md Test Rules: a red test is explained or fixed; a module that fails at the head of a
  package needs a recorded cause, and its failure message keeps the part of the log that names the
  cause.
- Failure scenario: `test_native_allowed_nx_run_satisfies_its_actual_upcaster_requirement` fails
  with 'failed' != 'ok' at the head, and the clerk's re-run of that one test failed the same way
  (host load average about 14). The assertion prints only the last 12000 characters of the run log,
  which are the input-scope file list, so the nx error is cut off. The reviewers' probe that
  restored `_TIER_1_SPECIALISTS` to the origin/main set still failed, and the module reads none of
  the nine changed files.
- Verified: Re-ran the one test at 4a609a355: it failed again with the same assertion. The review's
  log paths are outside the repository, so the evidence cites the test file. Not attributed to this
  diff: both reviewers found no overlap between its inputs and the nine changed files.
- Close condition: The cause of the nx exit 1 in the fixture repo is found and recorded: either the
  CI shard that runs this module is green at the package's merge and the failure is specific to a
  worktree host, or the fixture is fixed (for example the `node_modules` symlink or the nx
  environment it sets). The assertion message keeps the head of the log as well as its tail.

## ARIA-LOW-960

All eight db-audit-\* agents hold Write in their tools, so the never-reviewer rule counts them as
writers, yet each Primary Ownership section claims 'secondary reviewer' on many app and web globs;
the routing table names none of them, so the prose and ADR-050 decision 2 disagree and no gate sees
it

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens arch (LOW); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `.claude/agents/db-audit/db-audit-sensor.md:7` (tools: Read, Grep, Glob, Write)
  - `.claude/agents/db-audit/db-audit-sensor.md:39-44` (Primary Ownership: secondary reviewer on app
    and web globs)
  - `.claude/agents/db-audit/db-audit-identity-billing.md:7` (tools: Read, Grep, Glob, Write)
  - `.claude/agents/db-audit/db-audit-identity-billing.md:38-45` (Primary Ownership: secondary
    reviewer on app and web globs)
  - `aria-kernel/tests/invariants/test_path_agent_map_single_owner.py:501-507` (a file-writing tool
    makes an agent a writer)
- Rule: ADR-050 decision 2: writers stay out of reviewer sets; an agent is either a reviewer without
  a file-writing tool or a writer that claims no reviewer role.
- Failure scenario: The helper counts the eight Lane-D agents as writers, and their prompts say each
  is a 'secondary reviewer' of sensor-service, auth-service, billing-service and the web modules.
  Either the tools line or the prose is wrong, and the table does not name them, so nothing reports
  the disagreement. The same eight prompts carry the same claims, with 3 to 5 'secondary reviewer'
  lines each.
- Verified: Re-read at 4a609a355: all eight db-audit agents list Write on line 7, and every one
  carries 'secondary reviewer' claims in its Primary Ownership section. The state predates the
  branch.
- Related: ARIA-MEDIUM-955 (gdpr-erasure-executor.md makes the same claim).
- Close condition: A recorded decision for the Lane-D audit agents: they drop the Write tool and
  stay audit-pass reviewers (the caller writes the report), or they stay writers and their Primary
  Ownership sections say 'audit pass' instead of 'secondary reviewer'. A prose check that no writer
  agent claims 'secondary reviewer' passes on all eight files.

## ARIA-LOW-961

The routing parser fixture in `test_agent_routing`.py still models apps/\*/src/gdpr/\*\* with
gdpr-erasure-executor as primary and asserts that it reviews a farm-service path; as an example it
contradicts ADR-050 row 102 (compliance-expert primary) and names a writer as a reviewer

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: OWN-874 review round 1, lens arch (LOW); registered by the OWN-874 findings clerk;
  non-blocking at merge.
- Plan item(s): OWN-874; ARIA-HIGH-874; ARIA-LOW-856.
- Evidence:
  - `aria-kernel/tests/test_agent_routing.py:49` (fixture row: apps/\*/src/gdpr/\*\* ->
    gdpr-erasure-executor)
  - `aria-kernel/tests/test_agent_routing.py:194` (asserts gdpr-erasure-executor reviews
    apps/farm-service/src/batch.ts)
- Rule: One owner per concept (ADR-050 decision 1): a test fixture that copies a routing row does
  not give a real agent a role the table has taken away.
- Failure scenario: The fixture is a self-contained table for the parser, so the test is correct as
  a parser test, but a reader or a search for `who owns apps/*/src/gdpr/**` finds a second answer
  (gdpr-erasure-executor) beside the table's compliance-expert, and the fixture keeps a writer in a
  reviewer position.
- Verified: Re-read at 4a609a355: line 49 is the fixture row and line 194 the assertion. Both
  predate the branch.
- Close condition: The fixture names compliance-expert for that row (or an invented agent name), and
  the assertion at :194 follows; `test_agent_routing`.py stays green.
