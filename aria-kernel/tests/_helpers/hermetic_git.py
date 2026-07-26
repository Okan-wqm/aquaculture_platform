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
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import MutableMapping

HERMETIC_GITCONFIG: Path = Path(__file__).resolve().parent / "hermetic.gitconfig"

GIT_CONFIG_GLOBAL_VAR = "GIT_CONFIG_GLOBAL"
GIT_CONFIG_SYSTEM_VAR = "GIT_CONFIG_SYSTEM"


def apply_hermetic_git_env(env: MutableMapping[str, str] | None = None) -> None:
    """Point git's global + system config layers at hermetic sources.

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


def hermetic_git_env_is_active(env: MutableMapping[str, str] | None = None) -> bool:
    """True when this process's git subprocesses cannot see ambient config."""
    target: MutableMapping[str, str] = os.environ if env is None else env
    return (
        target.get(GIT_CONFIG_GLOBAL_VAR) == str(HERMETIC_GITCONFIG)
        and target.get(GIT_CONFIG_SYSTEM_VAR) == os.devnull
    )
