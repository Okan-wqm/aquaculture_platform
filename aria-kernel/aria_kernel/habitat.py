"""SI-4 — ARIA looks after the machine it lives on.

The runner's own disk, load and test-run debris were invisible to every
mechanism ARIA has. Measured on 2026-08-19: eight worktrees plus 8,430
stale `/tmp/aria-*` directories from red suite runs took the droplet from
43 GB free to 33 GB in one night, the production capacity lane went red
three times against its 35 GiB floor, and nothing in ARIA noticed — the
preflight only refuses to START a night below its floor (`preflight.
MIN_FREE_DISK_GB`), it never cleans and never tells anyone.

Two obligations live here, deliberately separated:

* the JANITOR removes what ARIA itself produced and no longer needs. It
  is conservative by construction: an age floor, an owned-prefix list,
  and never a running suite's scratch directory.
* the PROBE measures and, when the habitat is degraded, hands the fact
  to the mechanism that already turns external facts into work
  (`runtime_signal_bridge.ingest_runtime_signal`, the same entry the
  dataflow watchdog uses). It never deletes.

Cleaning is not a fix; it is hygiene. The probe is what makes the
underlying pressure visible so a real fix can be planned.

ADR-0023 / K-2′ (ARIA-HIGH-281) adds a third obligation: the T2 PROBE.
ARIA's runner (T2) must never sign or approve as the operator, and that holds
only while the account the runner's jobs run as cannot reach what makes an
operator act. :func:`probe_t2_boundary` measures it as that account sees it
(the operator key path, uid, sudo, docker, the runner ``.env``, and every key
T2 holds against the allowed-signers file on main); the hourly host timer
``scripts/aria/runner-habitat/systemd/aria-t2-probe.timer`` runs it as
``gharunner`` and
publishes the verdict to node-exporter, where an alert reads it.
"""
from __future__ import annotations

import grp
import os
import pwd
import re
import shutil
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ARIA's own scratch prefixes under the system temp dir. Anything not on
# this list is somebody else's file and the janitor never touches it —
# the blast radius is bounded by a literal, not by a heuristic.
OWNED_TEMP_PREFIXES: tuple[str, ...] = ("aria-", "aqua-")

# An hour is longer than any single kernel test and shorter than a night.
# Three hours is the same margin applied by hand on 2026-08-19 with no
# collateral damage; it stays the default so a suite that is merely slow
# is never robbed of its fixture.
DEFAULT_MIN_AGE_SECONDS: int = 3 * 60 * 60

# The production capacity lane refuses to act below 35 GiB and reserves
# 20 GiB for a deploy. ARIA's habitat threshold sits ABOVE the lane's
# floor on purpose: by the time the deploy lane is blocked the damage is
# already done, and the point of this probe is to be the earlier signal.
HABITAT_DEGRADED_FREE_GB: float = 40.0


@dataclass(frozen=True)
class SweepResult:
    """What a janitor pass did — reported, never silent."""

    removed: list[str] = field(default_factory=list)
    reclaimed_bytes: int = 0
    skipped_recent: int = 0
    failed: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "removed_count": len(self.removed),
            "removed": sorted(self.removed)[:20],
            "reclaimed_bytes": self.reclaimed_bytes,
            "skipped_recent": self.skipped_recent,
            "failed": sorted(self.failed)[:20],
        }


def _dir_size_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                continue
    return total


def sweep_stale_scratch(
    *,
    temp_root: str | Path = "/tmp",
    min_age_seconds: int = DEFAULT_MIN_AGE_SECONDS,
    now: float | None = None,
    dry_run: bool = False,
) -> SweepResult:
    """Remove ARIA's own abandoned scratch directories.

    A directory qualifies only when ALL of these hold: its name starts
    with an owned prefix, it sits directly under `temp_root` (no
    recursion — a nested match is somebody's structure, not our litter),
    and it has not been modified for `min_age_seconds`. Everything else
    is left alone and counted, so a pass that removes nothing still says
    what it saw.
    """
    root = Path(temp_root)
    stamp = time.time() if now is None else now
    removed: list[str] = []
    failed: list[str] = []
    skipped = 0
    reclaimed = 0
    if not root.is_dir():
        return SweepResult()
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.is_symlink():
            continue
        if not entry.name.startswith(OWNED_TEMP_PREFIXES):
            continue
        try:
            age = stamp - entry.lstat().st_mtime
        except OSError:
            failed.append(str(entry))
            continue
        if age < min_age_seconds:
            skipped += 1
            continue
        size = _dir_size_bytes(entry)
        if dry_run:
            removed.append(str(entry))
            reclaimed += size
            continue
        try:
            shutil.rmtree(entry)
        except OSError:
            failed.append(str(entry))
            continue
        removed.append(str(entry))
        reclaimed += size
    return SweepResult(
        removed=removed, reclaimed_bytes=reclaimed,
        skipped_recent=skipped, failed=failed,
    )


def probe_habitat(*, workspace_root: str | Path) -> dict[str, Any]:
    """Measure the habitat. Returns the facts; decides nothing."""
    try:
        usage = shutil.disk_usage(str(workspace_root))
        free_gb: float | None = usage.free / (1024 ** 3)
    except OSError:
        free_gb = None
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = -1.0
    return {
        "free_disk_gb": None if free_gb is None else round(free_gb, 2),
        "load_average": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "cpu_count": os.cpu_count() or 0,
        # An unprobeable disk is NOT degraded — the same honesty rule the
        # preflight applies: only a MEASURED shortage counts.
        "degraded": free_gb is not None and free_gb < HABITAT_DEGRADED_FREE_GB,
    }


# ADR-0023 / K-2′ — what the T2 probe measures. The account the runner's jobs
# run as (scripts/aria/runner-habitat/systemd/actions-runner.identity.conf),
# the operator signing key the ADR keeps under /root, and the docker socket
# (docker is root by another name).
T2_RUNNER_USER = "gharunner"
OPERATOR_SIGNING_KEY = Path("/root/.ssh/aria-operator-signing")
DOCKER_SOCKET = Path("/var/run/docker.sock")
# Personal tokens by GitHub's documented prefixes: classic, fine-grained,
# OAuth and user-to-server. An App installation token (ghs_) is the identity
# T2 is meant to hold; ARIA_GH_TOKEN was the operator's PAT (ARIA-CRITICAL-246).
_PERSONAL_TOKEN_RE = re.compile(r"\b(?:ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,}")
_RETIRED_PAT_KEY_RE = re.compile(r"(?m)^\s*(?:export\s+)?ARIA_GH_TOKEN\s*=")
_PRIVATE_KEY_HEADER = b"-----BEGIN OPENSSH PRIVATE KEY-----"
_MAX_KEY_FILES = 256
_PROBE_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class T2Boundary:
    """One T2 probe: who ran it and every way the boundary did not hold."""

    identity: str
    violations: tuple[str, ...]

    @property
    def held(self) -> bool:
        return not self.violations


def _sudo_verdict() -> str:
    sudo = shutil.which("sudo")
    if sudo is None:
        return "denied"
    try:
        proc = subprocess.run([sudo, "-n", "true"], stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=_PROBE_TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return "inconclusive"
    return "admitted" if proc.returncode == 0 else "denied"


def _group_names() -> frozenset[str]:
    names: set[str] = set()
    for gid in {*os.getgroups(), os.getegid()}:
        try:
            names.add(grp.getgrgid(gid).gr_name)
        except KeyError:
            names.add(str(gid))
    return frozenset(names)


def _runner_env_violation(runner_env: Path) -> str | None:
    """A personal token in the runner .env, judged without ever echoing a value."""
    try:
        text = runner_env.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None
    except OSError:
        return "runner_env_unreadable"
    if _PERSONAL_TOKEN_RE.search(text) or _RETIRED_PAT_KEY_RE.search(text):
        return "runner_env_holds_personal_token"
    return None


def held_key_blobs(key_dirs: Sequence[Path]) -> frozenset[str]:
    """Every public key blob the probing account can read or derive in ``key_dirs``.

    A ``.pub`` file is read; an OpenSSH private key without a passphrase is
    derived with ``ssh-keygen -y`` (holding the private half is holding the
    key). Unreadable files are not held by this account.
    """
    blobs: set[str] = set()
    keygen = shutil.which("ssh-keygen")
    for directory in key_dirs:
        try:
            entries = sorted(directory.iterdir())[:_MAX_KEY_FILES] if directory.is_dir() else []
        except OSError:
            continue
        for entry in entries:
            try:
                if not entry.is_file():
                    continue
                if entry.suffix == ".pub":
                    blobs.update(entry.read_text(encoding="utf-8", errors="replace").split()[1:2])
                    continue
                with entry.open("rb") as handle:
                    private = handle.read(len(_PRIVATE_KEY_HEADER)) == _PRIVATE_KEY_HEADER
                if private and keygen is not None:
                    proc = subprocess.run([keygen, "-y", "-P", "", "-f", str(entry)], stdin=subprocess.DEVNULL,
                                          capture_output=True, text=True, timeout=_PROBE_TIMEOUT_SECONDS, check=False)
                    blobs.update(proc.stdout.split()[1:2] if proc.returncode == 0 else ())
            except (OSError, subprocess.TimeoutExpired):
                continue
    return frozenset(blobs)


def probe_t2_boundary(
    *, allowed_signers: bytes | None, registered_keys: frozenset[str] | None, key_dirs: Sequence[Path],
    runner_env: Path, operator_key: Path | None = None, docker_socket: Path | None = None,
) -> T2Boundary:
    """ADR-0023 / ARIA-HIGH-281 — measure the T2 boundary as the running account. Decides nothing, writes nothing.

    ``allowed_signers`` is the operator allowed-signers file as committed on
    main (None when it could not be read); ``registered_keys`` the keys the
    kernel registered for the runner (None when unreadable). A fact the probe
    cannot establish is a violation: a watchdog that cannot see reports so.
    ``operator_key`` and ``docker_socket`` default to the module's paths.
    """
    operator_key = OPERATOR_SIGNING_KEY if operator_key is None else operator_key
    docker_socket = DOCKER_SOCKET if docker_socket is None else docker_socket
    identity = pwd.getpwuid(os.geteuid()).pw_name
    violations: list[str] = []
    if identity != T2_RUNNER_USER:
        violations.append(f"probe_not_run_as_{T2_RUNNER_USER}")
    if os.geteuid() == 0:
        violations.append("runner_uid_is_root")
    try:
        with operator_key.open("rb"):
            violations.append("operator_key_readable")
    except OSError:
        pass
    sudo = _sudo_verdict()
    if sudo != "denied":
        violations.append(f"sudo_{sudo}")
    if "docker" in _group_names():
        violations.append("docker_group_member")
    if docker_socket.exists() and os.access(docker_socket, os.R_OK | os.W_OK):
        violations.append("docker_socket_reachable")
    env_violation = _runner_env_violation(runner_env)
    if env_violation is not None:
        violations.append(env_violation)
    if registered_keys is None:
        violations.append("runner_key_registry_unavailable")
    if allowed_signers is None:
        violations.append("allowed_signers_unavailable")
    else:
        from .operator_request_signature import enrolled_key_blobs

        if enrolled_key_blobs(allowed_signers) & (held_key_blobs(key_dirs) | (registered_keys or frozenset())):
            violations.append("runner_key_enrolled")
    return T2Boundary(identity=identity, violations=tuple(violations))


def t2_boundary_textfile(boundary: T2Boundary, *, probed_at: float) -> str:
    """The probe's verdict in the Prometheus text format node-exporter's textfile collector reads."""
    lines = [
        "# HELP aria_t2_boundary_held 1 when the hourly T2 probe found the runner boundary intact (ADR-0023).",
        "# TYPE aria_t2_boundary_held gauge",
        f"aria_t2_boundary_held {1 if boundary.held else 0}",
        "# HELP aria_t2_boundary_violation One series per way the T2 boundary did not hold.",
        "# TYPE aria_t2_boundary_violation gauge",
        *(f'aria_t2_boundary_violation{{reason="{reason}"}} 1' for reason in boundary.violations),
        "# HELP aria_t2_boundary_probe_timestamp_seconds When the T2 probe last ran.",
        "# TYPE aria_t2_boundary_probe_timestamp_seconds gauge",
        f"aria_t2_boundary_probe_timestamp_seconds {int(probed_at)}",
    ]
    return "\n".join(lines) + "\n"
