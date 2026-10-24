# ARIA D5 review: non-blocking findings (2026-10-25)

The D5 package (one red-first prover, validation.prove_red_first, with the failure-reason
classes of validation_runs_ledger) was reviewed on branch `feat/aria-d5-one-prover` under lenses
ssot and security. Two blockers were fixed in the corrective round (5b3b1de6a, 28a34e323). The
points below did not block the merge. Each was re-checked at the branch head (28a34e323) before
registration, and near-duplicates were merged. Two review points were dropped because the
corrective commits fixed them: the run-log layout ('--- stdout ---') was parsed by the prover as
a second spelling of the format `_write_run_log` owns (the ledger now owns the delimiter and one
reader, and the classifier and the signature check both read the output section through it), and
the infra markers matched the log's own command header (they are now error lines anchored at a
line start and the classifier reads only the output section). Two review points about
`_pinned_worktree` (no timeout and a repo-wide prune) are one finding.

## ARIA-MEDIUM-936

Two judges decide whether a run's output contains the expected text and disagree:
experiment.\_compare('log_contains') searches the whole run log, command header included, while
the red-first prover searches only the output section, so one red row is a hit for one and
wrong_reason for the other

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens ssot), registered by the D5 findings clerk; non-blocking at
  merge.
- Plan item(s): D5; D6.
- Evidence:
  - `aria-kernel/aria_kernel/experiment.py:504-508` (\_compare log_contains searches the whole
    log text, header included)
  - `aria-kernel/aria_kernel/validation.py:595-606` (\_proof_verdict searches the failure
    signature in the output section only)
  - `aria-kernel/aria_kernel/validation.py:609-613` (\_run_log_output reads through
    validation_run_log_output)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:133-137` (validation_run_log_output, the
    output-section reader)
- Rule: One owner per concept: the judge of 'a run's output contains the expected text' is one
  function over the run's output section; the log header is runner text, not output.
- Failure scenario: A prover red row's log header holds the pin's command. When the expected
  text appears in that header (the review's probe used the command as the signature, 'python3 -m
  unittest tests.test_probe'), experiment.\_compare('log_contains') answers True while the prover
  finds the text absent from the output and returns wrong_reason. The clerk re-ran the probe at
  28a34e323: red row failure_reason assertion, experiment True, prover signature check False,
  verdict wrong_reason. D6 registers a recipe and an experiment and then calls prove_red_first,
  so the experiment's observation and the proof can disagree on one run.
- Close condition: One owner decides it: experiment.\_compare('log_contains') reads the run
  through validation_run_log_output (or the prover calls the experiment's comparator), so
  neither searches the header. A test where text present only in the log header is not a hit for
  either judge. The second spelling is deleted in the change that wires D6.

## ARIA-MEDIUM-937

finding.record_finding_reproduction confirms a finding on any failed run and never reads the
run's failure_reason, so an import or collection red still confirms while the red-first prover
counts the same row as wrong_reason: a second red judge with a weaker rule

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens ssot), registered by the D5 findings clerk; non-blocking at
  merge.
- Plan item(s): D5; D6; D7.
- Evidence:
  - `aria-kernel/aria_kernel/finding.py:839-846` (run_status 'failed' alone passes; the module
    never reads failure_reason)
  - `aria-kernel/aria_kernel/validation.py:595-606` (\_proof_verdict: a red of any class but
    assertion is wrong_reason or unrunnable)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:140-156`
    (derive_validation_failure_reason, the one owner of the class)
- Rule: D5 / F3.2 (PLAN-v2 section 3) and one owner per concept: a red for the wrong reason
  counts as unproven, decided once, not by a second judge that ignores the class.
- Failure scenario: A finding whose reproduction run is red because the test module failed to
  import (failure_reason import or collection) is passed to record_finding_reproduction and is
  marked CONFIRMED, the very run the prover refuses to count. Read from the code, not probed.
  The class did not exist before D5, so this is not a regression of this package; the callers
  that adopt the prover are D6 and D7.
- Close condition: record_finding_reproduction (and record_finding_fix_verification, which also
  never reads the class) take their red and green facts from the prover's proven verdict, or
  refuse a red run whose failure_reason is not assertion, as one rule with the prover (D7's
  single bar). A test where a red from an import error does not confirm.

## ARIA-MEDIUM-938

The red-first prover's failure class is read from text the test under proof prints, so a pin
that swallows its own ImportError and prints an AssertionError line is classed assertion and can
be proven; wrong_reason catches honest mistakes and is not an adversarial boundary for
seat-written pins

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens security), registered by the D5 findings clerk; non-blocking at
  merge.
- Plan item(s): D5; D6.
- Evidence:
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:119-130` (\_FAILURE_REASON_MARKERS match
    the lines the test itself prints)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:140-156`
    (derive_validation_failure_reason classes the printed output)
  - `aria-kernel/aria_kernel/validation.py:595-606` (\_proof_verdict: proven needs the assertion
    class and the signature in the printed output)
- Rule: D5 / F3.2 (PLAN-v2 section 3): a red for the wrong reason counts as unproven; a boundary
  must not rest on text the untrusted party prints.
- Failure scenario: A pin catches its own ImportError and prints an AssertionError line that
  carries the signature, then exits 1: the run is classed assertion and carries the signature,
  so the verdict is proven for a red that is really an import failure. The clerk's classifier
  probe at 28a34e323 confirms the class follows the printed line whatever raised it. Pins in
  discovery are written by the kernel's own tooling; D6 runs pins authored by seats and must not
  treat wrong_reason as protection against a hostile one.
- Close condition: Before D6 admits a seat-authored pin: either the failure class comes from a
  runner-written structured result the test body cannot print into, or the D6 contract records
  that the class guards honest mistakes only and a seat pin passes a second check its own output
  cannot forge. A test where a pin that swallows its ImportError and prints an AssertionError
  line is not proven.

## ARIA-LOW-939

validation.\_run_log_output reads the run's log through verified['log_path'] instead of
validation_runs_ledger.\_validation_log_path(row), the path verify_validation_run hashed, so the
two agree only while a prover row carries no log_ref

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens ssot), registered by the D5 findings clerk; non-blocking at
  merge.
- Plan item(s): D5.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:609-613` (\_run_log_output reads the verified row's
    log_path field)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:570-602` (\_validation_log_path, the owner
    of the log's location)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:623-624` (verify_validation_run hashes
    the file \_validation_log_path names)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:396-417` (log_ref is stamped only when an
    input_binding is given)
- Rule: One owner per concept: a verified run's log is read at the path the ledger hashed, never
  re-derived by a caller.
- Failure scenario: A prover row recorded with an input_binding carries a log_ref that
  \_validation_log_path resolves against the tools root, while the row's log_path can name an
  older hot log. The signature check would then read a different file from the one whose hash
  was verified. Today the prover records no input_binding, so both paths are the same string.
- Close condition: validation_runs_ledger exposes one reader of a verified run's log text (it
  hashes and returns the text of the file it hashed, through \_validation_log_path);
  \_run_log_output uses it, and no caller reads row['log_path'] of a verified run. A test where a
  row with a log_ref whose log_path differs reads the resolved, hashed log. The same reader
  serves the experiment comparator named in the finding on the two output judges.

## ARIA-LOW-940

validation.\_pinned_worktree spells git worktree add, remove and prune once more with no timeout
instead of request_worktree.run_worktree_git, and its repo-wide git worktree prune also drops
other sessions' stale worktree registrations in the subject repo

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens ssot and security), registered by the D5 findings clerk;
  non-blocking at merge.
- Plan item(s): D5.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:554-578` (\_pinned_worktree: add, remove and prune
    through subprocess.run, no timeout; prune is repo-wide)
  - `aria-kernel/aria_kernel/request_worktree.py:51-61` (run_worktree_git, the bounded owner)
  - `aria-kernel/aria_kernel/request_worktree.py:64-122` (add_request_worktree and
    remove_request_worktree)
  - `aria-kernel/aria_kernel/merge_lane_workspace.py:231-237` (a pre-existing spelling)
  - `aria-kernel/aria_kernel/self_revert.py:538-542` (a pre-existing spelling)
  - `aria-kernel/aria_kernel/self_revert.py:1112-1165` (a pre-existing spelling)
  - `aria-kernel/aria_kernel/apply_engine.py:96` (a pre-existing spelling)
  - `aria-kernel/aria_kernel/containment_probe.py:245` (a pre-existing spelling)
  - `aria-kernel/aria_kernel/worker_dispatch.py:166` (a pre-existing spelling)
  - `aria-kernel/aria_kernel/worker_dispatch.py:462` (a pre-existing spelling)
- Rule: One owner per concept: bounded worktree calls are request_worktree.run_worktree_git; a
  caller changes only the state it declares, and its own tree is removed by path.
- Failure scenario: A git call that hangs (a held index.lock, a slow filesystem) blocks the
  prover with no bound, where run_worktree_git reports a timeout. The finally block's git
  worktree prune drops every stale registration of the subject repo; in a shared checkout that
  includes other sessions' worktrees whose directories are briefly missing, so the prover writes
  state outside its declared surface. git worktree remove --force on its own tree is enough.
  Both read from the code, not probed.
- Close condition: The prover's add and remove go through run_worktree_git (a timeout is a named
  refusal), remove only its own tree and never run a repo-wide prune. Tests: a stale
  registration of an unrelated worktree survives a prove_red_first call; a worktree call that
  exceeds the bound raises a named GovernanceError. The six pre-existing spellings move to the
  same owner, or each gets its own tracked finding.

## ARIA-LOW-941

validation.PIN_TEST_GLOBS is a further 'is a test file' vocabulary beside four others, and it
admits no Rust test path although cargo test is an admitted prover command

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens ssot), registered by the D5 findings clerk; non-blocking at
  merge.
- Plan item(s): D5.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:445-449` (PIN_TEST_GLOBS)
  - `aria-kernel/aria_kernel/validation.py:94` (ALLOWED_CARGO_SUBCOMMANDS admits cargo test)
  - `aria-kernel/aria_kernel/validation_matrix_gate.py:216-224` (\_REGRESSION_ANCHOR_PATTERNS)
  - `aria-kernel/aria_kernel/twin.py:742-745` (\_is_test_file, with \_TEST_SUFFIXES at :77)
  - `aria-kernel/aria_kernel/twin_test_surface.py:88` (\_TS_SPEC_SUFFIXES)
  - `aria-kernel/aria_kernel/risk_policy.py:45` (L1_FILE_SUFFIXES)
- Rule: One owner per concept: what counts as a test file is spelled once.
- Failure scenario: A Rust fix whose red test is an integration test under a crate's tests/
  directory cannot be pinned (red_first_pin_path_not_a_test) although cargo test is admitted. A
  change to what counts as a test lands in one of the five lists and not the others, so the
  prover and the matrix gate disagree on the same path.
- Close condition: One table of test-file path classes from which PIN_TEST_GLOBS and the other
  vocabularies derive; each consumer names the subset it admits (the pin admits test files only,
  never harness or configuration files such as conftest.py). The Rust decision is recorded: a
  tests/\*.rs glob is admitted, or cargo leaves the prover's admitted commands. A test that the
  consumers agree on a fixture list of paths.

## ARIA-LOW-942

A red from an uncaught non-assertion exception in the code under test (a unittest ERROR: such as
a KeyError) gets failure_reason None, so the prover returns wrong_reason for crash-shaped
defects; a design choice that can lower the D5 self-check and is not recorded

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D5 review (lens ssot), registered by the D5 findings clerk; non-blocking at
  merge.
- Plan item(s): D5.
- Evidence:
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:119-130` (no marker class for an
    exception raised inside the code under test)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:140-156` (None when no class is
    recognised)
  - `aria-kernel/aria_kernel/validation.py:595-606` (\_proof_verdict: a failure_reason other than
    assertion is wrong_reason)
- Rule: D5 self-check (DESIGN-discovery row D5): a choice that lowers the proven rate of the
  miner-verified DEV fix tests (target 95 percent) is recorded and measured, not implicit.
- Failure scenario: A pin that fails at the base with an uncaught KeyError or TypeError from the
  code under test (unittest prints 'ERROR: test_x' and 'KeyError: ...', no AssertionError line)
  gets failure_reason None; the clerk's probe at 28a34e323 returned None. The prover then
  answers wrong_reason and never proven. Crash-shaped regressions are a common defect class, so
  the share of DEV bug cases whose own fix test classifies proven can fall under the bar for a
  reason the design intended ('no class recognised is never guessed') but never recorded.
- Close condition: A recorded decision: either a red from an exception raised inside the code
  under test (as opposed to a test module that fails to load) is a red for the right reason,
  with the signature check as its guard, or the D5 DEV self-check reports wrong_reason counts by
  class so the loss is measured. A fixture where a KeyError in the code under test gives the
  chosen verdict.
