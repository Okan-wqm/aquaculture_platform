# The first autonomously converged plan never became a commit (2026-10-08)

Context: plan `plan-cyc-20261007T225133Z-auto` (F-013, admin-panel tenant config) converged
without an operator. ARIA-HIGH-383 unblocked its validation room. Executor run 37735581293
then spawned `AIR-aria-implementer-e056f97fe09b`. The agent applied all three key changes, and
its lint, test and type-check runs exited 0. Then the commit failed:

```text
git commit -m <subject> -m <body> exited 128: Author identity unknown ...
fatal: unable to auto-detect email address (got 'gharunner@NLDW4-4-34-28.(none)')
```

The agent refused (`agent_refused:safety`) instead of choosing its own identity, and the
request went `HUMAN_REQUIRED`. It was right to refuse.

Owner: claude (implementation), okan (review). Deadline 2026-10-15.

## ARIA-HIGH-387

The implementer's identity mint wired signing and no authorship.

- `gh_token_factory._SIGNING_CONFIG_KEYS` (`gh_token_factory.py:536` on main) writes
  `commit.gpgsign`, `gpg.format`, `user.signingkey` and `gpg.ssh.allowedSignersFile`.
  It writes no `user.name` or `user.email`.
- git builds the commit object, author and committer included, before it signs. A tree that
  resolves no identity cannot commit at all.
- Nothing else can supply one:
  - the runner host has no global git identity;
  - the sandbox's HOME is an empty tmpfs (`implementation_safety.SANDBOX_HOME`);
  - the agent's environment carries no `GIT_*` or `EMAIL` (`agent_env.BASELINE_ENV_NAMES`);
  - `command_policy` refuses `git config`, `--author` and `-S` to the agent, and that
    perimeter is correct.

Two things hid it until the last step of the first real run.

- The containment probe, which preflight's sandbox gate runs (`preflight.py:436` through
  `implementation_safety.sandbox_backend`), passed its own `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*` into the sandbox (`containment_probe.py:128`, `:265`). It proved a commit
  the implementer could never make.
- The test suite's hermetic global config (`tests/_helpers/hermetic.gitconfig:29`) and the
  fixture factory's `--local` identity gave every test repository an identity.

Reproduced on this host: a linked worktree with no identity in any layer, held through
`hold_implementation_identity` on main. `git commit` exits 128 "Author identity unknown".

## Fix

The identity is the implementer's concept, so its owner is `implementation_identity`.

- `IMPLEMENTER_COMMITTER_NAME` / `IMPLEMENTER_COMMITTER_EMAIL` (`aria-implementer`,
  `aria-implementer@users.noreply.github.com`) follow `state_store.COMMITTER_NAME` and
  `self_revert.REVERT_COMMITTER_NAME`.
- The hold passes `IMPLEMENTER_COMMIT_IDENTITY` to `mint_signing_key(commit_identity=...)`.
- The mint writes `user.name` / `user.email` in the same scope (`--worktree`) and the same
  transaction as the signing keys:
  - the snapshot is taken before the first write;
  - the identity is written after the ownership marker `user.signingkey`;
  - revoke and the startup prune restore it before they release the marker.
- A mint that names no identity (the knowledge signer, which never commits) does not snapshot
  or touch the operator's identity. Snapshots written before this change restore as before.

Detection (tier 3), in two places:

- The hold runs `git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT` with every ambient source
  removed, before the signing agent, the registry row or any turn. If the tree does not
  resolve exactly the kernel's identity, the hold unwinds the mint and refuses
  `commit_identity_unresolved:<author|committer>:<why>`.
- The containment probe mints the implementer's identity, commits inside the sandbox with no
  ambient identity, and checks that the landed commit is authored and committed by it.
  Preflight's sandbox gate therefore refuses a runner on which the implementer cannot commit,
  before a night starts.

## Round 2 — review of #1865 at 756e37033

The adversarial review found that the mint makes the kernel's identity the default but does not
make another one impossible.

- git's `author.*` and `committer.*` keys outrank `user.*` in every scope, and
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*` outrank both.
- The sandbox's HOME is a writable tmpfs, and the agent runs code it wrote (a test suite,
  `python3 <file>.py`). A commit by another author is reachable from inside the sandbox even
  though `git config`, `--author` and `-S` are refused at the command line.
- Measured: `[author] name = Evil` in the HOME config gives `Evil` as author and
  `aria-implementer` as committer.

Fix:

- The pre-PR-open perimeter gains its 21st check, `commit_identity_is_the_kernels`
  (`implementation_safety`). Every commit `base..tip` on a machine-approved branch must have
  the implementer identity as author and as committer, or the delivery is refused before the
  push with `commit_identity_foreign:<sha>:<role>=<ident>`.
- `pr_manager` derives the expected identity from the proposal's approval source. A machine
  approval is minted only by `apply_engine.stage_converged_plan_for_pr`, for the action the
  executor's implementer commits on. An operator approval is a person's change and declares
  none.
- `pr_manager._branch_commits_for_action` reads author and committer in the format
  `implementation_identity` owns. The perimeter and the containment probe share one
  comparison, `implementation_identity.foreign_commit_identities`.
- The mint refuses a `commit_identity` anywhere but a linked worktree
  (`CommitIdentityScopeRefused`, before any key, snapshot or config write). A main checkout's
  shared `--local` config can never author everybody's commits.
- The real spawn keeps the system config layer: see the commit body for why. The hold and the
  probe point it at `/dev/null` to prove the tree's own config carries the identity, and the
  perimeter check judges the identity whatever layer supplied it.

Not chosen: the GitHub App bot identity (`<id>+<slug>[bot]@users.noreply.github.com`).

- The kernel holds only `ARIA_GH_APP_ID`. The bot's user id and slug would need GitHub API
  calls at hold time.
- The delivery credential is minted after the spawn (ARIA-HIGH-124 round 6). In Mode B the
  PR is not opened by the App at all, so there would be two identities depending on mode.
- No downstream check compares a commit's author or committer:
  - `verify_commit_signature` checks the signing key's fingerprint;
  - `own_pr_ci.is_own_pr_head` checks the head ref;
  - the PR create requires an installation-token credential class;
  - the merge authority and readiness claims read none of them.

Tests: `aria-kernel/tests/test_implementer_commit_identity.py` runs with no ambient identity
(`user.useConfigOnly`, an empty HOME, no identity variables). The reproduction fails on main
with exit 128 and passes with the fix.
