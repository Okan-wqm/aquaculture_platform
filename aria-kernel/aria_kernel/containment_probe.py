"""ARIA-HIGH-123 — the containment probe proves a SIGNED commit lands from inside the sandbox.

WHY this module exists
----------------------
``implementation_safety._bwrap_available`` decided "containment is usable"
by running ``/bin/true`` under the system binds (ORPHAN-CRITICAL-439: a
backend that installs but cannot build its namespaces). That probe said
yes on every host where the implementer's ``git commit`` then died inside
the sandbox — the sandbox could run a binary and could not run the one
thing the implementation contract is made of. A runner whose containment
cannot run git was admitted, claimed a request, spent a turn, and refused
the result at the end.

The first cut of this probe committed UNSIGNED with ``GIT_AUTHOR_*`` set,
and passed on the production runner where the signed route did not: git
needs no account lookup when the ident is in the environment, but
``ssh-keygen -Y sign`` resolves its uid before it signs and died ``No user
exists for uid 1000?`` in a sandbox without ``/etc/passwd`` — so the probe
admitted a runner on which the request was then claimed, the key minted,
the turn spent and the result refused: the failure class this probe
exists to prevent, one layer deeper.

WHAT this module does
---------------------
It runs the probe the implementer actually needs, the SIGNED route through
the same pieces the executor's identity uses: a throwaway repository with a
linked worktree (the production shape); a throwaway key minted INTO that
worktree by ``gh_token_factory.mint_signing_key`` (which wires the
worktree's git config the way the identity does); an ssh-agent held by
``signing_agent.hold_signing_agent``; a commit-capable containment derived
with that signing exposure by ``git_containment.derive_git_containment``;
the sandbox stood on the probe's ``aria-impl-*`` branch by the kernel the
way the executor stands the implementer's
(``git_containment.stand_on_implementation_branch``, ARIA-HIGH-124); and —
inside the real sandbox argv the wrapper builds, with the managed route's
network setting — ``git status``, the branch check (the sandbox MUST start
on the kernel-made branch; ``git switch`` is not the agent's), ``git commit
--allow-empty`` (signed through the agent, the private key masked) and the
writes that must be REFUSED (``git config --local``, a file under the
effective hooks directory, the private key readable). Then, from OUTSIDE,
the quarantine is published the way the executor publishes it
(``git_containment.publish_quarantine``) and the commit is verified with
``git verify-commit`` against the minted key: bwrap's root tmpfs is
writable, so a sandbox that absorbed the branch into a phantom ``.git``
would otherwise pass; and a lock the sandbox plants under ``refs/heads``
must not have reached the repository. The argv builder is a parameter so
this module imports nothing from ``implementation_safety`` (which imports
it) and the probe is testable with a deliberately broken builder.

The result is a reason string, or ``None`` when the sandbox can host the
contract. ``sandbox_backend()`` folds a reason into "no backend", which is
what the pre-claim environment gate reads (``ci_executor``: the request
stays PENDING, nothing is claimed, no turn is spent) and what
``wrap_bash_in_sandbox`` raises ``SandboxUnavailable`` on.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path

from .git_containment import (
    GitContainment,
    GitContainmentRefusal,
    SandboxSigning,
    derive_git_containment,
    publish_quarantine,
    stand_on_implementation_branch,
)
from .signing_agent import SigningAgentUnavailable, hold_signing_agent

PROBE_BRANCH = "aria-impl-0c0a7a1ebe"
PROBE_CYCLE_ID = "containment-probe"
_PROBE_GIT_TIMEOUT_SECONDS = 20
_PROBE_SANDBOX_TIMEOUT_SECONDS = 30
# Variables that can move a git subprocess off the repository its cwd
# implies (``git`` exports an absolute ``GIT_DIR`` into hooks it runs, and
# this probe can run under such a hook) — removed, never overridden.
_GIT_LOCATION_VARS: tuple[str, ...] = (
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
)
# The exit codes the probe script reserves for a control surface that
# turned out writable (or readable) inside; git's own failures are 128.
EXIT_CONFIG_WRITABLE = 41
EXIT_HOOKS_WRITABLE = 42
EXIT_PRIVATE_KEY_READABLE = 43
# The sandbox did not start on the branch the kernel stood it on
# (ARIA-HIGH-124): the replica's HEAD is not what the sandbox sees.
EXIT_BRANCH_NOT_STOOD_ON = 44

ArgvBuilder = Callable[[list[str], Path, GitContainment], list[str]]
"""``(command, workspace_root, containment) -> full sandbox argv``."""


def probe_git_environment() -> dict[str, str]:
    """The environment every probe git call runs with: the ambient config
    layers redirected to nothing (an operator's ``commit.gpgsign`` must not
    decide whether containment works) and every repository-location
    variable removed."""
    env = {name: value for name, value in os.environ.items() if name not in _GIT_LOCATION_VARS}
    env.update({
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_AUTHOR_NAME": "aria-containment-probe",
        "GIT_AUTHOR_EMAIL": "probe@aria.invalid",
        "GIT_COMMITTER_NAME": "aria-containment-probe",
        "GIT_COMMITTER_EMAIL": "probe@aria.invalid",
    })
    return env


def _git(args: Sequence[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True, check=False,
        timeout=_PROBE_GIT_TIMEOUT_SECONDS,
    )


def probe_script(containment: GitContainment, *, private_key_path: Path) -> str:
    """The shell the probe runs inside the sandbox. Every line is one
    property of the contract: the three commands the implementer runs must
    succeed (the commit signed through the agent), and the control writes —
    and a read of the private key — must be refused. A ref lock planted
    under ``refs/heads`` is checked from outside."""
    hooks = containment.hooks_dir if containment.hooks_dir is not None else containment.common_git_dir / "hooks"
    return "\n".join([
        "set -e",
        "git status --short >/dev/null",
        f"if [ \"$(git branch --show-current)\" != \"{PROBE_BRANCH}\" ]; then exit {EXIT_BRANCH_NOT_STOOD_ON}; fi",
        "git commit -q --allow-empty -m aria-containment-probe",
        f"if git config --local aria.containmentProbe 1 2>/dev/null; then exit {EXIT_CONFIG_WRITABLE}; fi",
        f"if sh -c 'echo probe > \"{hooks}/aria-containment-probe\"' 2>/dev/null; then exit {EXIT_HOOKS_WRITABLE}; fi",
        f"if cat \"{private_key_path}\" >/dev/null 2>&1; then exit {EXIT_PRIVATE_KEY_READABLE}; fi",
        f"touch \"{containment.common_git_dir}/refs/heads/main.lock\" 2>/dev/null || true",
    ])


def _failure_detail(inside: subprocess.CompletedProcess[str]) -> str:
    # The first line names the syscall-level cause (`unable to create ...
    # file: Read-only file system`, `No user exists for uid`); the last is
    # git's summary (`failed to write commit object`). Both, when distinct.
    lines = [line for line in (inside.stderr.strip() or inside.stdout.strip()).splitlines() if line.strip()]
    # Long enough for a ref-lock line to keep its errno text (`Unable to
    # create '<path>.lock': Read-only file system` runs past 160 chars
    # under a temp-rooted probe checkout).
    return " | ".join(dict.fromkeys(line[:320] for line in (lines[:1] + lines[-1:])))


def probe_git_containment(build_argv: ArgvBuilder) -> str | None:
    """Run the probe; ``None`` when containment can host a signed commit, else why not."""
    if shutil.which("git") is None:
        return "git_missing"
    from .gh_token_factory import mint_signing_key, revoke_signing_key

    env = probe_git_environment()
    root = Path(tempfile.mkdtemp(prefix="aria-containment-probe-"))
    try:
        checkout = root / "checkout"
        checkout.mkdir()
        for step in (["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "probe-base"]):
            done = _git(step, cwd=checkout, env=env)
            if done.returncode != 0:
                return f"probe_repository_unavailable:{' '.join(step[:1])}:rc={done.returncode}"
        worktree = checkout / "aria-worktrees" / "req-probe"
        worktree.parent.mkdir()
        added = _git(["worktree", "add", "--detach", "-q", str(worktree), "HEAD"], cwd=checkout, env=env)
        if added.returncode != 0:
            return f"probe_worktree_unavailable:rc={added.returncode}"
        # The worktree scope the identity mint requires (ARIA-HIGH-114).
        _git(["config", "--local", "extensions.worktreeConfig", "true"], cwd=checkout, env=env)
        # The identity's own mint: the key under the worktree, the
        # worktree's config wired to sign with it.
        try:
            key = mint_signing_key(cycle_id=PROBE_CYCLE_ID, workspace_root=worktree)
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            return f"probe_key_unavailable:{type(exc).__name__}"
        try:
            wiring = key.git_signing
            if wiring is None or not wiring.configured:
                return f"probe_signing_unwired:{'re-mint' if wiring is None else wiring.reason}"
            try:
                with hold_signing_agent(key.private_key_path, expected_fingerprint=key.fingerprint) as agent:
                    try:
                        containment = derive_git_containment(worktree, commit_capable=True, signing=SandboxSigning(
                            keys_dir=key.private_key_path.parent, public_key_path=key.public_key_path,
                            agent_socket=agent.socket_path,
                        ))
                    except GitContainmentRefusal as exc:
                        return f"probe_containment_refused:{exc.reason}"
                    assert containment is not None
                    # The executor's own branch step (ARIA-HIGH-124): the
                    # sandbox starts on the probe branch at the worktree's
                    # HEAD, in the replica only.
                    base = _git(["rev-parse", "HEAD"], cwd=worktree, env=env)
                    if base.returncode != 0:
                        return f"probe_base_unresolvable:rc={base.returncode}"
                    try:
                        containment = stand_on_implementation_branch(
                            containment, branch=PROBE_BRANCH, base_sha=base.stdout.strip(),
                        )
                    except GitContainmentRefusal as exc:
                        return f"probe_branch_refused:{exc.reason}"
                    script = probe_script(containment, private_key_path=key.private_key_path)
                    argv = build_argv(["sh", "-c", script], worktree, containment)
                    try:
                        inside = subprocess.run(
                            argv, env=env, capture_output=True, text=True, check=False,
                            timeout=_PROBE_SANDBOX_TIMEOUT_SECONDS,
                        )
                    except (OSError, subprocess.SubprocessError) as exc:
                        return f"probe_sandbox_error:{type(exc).__name__}"
            except SigningAgentUnavailable as exc:
                return f"probe_signing_agent_unavailable:{exc.reason}"
            if inside.returncode != 0:
                return f"git_in_sandbox_failed:rc={inside.returncode}:{_failure_detail(inside)}"
            # A lock planted under the shared refs must have stayed in the
            # quarantine; on the host git never cleans a stale ref lock.
            if (checkout / ".git" / "refs" / "heads" / "main.lock").exists():
                return "sandbox_lock_reached_repository"
            # The executor's own publication, from outside: objects verified
            # and moved, the branch published — then the commit must verify
            # against the minted key through the real common dir.
            publication = publish_quarantine(containment)
            if publication.refusal is not None:
                return f"sandbox_publication_refused:{publication.refusal}"
            # The branch the kernel stood the sandbox on names the base
            # until the commit inside advances it: the publication discards
            # an unadvanced seed by name (`branch_unadvanced`, ARIA-HIGH-124
            # round 2), so a commit that went into a phantom is a branch
            # that was never published.
            if PROBE_BRANCH not in publication.refs_published:
                return "sandbox_commit_did_not_reach_repository"
            landed = _git(["rev-parse", "--verify", f"refs/heads/{PROBE_BRANCH}^{{commit}}"], cwd=checkout, env=env)
            if landed.returncode != 0 or landed.stdout.strip() == base.stdout.strip():
                return "sandbox_commit_did_not_reach_repository"
            signers = containment.private_git_dir / "aria-allowed-signers"
            verified = _git(["-c", f"gpg.ssh.allowedSignersFile={signers}", "verify-commit", "--raw",
                             landed.stdout.strip()], cwd=checkout, env=env)
            if verified.returncode != 0 or key.fingerprint not in (verified.stderr + verified.stdout):
                return f"sandbox_commit_unverifiable:{(verified.stderr.strip().splitlines() or ['?'])[0][:120]}"
            return None
        finally:
            revoke_signing_key(cycle_id=PROBE_CYCLE_ID, workspace_root=worktree)
    except (OSError, subprocess.SubprocessError) as exc:
        return f"probe_error:{type(exc).__name__}"
    finally:
        shutil.rmtree(root, ignore_errors=True)


__all__ = [
    "EXIT_BRANCH_NOT_STOOD_ON",
    "EXIT_CONFIG_WRITABLE",
    "EXIT_HOOKS_WRITABLE",
    "EXIT_PRIVATE_KEY_READABLE",
    "PROBE_BRANCH",
    "PROBE_CYCLE_ID",
    "probe_git_containment",
    "probe_git_environment",
    "probe_script",
]
