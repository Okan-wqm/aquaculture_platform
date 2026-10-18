"""ARIA-LOW-578 — pin a fixture repository's state lineage, as an operator does.

Every checkout of an existing state branch proves the fetched tip's history
against ``docs/aria/policy/state-lineage.json`` in the checkout
(``aria_kernel.state_lineage``). A fixture repository is a repository like any
other: after its acknowledged bootstrap it pins the genesis root, exactly the
step the bootstrap runbook gives the operator, and a later checkout in that
fixture is then held to it. A fixture that wants a REFUSAL leaves the pin out,
or pins another root, and says so.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from aria_kernel.state_lineage import (
    STATE_LINEAGE_POLICY_ID,
    STATE_LINEAGE_POLICY_PATH,
    STATE_LINEAGE_SCHEMA,
)
from tests._helpers.hermetic_git import apply_hermetic_git_env


def _git_env() -> dict[str, str]:
    """Every inherited GIT_* dropped, then the suite's hermetic config bound."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    apply_hermetic_git_env(env)
    return env


def write_state_lineage_policy(repo_root: str | Path, pins: dict[str, str]) -> Path:
    """Write the policy file naming ``pins`` (branch -> root) into ``repo_root``."""
    path = Path(repo_root) / STATE_LINEAGE_POLICY_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    policy = {
        "$schema": STATE_LINEAGE_SCHEMA,
        "schema_version": 1,
        "policy_id": STATE_LINEAGE_POLICY_ID,
        "lineages": [{"branch": branch, "root": root} for branch, root in sorted(pins.items())],
    }
    path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def lineage_root(git_dir: str | Path, rev: str = "HEAD") -> str:
    """The single root commit of ``rev``'s history in ``git_dir``."""
    roots = subprocess.run(
        ["git", "-C", str(git_dir), "rev-list", "--max-parents=0", rev],
        capture_output=True, text=True, check=True, env=_git_env(),
    ).stdout.split()
    if len(roots) != 1:
        raise AssertionError(f"fixture lineage has {len(roots)} roots: {roots}")
    return roots[0]


def _pins(repo_root: str | Path) -> dict[str, str]:
    path = Path(repo_root) / STATE_LINEAGE_POLICY_PATH
    if not path.exists():
        return {}
    return {
        entry["branch"]: entry["root"]
        for entry in json.loads(path.read_text(encoding="utf-8"))["lineages"]
    }


def _add_pin(repo_root: str | Path, branch: str, root: str) -> None:
    pins = _pins(repo_root)
    pins[branch] = root
    write_state_lineage_policy(repo_root, pins)


def pin_bootstrapped_lineage(store) -> str:
    """Pin ``store``'s genesis root for its branch in its own repository."""
    root = lineage_root(store.root)
    _add_pin(store.repo_root, store.branch, root)
    return root


def sync_fixture_lineage_pin(repo_root: str | Path, remote: str | Path, branch: str = "aria/state") -> None:
    """Give this fixture checkout the pin main would carry for ``remote``'s lineage.

    The fixture's stand-in for main: every clone of one repository reads the
    same committed policy, and an operator pins a lineage only once its
    genesis is PUBLISHED. So: when the remote has the branch and this checkout
    pins nothing for it, pin the root the remote has now — once; a pin already
    there stays, so a test that later replaces the remote lineage is still
    refused. When the remote has no such branch, nothing was published and
    nothing is pinned: a pin an earlier unpublished bootstrap left here
    (``pin_bootstrapped_lineage``) is dropped, as no operator would have
    committed it.
    """
    listed = subprocess.run(
        ["git", "-C", str(remote), "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}"],
        capture_output=True, text=True, env=_git_env(),
    )
    pins = _pins(repo_root)
    if listed.returncode != 0:
        if branch in pins:
            del pins[branch]
            write_state_lineage_policy(repo_root, pins)
        return
    if branch not in pins:
        _add_pin(repo_root, branch, lineage_root(remote, f"refs/heads/{branch}"))
