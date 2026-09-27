"""ARIA-HIGH-123 — the signing key stays with the kernel; the sandbox gets a socket.

WHY this module exists
----------------------
The implementer's commits are signed by a per-cycle ssh key
(``gh_token_factory.mint_signing_key``) that git reaches through
``user.signingkey = <private key path>`` and ``ssh-keygen -Y sign``. That
form needs to READ the private key file — and an agent whose bash can run
git can also ``cat`` that file. Inside the write-containment sandbox the key
was readable (``aria-debts/`` is ro-bound; read-only is not unreadable), so
for the length of its window the agent could copy the identity the merge
gate trusts.

WHAT this module does
---------------------
It holds an ``ssh-agent`` OUTSIDE the sandbox for the length of the
identity window, loads the private key into it once, and hands the
sandbox the agent's SOCKET only (``git_containment.SandboxSigning``:
the keys dir is masked, the public half shown, the socket bound at
``SANDBOX_SIGNING_AGENT_SOCKET``). ``ssh-keygen -Y sign -f <private path>``
then finds no private file, loads ``<private path>.pub``, and signs through
the agent — measured with OpenSSH 9.6 / git 2.43 on this host: the same
``user.signingkey`` value the B7 config transaction snapshots, restores and
uses as its ownership marker, so nothing about the config contract moves.
The agent can sign during its window; it can never read what it signs with.

The agent dies with its holder HOWEVER the holder dies: it is started with
``PR_SET_PDEATHSIG`` (SIGTERM from the kernel when the holder thread exits —
the OOM-kill and deadline-kill class this runner lives under never reaches a
``finally``) under ``PR_SET_NO_NEW_PRIVS`` (the distribution's set-gid
``ssh-agent`` would otherwise drop the death signal at exec), and its
identities carry a lifetime (``-t``) bounded by the job deadline
(``ARIA_JOB_DEADLINE_EPOCH``), so a socket that outlived everything still
holds no key past the window. It starts with a minimal
environment (PATH only — an agent that inherited the executor's whole
environ was readable through ``/proc/<pid>/environ`` by a same-uid process)
and with a provider pattern that matches nothing (``-P '!*'``): the socket is
handed to the sandbox, and ``ssh-add -s <library>`` through it would make
the KERNEL-side agent ``dlopen`` a library the agent named. The orphan
sweep (``prune_stale_signing_agents``, the orchestrator's startup pass next
to the key reaper) removes socket directories whose agent no longer
answers.

The refusals are by name (``SigningAgentUnavailable.reason``):
``ssh_agent_missing`` / ``ssh_add_missing`` (binaries), ``socket_path_too_long``
(``sun_path`` is 108 bytes; the socket lives in a short-named temp dir, so
this is a host whose temp root is itself long), ``agent_exited:<rc>`` /
``agent_socket_not_created`` (the agent did not come up inside its bound),
``ssh_add_failed:<rc>``, ``agent_holds_wrong_keys`` (the agent lists
anything but the one key it was given), ``lifetime_invalid`` (a
non-positive lifetime: the window has already closed).
"""
from __future__ import annotations

import ctypes
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

# Linux `sun_path` is 108 bytes including the terminator.
_UNIX_SOCKET_PATH_MAX = 107
_AGENT_START_TIMEOUT_SECONDS = 10.0
_AGENT_STOP_TIMEOUT_SECONDS = 5.0
_SSH_ADD_TIMEOUT_SECONDS = 15
_SOCKET_DIR_PREFIX = "aria-sa-"
_SOCKET_NAME = "agent"
# The shape of a directory THIS module made: the prefix, mkdtemp's 8-char
# suffix, and nothing inside but the socket. The sweep removes nothing
# else — a test fixture's `aria-sa-test-*` root, a directory with files in
# it, are not the kernel's to delete.
_SOCKET_DIR_RE = re.compile(r"^aria-sa-[A-Za-z0-9_]{8}$")
# `ssh-agent -t`: a key added without its own lifetime expires after this
# many seconds. The holder passes the window's remaining time; this is the
# ceiling when no deadline is known (an operator shell), so no agent holds
# a key for longer than the longest executor job.
DEFAULT_LIFETIME_SECONDS = 6 * 3600
MAX_LIFETIME_SECONDS = 24 * 3600
# `ssh-agent -P`: the pattern-list of provider libraries `ssh-add -s` may
# make the agent load. `!*` negates everything — no library matches.
NO_PROVIDER_PATTERN = "!*"
_PR_SET_PDEATHSIG = 1
_PR_SET_NO_NEW_PRIVS = 38


class SigningAgentUnavailable(RuntimeError):
    """The kernel could not hold an agent for the key; ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class SigningAgent:
    """The held agent: where its socket is, which key fingerprint it holds,
    and how long the key lives in it."""

    socket_path: Path
    pid: int
    fingerprint: str
    lifetime_seconds: int


def _agent_env(socket_path: Path) -> dict[str, str]:
    """The agent's own environment: PATH (to find nothing — it execs no
    helper) and the socket, nothing of the holder's."""
    return {"PATH": os.environ.get("PATH", os.defpath), "SSH_AUTH_SOCK": str(socket_path)}


def _client_env(socket_path: Path) -> dict[str, str]:
    env = {name: value for name, value in os.environ.items() if name not in ("SSH_AUTH_SOCK", "SSH_AGENT_PID")}
    env["SSH_AUTH_SOCK"] = str(socket_path)
    return env


def _prctl() -> Any:
    """``prctl`` resolved in the PARENT: the pre-exec step runs in the
    forked child, where a ``dlopen`` could wait on a loader lock another
    thread of the holder held at fork time."""
    return ctypes.CDLL(None, use_errno=True).prctl


def _die_with_holder(holder_pid: int, prctl: Any) -> Any:
    """The child's pre-exec step: ask the kernel for SIGTERM when the holder
    thread exits, then re-check the holder is still the parent — a holder
    that died between fork and prctl would otherwise leave the child
    parented to init with the signal armed for nobody.

    ``PR_SET_NO_NEW_PRIVS`` comes first: Debian and Ubuntu ship
    ``ssh-agent`` set-group-ID (``_ssh``), and the kernel CLEARS the
    parent-death signal when a set-id binary is executed — measured on this
    host: without it the agent outlived a SIGKILLed holder. With no new
    privileges the set-gid bit is ignored, the exec keeps the signal, and
    the agent runs as the holder's own gid; it still makes itself
    non-dumpable on its own (``PR_SET_DUMPABLE`` in ssh-agent's ``main``),
    so ``/proc/<pid>/{environ,mem}`` stay closed to a same-uid reader —
    measured as the runner's uid.
    """
    def _preexec() -> None:
        if prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            os._exit(124)
        if prctl(_PR_SET_PDEATHSIG, int(signal.SIGTERM), 0, 0, 0) != 0:
            os._exit(125)
        if os.getppid() != holder_pid:
            os._exit(126)
    return _preexec


def _list_fingerprints(socket_path: Path) -> list[str]:
    done = subprocess.run(
        ["ssh-add", "-l"], capture_output=True, text=True, check=False,
        timeout=_SSH_ADD_TIMEOUT_SECONDS, env=_client_env(socket_path),
    )
    if done.returncode != 0:
        return []
    fingerprints: list[str] = []
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].startswith("SHA256:"):
            fingerprints.append(parts[1])
    return fingerprints


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=_AGENT_STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=_AGENT_STOP_TIMEOUT_SECONDS)


def lifetime_until(deadline_epoch: float | None, *, now: float | None = None) -> int:
    """The seconds a key may live in the agent: until ``deadline_epoch``
    when one is known, else :data:`DEFAULT_LIFETIME_SECONDS`; never above
    :data:`MAX_LIFETIME_SECONDS`. Zero (or less) means the window has
    closed already — ``hold_signing_agent`` refuses it by name."""
    if deadline_epoch is None:
        return DEFAULT_LIFETIME_SECONDS
    at = time.time() if now is None else now
    return min(int(deadline_epoch - at), MAX_LIFETIME_SECONDS)


@contextmanager
def hold_signing_agent(
    private_key_path: str | Path,
    *,
    expected_fingerprint: str,
    lifetime_seconds: int = DEFAULT_LIFETIME_SECONDS,
) -> Iterator[SigningAgent]:
    """Run an ssh-agent holding exactly ``private_key_path`` for the body.

    The agent runs in the foreground (``-D``) as a child of this process, on
    a socket in a fresh short-named directory (mode 0700); it is stopped on
    every exit of the body, and it dies with this process's thread however
    that exits (``PR_SET_PDEATHSIG``). ``expected_fingerprint`` is the key's
    ``SHA256:`` fingerprint as the mint computed it; the agent is refused if
    it lists anything else, so the socket the sandbox receives can sign with
    this one identity and no other. ``lifetime_seconds`` bounds how long the
    agent keeps the key (``-t``): pass the window's remaining time
    (:func:`lifetime_until`). Nothing is written to the caller's environment.
    """
    key = Path(private_key_path)
    if shutil.which("ssh-agent") is None:
        raise SigningAgentUnavailable("ssh_agent_missing")
    if shutil.which("ssh-add") is None:
        raise SigningAgentUnavailable("ssh_add_missing")
    lifetime = int(lifetime_seconds)
    if lifetime <= 0 or lifetime > MAX_LIFETIME_SECONDS:
        raise SigningAgentUnavailable("lifetime_invalid")
    socket_dir = Path(tempfile.mkdtemp(prefix=_SOCKET_DIR_PREFIX))
    socket_path = socket_dir / _SOCKET_NAME
    process: subprocess.Popen[bytes] | None = None
    try:
        if len(str(socket_path).encode()) > _UNIX_SOCKET_PATH_MAX:
            raise SigningAgentUnavailable("socket_path_too_long")
        try:
            process = subprocess.Popen(
                ["ssh-agent", "-D", "-s", "-a", str(socket_path), "-t", str(lifetime), "-P", NO_PROVIDER_PATTERN],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=_agent_env(socket_path), preexec_fn=_die_with_holder(os.getpid(), _prctl()),
            )
            deadline = time.monotonic() + _AGENT_START_TIMEOUT_SECONDS
            while not socket_path.is_socket():
                if process.poll() is not None:
                    raise SigningAgentUnavailable(f"agent_exited:{process.returncode}")
                if time.monotonic() >= deadline:
                    raise SigningAgentUnavailable("agent_socket_not_created")
                time.sleep(0.02)
            added = subprocess.run(
                ["ssh-add", "-q", str(key)], capture_output=True, text=True, check=False,
                timeout=_SSH_ADD_TIMEOUT_SECONDS, env=_client_env(socket_path),
            )
            if added.returncode != 0:
                raise SigningAgentUnavailable(f"ssh_add_failed:{added.returncode}")
            held = _list_fingerprints(socket_path)
        except (OSError, subprocess.SubprocessError) as exc:
            raise SigningAgentUnavailable(f"agent_error:{type(exc).__name__}") from exc
        if held != [expected_fingerprint]:
            raise SigningAgentUnavailable("agent_holds_wrong_keys")
        yield SigningAgent(socket_path=socket_path, pid=process.pid, fingerprint=expected_fingerprint,
                           lifetime_seconds=lifetime)
    finally:
        if process is not None:
            _stop(process)
        shutil.rmtree(socket_dir, ignore_errors=True)


def _agent_answers(socket_path: Path) -> bool:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(1.0)
        client.connect(str(socket_path))
        return True
    except OSError:
        return False
    finally:
        client.close()


def prune_stale_signing_agents(*, temp_root: str | Path | None = None) -> dict[str, Any]:
    """Remove the socket directories of agents that no longer answer.

    A holder killed outright leaves its ``aria-sa-*`` directory behind
    (the agent itself is gone with the holder, ``PR_SET_PDEATHSIG``); a
    directory whose socket nobody listens on is swept. A directory whose
    agent still answers belongs to a live holder and is left alone.
    """
    root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    swept: list[str] = []
    live: list[str] = []
    errors: list[str] = []
    for entry in sorted(root.glob(f"{_SOCKET_DIR_PREFIX}*")):
        if not entry.is_dir() or not _SOCKET_DIR_RE.match(entry.name):
            continue
        socket_path = entry / _SOCKET_NAME
        if socket_path.is_socket() and _agent_answers(socket_path):
            live.append(entry.name)
            continue
        try:
            if any(child.name != _SOCKET_NAME for child in entry.iterdir()):
                continue
            shutil.rmtree(entry)
        except OSError as exc:
            errors.append(f"{entry.name}:{type(exc).__name__}")
        else:
            swept.append(entry.name)
    return {"scanned": len(swept) + len(live) + len(errors), "swept": swept, "live": live, "errors": errors}


__all__ = [
    "DEFAULT_LIFETIME_SECONDS",
    "MAX_LIFETIME_SECONDS",
    "NO_PROVIDER_PATTERN",
    "SigningAgent",
    "SigningAgentUnavailable",
    "hold_signing_agent",
    "lifetime_until",
    "prune_stale_signing_agents",
]
