# aria-suite-changed gate — merge-from-main scope (2026-09-20)

**Reviewer:** infra-expert · **Cycle:** 2026-09-20-pr1629-merge-from-main ·
**Surface:** `scripts/ci/aria-suite-changed.mjs`, `.husky/pre-push`

## Context

PR #1629 (`claude/wonderful-archimedes-msrlg9`) merged `origin/main` to resolve a conflict in the
finding registry. The branch's own content diff against main touches **no ARIA surface at all**:

    $ git diff --name-only origin/main...HEAD -- aria-kernel tools/aria-poc \
        tools/aria-adapters .github/workflows .github/actions \
        scripts/ci/aria-suite-changed.mjs scripts/ci/aria-suite-run.sh package.json
    (empty)
    $ git merge-base --is-ancestor origin/main HEAD && echo ancestor
    ancestor

The gate nevertheless selected 431 of the ~440 kernel test modules:

    aria-suite-changed: 47 ARIA-surface file(s) changed since
      origin/claude/wonderful-archimedes-msrlg9; running 431 affected test module(s)

Those 47 files are main's, brought in by the merge commit. `origin/main` is an ancestor of HEAD, so
every one of them is already on main and already verified by main's own aria-kernel lane. The push
ran 4 959 unittest tests in 3 716 s (62 min) plus 88 native-pytest tests, and passed — proving the
selection was not just expensive but redundant.

## Findings

### PROC-MEDIUM-033 — the pre-push ARIA gate re-verifies what the base branch already verified

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

`baseRef()` prefers `origin/<branch>` — the honest "already verified" point for the branch's own
history. After `git merge origin/main`, however, every ARIA file main has touched since the last
push falls inside `origin/<branch>...HEAD` and reads as new. The gate then selects effectively the
whole kernel suite for a branch that authored none of it.

This is the same failure class the sibling clippy gate already rejects in its own docblock —
"`origin/main...HEAD` would catch ALL that accumulated debt every push" (ORPHAN-LOW-035) — and that
`PROC-MEDIUM-027` fixed for `clippy-affected` on 2026-09-05, by intersecting the branch-side set
with the integration base. `aria-suite-changed.mjs` was added afterwards and reintroduced the
defect through the base branch instead of through the branch's own history. Two gates in one hook,
one already immunised, the other not: the lesson had not been made structural.

**Why MEDIUM and not HIGH:** unlike `PROC-MEDIUM-027`, this one does not make the push impossible.
It was pushed, honestly, with every gate run to completion and none bypassed. The cost is time —
but the time is not bounded by the branch: `main` advanced twice (`2ee11ed62` → `0239eecc8` →
`25070186c`) during the 62-minute run, so each merge-to-resolve begets another 62-minute gate
against a base that has moved again. Against a fast-moving main that is a livelock, which is why
it is not LOW.

**Fix (this cycle):** a file counts as unverified only when it differs from BOTH the remote branch
tip AND `origin/main`. `surfacesChangedSince(ref)` is called for each and the two sets intersected.
The three-dot form measures from the merge-base, so the exclusion holds whether the branch merged
main's tip or an older main; when the base IS `origin/main` (a branch's first push) the second
lookup is skipped and the behaviour is unchanged. The gate logs how many files it excluded and
why.

Coverage is not reduced. A file the branch actually authors differs from main too, so it stays in
the intersection and still selects its tests. Verified on this branch after the fix:

    aria-suite-changed: 2 ARIA-surface file(s) reached this branch by merging origin/main;
      already verified there, not selected here.
    aria-suite-changed: no ARIA surface touched since origin/claude/...; suite skipped.

`ARIA_SURFACES` contains `aria-suite-changed.mjs` itself, so this change correctly triggers the
gate's own self-validation clause and runs the FULL suite on the push that lands it. That is the
design working, not an obstacle.

**Not changed:** the affected-test mapping, the safety floor that falls back to the full suite on a
mapping hole, `ARIA_SUITE_FULL=1`, and the gate self-validation clause. `tests/invariants/
aria-doc-runtime-ssot.spec.ts` and `tests/invariants/git-hook-binding.spec.ts` (32 assertions)
pass unchanged.

### PROC-MEDIUM-034 — the gate cannot reach any test under `aria-kernel/tests/invariants/**`

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

Found by watching my own push land. The push edited
`aria-kernel/tests/invariants/v13/test_phase_v13_e_grant_vault_campaign.py` — adding the
regression test for ARIA-HIGH-181 — and the gate selected 15 modules, none of them that one:

    aria-suite-changed: 3 ARIA-surface file(s) changed since origin/claude/...;
      running 15 affected test module(s): test_adapter_fixture_evidence_contract.py, ...

Two independent causes, both in the gate's own files:

1. **Selection.** `selectAffectedTests` builds its candidate set with
   `readdirSync('aria-kernel/tests')`, which is not recursive — 550 top-level modules, no nested
   ones. A changed file under `aria-kernel/tests/` takes the first branch, computes
   `name = 'invariants/v13/test_phase_v13_e_grant_vault_campaign.py'`, finds `testTexts.has(name)`
   false, and `continue`s having selected nothing for itself.
2. **Execution.** `aria-suite-run.sh` maps each argument with
   `modules+=("tests.$(basename "${path%.py}")")`. Even if selection were fixed, a nested module
   would resolve to `tests.test_phase_v13_e_grant_vault_campaign` — a module that does not exist —
   rather than `tests.invariants.v13.test_phase_v13_e_grant_vault_campaign`.

The safety floor (`kernelCodeChanged && selected.size === 0 → full suite`) did not fire because
`grant.py` set `kernelCodeChanged` while the token rule had already selected 15 modules for it. The
floor guards a mapping that returns _nothing_; it cannot see a mapping that returns _the wrong
things_. The gate's own docblock states the standard it misses here: selection is "deliberately
over-inclusive, never under-inclusive ... a missed importer costs a red main". A test file the push
itself edited is the least excusable module to skip.

**Why MEDIUM:** CI's `aria-kernel` lane runs `aria-suite-run.sh` with no arguments, which is
`unittest discover aria-kernel -p '*test*.py'` — recursive, so nested invariants are covered
there. The hole is pre-push-only and CI is the backstop. It is not LOW because the pre-push gate
exists precisely so that a red main is not the first reader, and this is the class of change
(editing a test) where a developer most reasonably assumes the gate ran it.

**Also recorded here:** the gate self-validation clause is conditioned on `selected.size === 0`, so
bundling any kernel-code change with a change to the gate skips the full-suite self-validation the
clause exists to guarantee. That is what happened on this push. It cost nothing in fact — the gate
code that landed was full-suite validated in the previous push (6 842 tests) and was not touched
afterwards — but a reader should not have to reconstruct that from two run logs to know the gate
was verified.

**Not fixed in this cycle,** deliberately. Both causes are one-line-ish changes in files this PR
already touches, and I could land them. I am not doing so because this PR is a design-system
change that has already absorbed two ARIA-infrastructure detours (PROC-MEDIUM-033, ARIA-HIGH-181),
each of which was blocking; this one is not blocking and CI covers the gap. It gets an owner, a
deadline and this ID instead of a third unrelated commit.

### ARIA-HIGH-181 — the signing-backend probe propagates instead of answering

> Raised as ARIA-HIGH-180 and re-allocated. `main` had allocated a different
> ARIA-HIGH-180 in parallel (the Z.ai/Codex `convergence_id` finding), and the
> merge that took main's chain and re-appended this branch's rows dropped this
> one silently, because the row it would have re-appended carried an id main had
> already used. The finding itself never changed; only its number did. The
> collision is itself tracked — see the note at the end of this section.

**Severity:** HIGH · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

The full-suite push (#5) was refused by two import errors, and the reason they were import errors
rather than skips is a contract defect in ARIA's only cryptographic path:

    File ".../aria_kernel/security/grant.py", line 55, in backend_available
        _backend()
    ...
    pyo3_runtime.PanicException: Python API call failed

`grant.py`'s module docstring promises that "if the signing backend is missing the lane fails
closed instead of degrading to an unsigned grant", and `backend_available() -> bool` is the
predicate that delivers it. `_backend()` caught only `ImportError`. A native binding built for
another interpreter does not raise `ImportError` — it panics, and pyo3's `PanicException` derives
from `BaseException`, so it escaped `_backend()`'s handler and `backend_available()`'s
`except SigningBackendUnavailable` alike. An **installed but broken** backend is exactly as
unavailable as a missing one, and the probe answered neither way: it propagated.

The cost is precise. Both v13 modules guard themselves for this case in so many words —

    @unittest.skipUnless(G.backend_available(), "cryptography (Ed25519) not installed — grant lane is fail-closed here")

— and the guard written for this exact case could not run, because evaluating it is what raised.
`test_phase_v13_e` died on the same call at module scope (`HAVE_CRYPTO = G.backend_available()`).
Two modules that would have SKIPPED instead failed to import, and the push was refused.

**Why HIGH:** it is the only signature path ARIA has, and it defeats that module's own documented
fail-closed contract. To be accurate about the blast radius: it does **not** produce an unsigned
grant — issuing and verifying still raise `SigningBackendUnavailable`. The harm is that a
_predicate_ can kill its caller, so every guard built on it is unreliable exactly when the backend
is in the degraded state the guard exists for.

**Fix (this cycle):** `_backend()` re-raises `SigningBackendUnavailable` for any import-time
failure, not just `ImportError`, while `KeyboardInterrupt` and `SystemExit` are re-raised
untouched — an operator interrupt is the process ending, not the lane degrading.
`SigningBackendProbeIsTotal` in `test_phase_v13_e_grant_vault_campaign.py` pins all three
branches and is deliberately **not** gated on `HAVE_CRYPTO`, since the property under test is what
the probe does when the backend is unusable. Verified by reverting the fix: the panic case errors
with the simulated `BaseException` escaping, exactly as pyo3's did.

**What is NOT closed by this:** why the binding panicked at all. Debian's `cryptography` 41.0.7
lives in `/usr/lib/python3/dist-packages` (built for python3.12) and is on python3.11's path here,
which is the likely mismatch — but the panic is not deterministic. After the failing run the same
import succeeded 5/5 standalone, under the push's hermetic environment and under the suite's
`PYTHONPATH`; both v13 modules pass standalone (14 tests); a discovery run over the whole
`tests/invariants` subtree passed (1050 tests) without reproducing it; and the host has 16 GB with
no cgroup limit and no OOM events, so memory pressure is ruled out. Whatever the trigger, this
finding is about the probe's contract — that is what turned a flaky import into a refused push,
and it is the part that is fixed.

### PROC-HIGH-035 — two branches can be allocated the same finding id, and a merge loses one silently

**Severity:** HIGH · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

Observed live while landing this PR. This branch allocated `ARIA-HIGH-180` for
the signing-backend probe; `main` allocated `ARIA-HIGH-180`, in parallel, for
the Z.ai/Codex `convergence_id` finding. The allocator is monotonic within a
chain and has no idea another chain exists.

The merge then lost one of them without a word. The documented resolution for
`findings.jsonl` — take the base chain, re-append the rows the base lacks, then
`rechain-from` — compares by **id**. This branch's row carried an id main
already had, so it was not "lacking", and it was simply never re-appended. The
registry kept main's finding; this one survived only in a review file and two
code comments.

Nothing in the registry says a row disappeared. What caught it was
`validate-closes`, two pushes later, and only by luck of a side effect: commit
`17547fb7` cites `ARIA-HIGH-180` with this document as the review file, and the
gate noticed that the id's registered review file was now somebody else's. Had
the two findings happened to share a review file, the loss would have been
invisible and the finding would have looked tracked while being gone.

The trailer cannot be repaired — the gate reads the commit range, and the
force-push ban rules out amending — so `17547fb7` is allowlisted in
`commit-msg-validator.ts`, with that reasoning recorded there rather than here.
The finding is re-allocated as **ARIA-HIGH-181**, unchanged in content.

**Fix (not this cycle):** detection is the cheap half. `add` can refuse an id
already present in `origin/main`'s chain, which turns the collision into a
failed allocation rather than a silent loss. The merge recipe can diff by
`(id, content_hash)` instead of id alone, and re-allocate a colliding row
rather than drop it. Both belong with the registry's owner, not inside a
design-system PR.

### PROC-MEDIUM-036 — the changed-file type-check builds a program the package never uses

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

`type-check-changed-files.mjs` extends the owning package's `tsconfig.json` but replaces `include`
with an explicit `files` list: the changed files plus every `.d.ts` under the project. That is not
the program the package type-checks. `web/modules/farm-module/vite.config.ts` loads
`./src/test-setup.ts`, and that module's `import '@testing-library/jest-dom'` is what declares
`toBeInTheDocument` and `toHaveValue` on vitest's `Assertion`. With the setup file out of the
program, five matchers in `SiteFormModal.spec.tsx` failed the pre-push hook while
`tsc --noEmit -p web/modules/farm-module/tsconfig.json` on the same tree passed.

The failure is latent: it fires the first time a spec using a jest-dom matcher is _touched_, for a
reason unrelated to the change. Here the change was adding `ToggleButton` to a `vi.mock` list. A
gate that reports errors the project does not have is worse than no gate — it is the argument
people use for `--no-verify`, which this repository forbids.

**Fix:** the hook resolves `setupFiles` from the package's vite/vitest config and adds them to the
synthetic program, alongside the `.d.ts` files it already collects. The setup file is part of how
the package type-checks its tests, so the gate now compiles what the package compiles.

## Environment notes (not findings against this repository)

The kernel suite could not run at all in the Claude Code remote container until four packages were
installed; each failure mode is worth recording because none of them names its own cause clearly
from the test output alone:

| Missing          | Symptom                                                | Tests affected in an 8-module sample |
| ---------------- | ------------------------------------------------------ | ------------------------------------ |
| `bubblewrap`     | `SandboxUnavailable: bwrap is not usable on this host` | 3 errors + 3 failures                |
| `openssh-client` | `RuntimeError: ssh-keygen not on PATH`                 | 40 errors                            |
| `pytest`         | `_FailedTest` import errors                            | 4 errors                             |
| `gh`             | PR-lane tests                                          | included above                       |

`bubblewrap`'s message warns that "installed is not enough — a container without unprivileged user
namespaces will install it cleanly and fail every invocation". Here `user.max_user_namespaces` was
64313, so the kernel prerequisite was satisfied and the package alone was missing.

Three platform-injected environment variables also break hermetic assertions the suite makes. Both
affected tests pass once the variable is absent; neither is a test defect:

- `GIT_CONFIG_KEY_0..2` (the proxy's `credential.interactive` and two `url.insteadOf` rewrites)
  surface in `test_implementation_delivery` as `credential_names == ['GIT_CONFIG_KEY_0',
'GIT_CONFIG_VALUE_0']` against an expected `[]`. The credential accounting matches env var
  _names_; `GIT_CONFIG_*` is not a credential. On any host that configures git through the
  environment, the credential-refusal gate misreports what a push carried.
- `RUSTUP_HOME=/root/.rustup` makes the sandbox ro-bind the real home's rustup instead of the
  test's fake home, while `CARGO_HOME` (unset) resolves correctly under it — the two toolchain
  paths are resolved by different rules.

Both are ARIA-side observations raised here for the record; closing them is not this cycle's work.
