"""Hermetic git environment for the ARIA test process.

Fixture git repositories are built by `git` subprocesses, which inherit
the test process's environment and therefore the machine's global git
configuration. That makes the suite's verdict a function of machine
state — the same defect class the kernel's own telemetry work has been
closing, applied to the signal every stage gate depends on.

`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` (git >= 2.32) redirect the
two ambient configuration layers. Setting them once, at test-process
start, makes ambient leakage structurally impossible for every fixture
in the process — inline or factory-built — rather than something each
new test must remember to defend against.

Repository-local configuration is deliberately untouched: production
code under test (``gh_token_factory.mint_signing_key``) sets
``--local commit.gpgsign true`` on repos it owns, and that behaviour
must remain observable.

WHICH repository, not just WHICH configuration
----------------------------------------------

Redirecting the config layers closed ambient *configuration* leakage and
this module's first version claimed that made "ambient leakage
structurally impossible for every fixture in the process". It did not:
a second variable family decides which REPOSITORY a git subprocess acts
on, and it cost a real checkout.

``git`` exports an absolute ``GIT_DIR`` into its own environment whenever
the git dir is not the default ``.git`` in the current directory — which
is always the case inside a linked worktree. ``git push`` from such a
worktree therefore hands ``GIT_DIR=<repo>/.git/worktrees/<name>`` to
``.husky/pre-push``, which hands it to this suite.

``cwd=`` selects the WORK TREE; ``GIT_DIR`` selects the REPOSITORY. Every
fixture here passes ``cwd=<tempdir>`` and every one of them was still
writing into the host repository: ``git init`` re-initialised it (and
guessed ``core.bare=true``, because the exported path ends in the
worktree name rather than ``/.git``), ``git config`` wrote the host's
config, and ``git add``/``git commit`` staged temp files onto the host's
index and HEAD.

Scrubbing these at process start is the same shape as the config fix and
for the same reason: one place, covering every fixture — factory-built or
inline — instead of a discipline each new test must remember. Passing a
sanitised ``env=`` at each of the ~30 inline call sites would be the
version that is one forgotten call site away from recurring.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import MutableMapping

HERMETIC_GITCONFIG: Path = Path(__file__).resolve().parent / "hermetic.gitconfig"

GIT_CONFIG_GLOBAL_VAR = "GIT_CONFIG_GLOBAL"
GIT_CONFIG_SYSTEM_VAR = "GIT_CONFIG_SYSTEM"

# Every variable that can move a git subprocess off the repository its
# ``cwd`` implies. Removed rather than overridden: there is no value for
# ``GIT_DIR`` that means "use the directory I am standing in" — absence is
# the only way to say it.
GIT_LOCATION_VARS: tuple[str, ...] = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
)


def apply_hermetic_git_env(env: MutableMapping[str, str] | None = None) -> None:
    """Make git subprocesses blind to ambient config AND ambient repositories.

    Idempotent, and unconditional by design: an ambient value already
    present in the environment is exactly what this must override, so
    there is no "already set, leave it alone" branch to get wrong.
    """
    target: MutableMapping[str, str] = os.environ if env is None else env
    if not HERMETIC_GITCONFIG.is_file():
        raise RuntimeError(
            f"hermetic git config missing at {HERMETIC_GITCONFIG}; "
            "fixture repos would inherit ambient global git configuration"
        )
    target[GIT_CONFIG_GLOBAL_VAR] = str(HERMETIC_GITCONFIG)
    target[GIT_CONFIG_SYSTEM_VAR] = os.devnull
    for var in GIT_LOCATION_VARS:
        target.pop(var, None)


def hermetic_git_env_is_active(env: MutableMapping[str, str] | None = None) -> bool:
    """True when git subprocesses see neither ambient config nor a foreign repo."""
    target: MutableMapping[str, str] = os.environ if env is None else env
    return (
        target.get(GIT_CONFIG_GLOBAL_VAR) == str(HERMETIC_GITCONFIG)
        and target.get(GIT_CONFIG_SYSTEM_VAR) == os.devnull
        and not any(var in target for var in GIT_LOCATION_VARS)
    )
