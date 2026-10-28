# ARIA D6 review: non-blocking findings (2026-10-25)

The D6 package (the reproduction seat's sandbox diff lifted as a pin, which the kernel proves with
the D5 prover and records for its candidate) was reviewed on branch `feat/aria-d6-seat-pin-proof` at
head `449d49638` under lenses ssot and security. One blocker was fixed in the corrective round
(`d203f34b3`: a seat's pin command had become a plan-declarable recipe rendered in the trusted
plan-contract section, and a refused proof left a recipe and an experiment behind). The eleven
points below did not block the merge. Each one's path and line were re-read at `ac106b734` (the
corrective head plus the merge of origin/main) before registration, the three probes behind the
points were run again (the clerk added a fourth, for the non-UTF-8 path name), and none was dropped:
every evidence line holds. Line numbers differ from the review in validation.py and experiment.py
because the corrective commit added code above them. No two points were near-duplicates, so eleven
points are eleven findings; the three lift-read points (the symlink race, the unbounded read, the
non-UTF-8 path name) share a function but have separate close conditions and tests. The clerk merged
origin/main into the branch before allocating ids, so they continue after main's last row
(ARIA-LOW-961); the registry's allocator started at 963.

## ARIA-HIGH-963

Nothing in production calls lift_sandbox_pin or prove_candidate_pin: D6 delivers the seat-pin proof
as an API only, because the reproduction_test executor wiring and the judgment_funnel claim_type
routing table that the D6 spec scopes are not built and no finding tracks them

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6; WP-J.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:573` (lift_sandbox_pin; no caller outside the tests)
  - `aria-kernel/aria_kernel/experiment.py:492` (prove_candidate_pin; no caller outside the tests)
  - `aria-kernel/tests/test_seat_pin_proof.py:114-117` (the only callers of both functions)
  - `aria-kernel/tests/test_seat_pin_proof.py:216` (a further direct call of prove_candidate_pin in
    a test)
  - `aria-kernel/aria_kernel/judgment_funnel.py:81-91` (`_tier2_roles` still mints the first seat of
    JUDGE_FANOUT; the claim_type table is the thing its docstring says has not landed)
- Rule: Root CLAUDE.md, Architectural Approach: work that does not land is a tracked finding with an
  owner, a deadline and an id, not a sentence in a commit body; the D6 spec's scope items 1
  (executor wiring) and 3 (claim_type routing table) are the package's content.
- Failure scenario: A reproduction_test seat can only cite a recipe the kernel already holds,
  because the contract's reproduction block is exactly {recipe_id, expected}. No code path lifts its
  sandbox diff or has the kernel run it, so the R4 row of a seat-written test can never be backed by
  a kernel run, and the proof API records nothing in any cycle. Commit 449d49638 names three
  decisions the wiring needs: the kernel-assigned recipe id must reach the seat's envelope, the
  seat's response must carry the pin's command, failure signature and expectation_ref, and green_at
  exists only for a change subject (D1 change_review), not for a finding judged at HEAD. It also
  records that the routing table is the first producer of reproduction_test seats, so landing it
  before the wiring would mint seats whose R4 can never validate.
- Verified: At ac106b734: a grep for both names finds callers only at
  aria-kernel/tests/test_seat_pin_proof.py:114, :117 and :216; judgment_funnel.py has no change
  since the D5 merge (d609027d2); commit 449d49638 says 'Not done in this package' and that both are
  reported to the program for a tracked finding.
- Related: ARIA-MEDIUM-965 (the R4 read that the wiring makes reachable); ARIA-HIGH-964 (the lift
  has no caller yet).
- Close condition: The reproduction_test executor lifts the seat's sandbox with
  validation.lift_sandbox_pin and has the kernel call experiment.prove_candidate_pin at SHAs it
  chooses, the three decisions above are made and written into the contract, and judgment_funnel
  carries a claim_type table naming the claim types that need proof and go to the prover. Tests
  through the executor, not the unit API: a seat that answers reproduction{recipe_id} with no kernel
  run is refused (it exists); a seat that left a test in its sandbox gets a kernel observation for
  its candidate_ref; a claim type outside the table is not routed to the prover. If the work is
  re-planned, a new owner and deadline are recorded on this finding first.

## ARIA-HIGH-964

lift_sandbox_pin runs git with configuration that the seat's own tree chooses: a seat can point its
worktree's .git file at a gitdir it wrote, whose config defines a clean filter, so 'git diff' runs
the seat's command inside the kernel, outside any sandbox, before path admission refuses the pin

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens security; registered by the D6 findings clerk; non-blocking
  at merge.
- Plan item(s): D6; ARIA-MEDIUM-938.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:603-606` (the diff and the ls-files listing run in the
    seat's tree through hermetic_git)
  - `aria-kernel/aria_kernel/validation.py:594-598` (the docstring names hermetic git as the
    protection for reading the tree)
  - `aria-kernel/aria_kernel/workspace_view.py:54` (HERMETIC_GIT_CONFIG_ARGS sets only
    core.fsmonitor and core.untrackedCache)
  - `aria-kernel/aria_kernel/workspace_view.py:69-77` (`hermetic_git` strips the `GIT_*` environment
    variables and nothing else)
- Rule: The seat wrote the tree, so the kernel must read it as untrusted (D6 spec: untrusted seat
  output stays inside its boundary); a tool that runs configuration or attributes the tree supplies
  is not a read.
- Failure scenario: A hostile seat rewrites its worktree's .git file to name a gitdir it wrote: a
  copy of the index, objects/info/alternates pointing at the subject repository's objects, and a
  config with a `[filter "x"]` clean command; it adds .gitattributes with `*.py filter=x`.
  lift_sandbox_pin's 'git diff <base_sha>' then runs the clean command in the kernel, with the
  kernel's permissions, before `_admit_pin_path` refuses the path. It needs an actively hostile
  seat, and no production caller exists yet.
- Verified: The reviewer's probe
  /root/aria-handover/2026-10-21/build/D6/review-r1-security/probe_gitfile_filter.py, re-run by the
  clerk at ac106b734, printed: 'lift refused: red_first_pin_path_not_a_test: calc.py ...' and
  'seat-chosen command ran in kernel: True' (a marker file the filter touches exists after the
  refusal).
- Related: ARIA-HIGH-963 (no production caller yet); ARIA-MEDIUM-938 (a seat-authored pin is not
  trusted).
- Close condition: The kernel reads the seat's tree without running configuration or attributes the
  tree chooses: for example git runs against a gitdir the kernel owns with a kernel-written empty
  attributes file, or the changed paths come from the sandbox runner and not from git in the seat's
  checkout. Test: the probe's scenario (the seat rewrites its .git file and adds a clean filter)
  leaves no marker file after lift_sandbox_pin, whether the lift is refused or returns.

## ARIA-MEDIUM-965

candidate_ref is written to the experiment and the observation row but nothing reads it: the R4
reproduction binding still keys only on recipe_ref, so a proof recorded for one candidate backs an
R4 row for another, and the D6 spec's read of the observation bound to candidate_ref does not exist

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/evidence_validator.py:905-933` (`_recorded_reproduction_run_status`
    matches observations on recipe_ref only)
  - `aria-kernel/aria_kernel/evidence_validator.py:1070` (the R4 call site passes the recipe id and
    no candidate)
  - `aria-kernel/aria_kernel/experiment.py:333-355` (register_experiment stores candidate_ref on the
    experiment)
  - `aria-kernel/aria_kernel/experiment.py:563` (prove_candidate_pin writes candidate_ref on the
    observation row)
- Rule: D6 spec scope: evidence_validator reads the observation the kernel recorded for the
  candidate (the observation bound to candidate_ref); a recipe id is a name, not a binding to the
  candidate that was proven.
- Failure scenario: The reviewer's probe proves candidate CAND-A with prove_candidate_pin, then
  validates an R4 row of a request about CAND-B that names CAND-A's recipe id:
  validate_agent_response_evidence returns valid = True. It is not reachable today because nothing
  in production calls prove_candidate_pin; the first wiring makes it reachable.
- Verified: /root/aria-handover/2026-10-21/build/D6/reviewer-r1-ssot/probe_ssot.py, re-run by the
  clerk at ac106b734, printed 'P1 R4 row for CAND-B backed by CAND-A's proof -> valid = True'. A
  grep finds candidate_ref only in experiment.py (the other candidate_refs hits are
  validation_matrix_gate's own list).
- Related: ARIA-HIGH-963 (the wiring that makes this reachable); ARIA-LOW-967 (the same R4 read of a
  recipe's latest observation).
- Close condition: The R4 binding reads the kernel observation for the request's candidate and
  refuses, by a named code, an observation recorded for another candidate. Tests: the probe's P1
  returns valid = False with that code; a proof for CAND-B still validates a CAND-B row.

## ARIA-MEDIUM-966

lift_sandbox_pin builds its own 'git diff --name-status -z --no-renames' argv and its own zip-based
parser, although change_paths.py declares itself the one reader of that argv and parse (which
refuses an unknown status and an odd field count); the owner should gain a working-tree mode instead
of a second copy existing

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6; ARIA-CRITICAL-214.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:604` (the lift's own name-status argv)
  - `aria-kernel/aria_kernel/validation.py:610-611` (the lift's own zip-based parse of the listing)
  - `aria-kernel/aria_kernel/change_paths.py:1-15` (the module states it is the one reader of the
    argv and its parse)
  - `aria-kernel/aria_kernel/change_paths.py:65-70` (name_status_args takes two revisions, not a
    revision and a checkout)
  - `aria-kernel/aria_kernel/change_paths.py:73-91` (parse_name_status_z refuses an unknown status
    and an odd field count)
- Rule: One owner per concept (ARIA-CRITICAL-214): the argv that reads a change's path set and the
  parse of its output live in change_paths.py, and every consumer reads through it.
- Failure scenario: The copy pairs fields[0::2] with fields[1::2], so a malformed record (an odd
  field count) is dropped or mis-paired by zip where parse_name_status_z raises
  change_paths_output_malformed, and the two readers can disagree about the same diff. Read from the
  code; not probed.
- Verified: At ac106b734: the argv is validation.py:604 and the parse is :610-611;
  change_paths.py:37 names the same source string as its own.
- Related: ARIA-HIGH-964 (the same listing is where the seat's git configuration runs).
- Close condition: change_paths gains a working-tree mode (a name-status read of one revision
  against a checkout, with the untracked adds listed through the same module), lift_sandbox_pin
  reads through it, and the argv and the parse exist once. Test: a malformed listing makes
  lift_sandbox_pin raise change_paths_output_malformed, not return a short pin.

## ARIA-LOW-967

prove_candidate_pin registers a recipe that holds the pin's command but not its files, and the pin's
content is stored nowhere, so another experiment registered on that recipe runs the command without
the pin and its matched, failed observation becomes the latest one the R4 binding reads for the
recipe

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/experiment.py:536-540` (the pin's recipe is registered with the command
    and no files)
  - `aria-kernel/aria_kernel/experiment.py:164-211` (`_append_recipe`: a recipe row has no field for
    a pin's content)
  - `aria-kernel/aria_kernel/experiment.py:387` (run_experiment runs a recipe's command at a commit
    and knows no pin)
  - `aria-kernel/aria_kernel/evidence_validator.py:927-933` (the R4 binding reads the latest matched
    observation per recipe_ref)
- Rule: One owner per concept: a pin is its files, command, failure signature and expectation
  together; the recipe is a second, incomplete description of it.
- Failure scenario: An actor registers an experiment on the pin's recipe_ref with the status_equals
  comparator and expected 'failed', and runs it at a commit. run_experiment runs the pin's command
  with no test file present, the run fails, and the observation is recorded matched = True,
  run_status = failed. As the latest matched observation for the recipe it then backs a red R4 row.
  It needs someone to register that experiment; since d203f34b3 the recipe is not in the plan
  contract.
- Verified: /root/aria-handover/2026-10-21/build/D6/reviewer-r1-ssot/probe_ssot.py, re-run at
  ac106b734, printed 'P2 run of pin recipe WITHOUT pin files: matched= True run_status= failed'.
- Related: ARIA-MEDIUM-965 (the R4 read keyed on the recipe).
- Close condition: The pin's content is stored with its proof, and an experiment cannot be
  registered on a seat_pin recipe (register_experiment refuses it by name), or the pin is not a
  recipe at all. Test: the probe's P2 raises instead of recording a matched observation.

## ARIA-LOW-968

register_experiment, and the CLI 'experiment register' that calls it, accepts the
proof_verdict_equals comparator, which run_experiment refuses and only prove_candidate_pin observes,
and prove_candidate_pin registers its own experiment, so the registration path can create an
experiment nothing will ever run

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/experiment.py:81-88` (proof_verdict_equals is a member of
    OBSERVATION_COMPARATORS)
  - `aria-kernel/aria_kernel/experiment.py:304-360` (register_experiment validates the contract
    against that tuple)
  - `aria-kernel/aria_kernel/experiment.py:608-612` (the contract check admits every comparator in
    the tuple)
  - `aria-kernel/aria_kernel/experiment.py:415-419` (run_experiment refuses the comparator by name)
  - `aria-kernel/aria_kernel/cli.py:6005-6013` (the CLI register path passes the operator's contract
    JSON through)
- Rule: Make it impossible (root CLAUDE.md, tier 1): the vocabulary the registration accepts is the
  vocabulary the runner can run; a comparator observed by one function is registered by that
  function alone.
- Failure scenario: An operator or an agent runs 'experiment register' with a proof_verdict_equals
  contract: the row is accepted, and 'experiment run' then refuses it with
  experiment_pin_proof_not_a_single_run, so the registered experiment can never produce an
  observation. The refusal comes at run time, not at the registration that created the dead row.
- Verified: /root/aria-handover/2026-10-21/build/D6/reviewer-r1-ssot/probe_ssot.py, re-run at
  ac106b734, printed 'P3 registered proof_verdict_equals experiment; run refuses:
  experiment_pin_proof_not_a_single_run'.
- Related: ARIA-LOW-967 (the other way an experiment on a pin recipe goes wrong).
- Close condition: register_experiment refuses proof_verdict_equals by name (prove_candidate_pin
  registers through a private path, as it does for its recipe), or run_experiment owns the
  comparator. Tests: registering a proof_verdict_equals contract raises a named refusal;
  prove_candidate_pin still records its observation.

## ARIA-LOW-969

Already on main: `implementation_delivery._gate_validation_results` reads the whole validation log,
runner header included, as the run's output through the private `_validation_log_path`, where the
prover and the experiment bench now read through the one reader verified_validation_run_output

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6; ARIA-MEDIUM-936.
- Evidence:
  - `aria-kernel/aria_kernel/implementation_delivery.py:475` (imports the private
    `_validation_log_path` across the module boundary)
  - `aria-kernel/aria_kernel/implementation_delivery.py:486-489` (reads the whole log file as the
    run's output)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:133` (validation_run_log_output: the output
    section of a log)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:634-653` (verified_validation_run_output: the
    one reader of what a run printed)
- Rule: One owner per concept (ARIA-MEDIUM-936): what a run printed is read through
  verified_validation_run_output; the log header is runner text, not output.
- Failure scenario: The gate's validation result carries the runner's header (the command and its
  argv) as the start of its 'output_head_tail', so the head-and-tail truncation spends its budget on
  text the caller chose and a reader of the record sees header text as output. The reading predates
  D6 on main; the single reader is new in D6, so this is a second reader left in place. Read from
  the code; not probed.
- Verified: At ac106b734 and on origin/main (f94f4e4d2): implementation_delivery.py:475 and :487 are
  identical on main.
- Related: ARIA-MEDIUM-936 (the one-reader decision this finding completes).
- Close condition: `_gate_validation_results` reads each run through verified_validation_run_output
  and imports no private name of validation_runs_ledger. Test: a run whose header contains text the
  command never printed does not appear in the gate result's output.

## ARIA-LOW-970

In a repository that does not ignore `__pycache__`, a seat that ran its red test leaves .pyc files
as untracked files and lift_sandbox_pin refuses the whole pin by name; it fails closed, and
aqua-saas ignores `__pycache__`, so only other repositories the bench is pointed at are affected

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens ssot; registered by the D6 findings clerk; non-blocking at
  merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:605` (ls-files --others --exclude-standard: only the
    repository's own ignore rules hide the seat's run by-products)
  - `aria-kernel/aria_kernel/validation.py:613-616` (every listed path goes through the pin's path
    admission, and one non-test path refuses the whole pin)
  - `.gitignore:82` (aqua-saas ignores `__pycache__/`)
- Rule: D6 design: the seat writes and runs its red test in its sandbox and the kernel lifts it; the
  lift must take the seat's tests, not refuse the by-products of the run the design asks for.
- Failure scenario: The seat runs python3 -m unittest in its sandbox of a repository with no
  `__pycache__` ignore rule. Python writes `__pycache__/calc.cpython-312.pyc` as an untracked file,
  and the lift raises red_first_pin_path_not_a_test for it, so no pin results although the seat's
  test is valid.
- Verified: /root/aria-handover/2026-10-21/build/D6/reviewer-r1-ssot/probe_lift_after_run.py, re-run
  by the clerk at ac106b734 with bytecode writing on, printed 'lift refused:
  red_first_pin_path_not_a_test' naming `__pycache__/calc.cpython-312.pyc`; with
  PYTHONDONTWRITEBYTECODE set it lifts the test.
- Related: None.
- Close condition: One decision, recorded and tested: the seat's sandbox runs with bytecode writing
  off, or the lift's untracked listing excludes what the validation runner's own tools write, or the
  refusal stands and the repositories the bench may point at are limited to ones that ignore it.
  Test: a seat that ran its test in a repository with no ignore rule still has its test lifted, or
  the chosen refusal is named.

## ARIA-LOW-971

lift_sandbox_pin's symlink refusal walks the path components and the final open uses O_NOFOLLOW,
which covers the last component only, so a seat process that is still running can swap an
intermediate directory for a symlink between the check and the open and make the kernel read a file
it chose

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens security; registered by the D6 findings clerk; non-blocking
  at merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:619-620` (the component check, then os.open with
    O_NOFOLLOW as a separate step)
  - `aria-kernel/aria_kernel/validation.py:661-672` (`_refuse_pin_path_through_symlink` walks the
    components with is_symlink)
- Rule: Check and use are one operation: a path from an untrusted tree is opened with every
  component refused as a symlink in the same call, not checked and then opened.
- Failure scenario: The seat's process is alive when the kernel lifts (nothing in lift_sandbox_pin
  stops it). After the check passes for tests/test_x.py it replaces tests/ with a symlink to a
  directory it chose; os.open on tests/test_x.py follows the intermediate symlink, and the kernel
  reads a UTF-8 file of the seat's choosing with the kernel's permissions. The text lands in the pin
  and then in the validation worktree and its run log. Active, and it needs a racing process. Read
  from the code; not probed.
- Verified: At ac106b734: the check (:619) and the open (:620) are separate calls.
- Related: ARIA-HIGH-964 and the other lift reads of the seat's tree.
- Close condition: Each lifted file is opened with no symlink in any component in one call (openat2
  with RESOLVE_NO_SYMLINKS, or a directory descriptor walked component by component with
  O_NOFOLLOW), or the files are read from a copy the kernel took of the tree after the seat's
  process stopped. Test: a parent directory swapped for a symlink between the check and the open is
  refused by the same named error.

## ARIA-LOW-972

lift_sandbox_pin reads each lifted file with an unbounded handle.read() and the pin admission bounds
the number of files but not their size, so a multi-gigabyte test file the seat writes is loaded into
kernel memory

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens security; registered by the D6 findings clerk; non-blocking
  at merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:621-622` (os.fdopen and an unbounded handle.read())
  - `aria-kernel/aria_kernel/validation.py:450` (`_PIN_FILE_LIMIT` = 16 bounds a count only)
  - `aria-kernel/aria_kernel/validation.py:553-562` (`_admit_pin` checks the files dict for count
    and type, not for size)
- Rule: Untrusted input is bounded where it is read (root CLAUDE.md, Security: input validation):
  what a seat can make the kernel hold has a limit.
- Failure scenario: A seat writes tests/test_big.py of several gigabytes. The kernel reads it whole
  into a bytes object and decodes a second copy before any bound applies, so the kernel process
  exhausts memory or stalls for the cycle. It needs a hostile or runaway seat. Read from the code;
  not probed.
- Verified: At ac106b734: no size check exists between :553 and :622.
- Related: ARIA-LOW-971 and ARIA-LOW-973 (the other lift reads of the seat's tree).
- Close condition: A named byte limit per file and for the pin as a whole, applied by `_admit_pin`
  (so the prover refuses an oversized pin too) and enforced in the lift by reading at most the limit
  plus one byte. Test: a lifted file one byte over the limit is refused by name without the rest
  being read.

## ARIA-LOW-973

The -z git listings in lift_sandbox_pin are decoded with the locale codec (text=True in
hermetic_git), so a non-UTF-8 path name the seat creates raises a raw UnicodeDecodeError out of the
lift instead of a named GovernanceError refusal

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6 review round 1, lens security; registered by the D6 findings clerk; non-blocking
  at merge.
- Plan item(s): D6.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:603-606` (the listings run through hermetic_git with its
    default text decoding)
  - `aria-kernel/aria_kernel/validation.py:610-611` (the decoded stdout is split on NUL)
  - `aria-kernel/aria_kernel/workspace_view.py:69-77` (hermetic_git: text=True by default, strict
    decoding)
- Rule: A seat's untrusted output is refused by a named error, never by a crash: every refusal of
  the lift is a GovernanceError that names its reason.
- Failure scenario: A seat creates `tests/test_\xff.py` (a file name that is not UTF-8). The
  listing's decode raises UnicodeDecodeError out of lift_sandbox_pin; a caller that handles the
  refusal contract (GovernanceError) does not catch it, so the seat's file name aborts the caller
  instead of being refused.
- Verified: /root/aria-handover/2026-10-21/build/D6/findings-clerk/probe_nonutf8_path.py, run by the
  clerk at ac106b734, printed 'raised builtins.UnicodeDecodeError utf-8 codec can't decode byte 0xff
  in position 11: invalid start byte'.
- Related: ARIA-LOW-971 and ARIA-LOW-972 (the other lift reads of the seat's tree).
- Close condition: The listings are read as bytes (hermetic_git with text=False) and a path that is
  not valid UTF-8 is refused by name. Test: a seat file named with the byte 0xff makes the lift
  raise GovernanceError.
