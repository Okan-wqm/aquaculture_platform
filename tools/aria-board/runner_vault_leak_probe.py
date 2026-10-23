#!/usr/bin/env python3
"""PLAN-v2 B0 exit — the runner-identity leak probe: with what ARIA's runner uid holds, the Board's vault stays shut.

WHY (ARIA-MEDIUM-766, PLAN-v2 §1.9, B0 corrective R6). The B0 exit is "the
runner uid cannot read the vault, red to green". In-process tests cannot
show that: the vault's barrier is GitHub's access control on
``Okan-wqm/aria-board-vault``, and what decides it is which credentials the
runner's uid can USE — its ``gh`` login, its git credential helper and SSH
keys, and above all the GitHub App's private key, which mints installation
tokens WITHOUT the kernel's ``repositories`` scoping. So the probe runs AS
the runner uid, with those real credentials, and asks GitHub for the vault.

WHAT. Every credential source asks for the vault repository's metadata and is
classified ``unreachable`` (HTTP 404/403, "Repository not found"),
``no_credential`` (the uid holds no such credential), ``reachable`` (it
answered), or ``inconclusive`` (anything the probe cannot classify). The App
key source mints an UNSCOPED installation token (empty request body: every
repository the installation selects), asks, and revokes the token. The probe
also checks that the Board's data key is in neither the process environment
nor any file the uid can name (environment-file lines and file NAMES only).

Exit status: 0 GREEN — every source ran and none reached the vault, the App
key source included, and no data key is present; 1 RED — a source reached the
vault or a data key is present; 2 INCONCLUSIVE — a source could not be
classified, or the App key was not given (a probe that skipped the strongest
credential proves nothing).

The report is one JSON object on stdout: source names, classifications and
HTTP statuses. It never carries a token, a key, a JWT, a variable's value or
any command output.

Operator step (PR body): run it as the runner uid, with the App key the
runner's jobs use, and record the report as the B0 exit evidence::

    sudo -u gharunner -H python3 -I tools/aria-board/runner_vault_leak_probe.py \\
        --app-id <id> --installation-id <id> --app-private-key <pem path the uid can read> \\
        --scan-root /home/gharunner --env-file /home/gharunner/actions-runner/.env
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

# The vault's name has one owner, the Board module; it is loaded BY PATH (it
# imports the standard library and cryptography alone), never through the
# aria_kernel package.
_BOARD_MODULE = Path(__file__).resolve().parents[2] / "aria-kernel" / "aria_kernel" / "examination_board.py"
_BOARD_SPEC = importlib.util.spec_from_file_location("aria_board_examination_board", _BOARD_MODULE)
if _BOARD_SPEC is None or _BOARD_SPEC.loader is None:
    raise ImportError(f"the Board module is not loadable: {_BOARD_MODULE}")
_BOARD = importlib.util.module_from_spec(_BOARD_SPEC)
_BOARD_SPEC.loader.exec_module(_BOARD)
VAULT_REPOSITORY: str = _BOARD.VAULT_REPOSITORY
GITHUB_API = "https://api.github.com"
# GitHub's published SSH host key (docs: "GitHub's SSH key fingerprints"),
# pinned so the SSH source never trusts an unknown host and writes no
# known_hosts of the uid's.
GITHUB_SSH_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
COMMAND_TIMEOUT_SECONDS = 30
# File-name markers of Board material; a file whose name carries one is reported by path.
_DATA_KEY_NAME_MARKERS = ("aria-board", "aria_board", "board-vault", "board_vault")
_SCAN_SKIP_DIRS = frozenset({".git", "node_modules", "_work", ".cache", ".npm", ".cargo", ".rustup", "_diag"})
_SCAN_MAX_DEPTH = 6

UNREACHABLE = "unreachable"
NO_CREDENTIAL = "no_credential"
REACHABLE = "reachable"
INCONCLUSIVE = "inconclusive"


@dataclass(frozen=True)
class Reach:
    """One source's answer: a classification, the HTTP status when there was one, a short fixed reason."""

    source: str
    status: str
    http: int | None = None
    reason: str = ""

    def report(self) -> dict[str, Any]:
        return {"source": self.source, "status": self.status, "http": self.http, "reason": self.reason}


class CredentialSource(Protocol):
    name: str

    def reach(self, repository: str) -> Reach: ...


def _http_status_reach(name: str, status: int) -> Reach:
    if status in (403, 404):
        return Reach(name, UNREACHABLE, status, "github_refused")
    if 200 <= status < 300:
        return Reach(name, REACHABLE, status, "github_answered")
    return Reach(name, INCONCLUSIVE, status, "unexpected_status")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def app_jwt(app_id: str, private_key_pem: bytes, *, now: float | None = None) -> str:
    """The App's RS256 JWT (GitHub: iat 60 s back for clock drift, at most 10 min of life)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    issued = int(now if now is not None else time.time()) - 60
    signing_input = ".".join((
        _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode()),
        _b64url(json.dumps({"iat": issued, "exp": issued + 540, "iss": str(app_id)},
                           separators=(",", ":")).encode()),
    )).encode("ascii")
    key = serialization.load_pem_private_key(private_key_pem, password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("the App private key is not an RSA key")
    return signing_input.decode("ascii") + "." + _b64url(key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256()))


Opener = Callable[[urllib.request.Request], Any]


def _open(request: urllib.request.Request) -> Any:
    return urllib.request.urlopen(request, timeout=COMMAND_TIMEOUT_SECONDS)  # allowlist-external-network: the probe's purpose is to ask GitHub, as the runner uid, for the Board vault


def _request(url: str, *, method: str, authorization: str, body: bytes | None = None) -> urllib.request.Request:
    return urllib.request.Request(url, data=body, method=method, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": authorization,
        "User-Agent": "aria-board-runner-leak-probe",
        "X-GitHub-Api-Version": "2022-11-28",
    })


class AppPrivateKeySource:
    """The App's private key, used as anything holding it can: an unscoped installation token."""

    name = "app_private_key_unscoped_token"

    def __init__(self, *, app_id: str, installation_id: str, private_key_path: Path,
                 opener: Opener = _open, api: str = GITHUB_API) -> None:
        self.app_id, self.installation_id, self.private_key_path = app_id, installation_id, private_key_path
        self.opener, self.api = opener, api

    def reach(self, repository: str) -> Reach:
        try:
            jwt = app_jwt(self.app_id, self.private_key_path.read_bytes())
        except (OSError, ValueError, TypeError):
            return Reach(self.name, INCONCLUSIVE, None, "app_key_unusable")
        mint = _request(f"{self.api}/app/installations/{self.installation_id}/access_tokens", method="POST",
                        authorization=f"Bearer {jwt}", body=b"{}")
        try:
            with self.opener(mint) as response:
                token = json.loads(response.read().decode("utf-8")).get("token")
        except urllib.error.HTTPError as exc:
            return Reach(self.name, INCONCLUSIVE, exc.code, "mint_refused")
        except (urllib.error.URLError, OSError, ValueError):
            return Reach(self.name, INCONCLUSIVE, None, "mint_unreachable")
        if not isinstance(token, str) or not token:
            return Reach(self.name, INCONCLUSIVE, None, "mint_returned_no_token")
        try:
            try:
                with self.opener(_request(f"{self.api}/repos/{repository}", method="GET",
                                          authorization=f"token {token}")) as response:
                    return _http_status_reach(self.name, int(response.status))
            except urllib.error.HTTPError as exc:
                return _http_status_reach(self.name, exc.code)
            except (urllib.error.URLError, OSError):
                return Reach(self.name, INCONCLUSIVE, None, "github_unreachable")
        finally:
            try:
                with self.opener(_request(f"{self.api}/installation/token", method="DELETE",
                                          authorization=f"token {token}")):
                    pass
            except (urllib.error.URLError, OSError):
                # The provider's one-hour expiry bounds a token whose revoke failed.
                pass


def _run(command: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS,
                              env=env, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


class GhCliSource:
    """The uid's ``gh`` login (hosts.yml) or a GH_TOKEN/GITHUB_TOKEN in its environment."""

    name = "gh_cli"

    def __init__(self, *, gh_cli: str = "gh", env: dict[str, str] | None = None) -> None:
        self.gh_cli, self.env = gh_cli, dict(os.environ if env is None else env)

    def reach(self, repository: str) -> Reach:
        done = _run([self.gh_cli, "api", f"repos/{repository}"], env=self.env)
        if done is None:
            return Reach(self.name, NO_CREDENTIAL, None, "gh_not_installed")
        if done.returncode == 0:
            return Reach(self.name, REACHABLE, 200, "github_answered")
        err = done.stderr
        for code in (404, 403):
            if f"HTTP {code}" in err:
                return Reach(self.name, UNREACHABLE, code, "github_refused")
        if "gh auth login" in err or "not logged" in err.lower() or "HTTP 401" in err:
            return Reach(self.name, NO_CREDENTIAL, None, "gh_not_authenticated")
        return Reach(self.name, INCONCLUSIVE, None, "gh_unclassified_failure")


class GitRemoteSource:
    """The uid's git credentials: the HTTPS credential helper, or its SSH keys."""

    def __init__(self, *, transport: str, git_cli: str = "git", env: dict[str, str] | None = None) -> None:
        if transport not in ("https", "ssh"):
            raise ValueError(transport)
        self.transport, self.git_cli = transport, git_cli
        self.env = dict(os.environ if env is None else env)
        self.name = f"git_{transport}"

    def reach(self, repository: str) -> Reach:
        env = dict(self.env, GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="/bin/false", SSH_ASKPASS="/bin/false")
        with tempfile.TemporaryDirectory(prefix="aria-leak-probe-") as scratch:
            if self.transport == "https":
                url = f"https://github.com/{repository}.git"
            else:
                known_hosts = Path(scratch) / "known_hosts"
                known_hosts.write_text(GITHUB_SSH_HOST_KEY + "\n", encoding="utf-8")
                env["GIT_SSH_COMMAND"] = (f"ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes"
                                          f" -o UserKnownHostsFile={known_hosts} -o HostKeyAlgorithms=ssh-ed25519")
                url = f"git@github.com:{repository}.git"
            done = _run([self.git_cli, "ls-remote", "--heads", url], env=env)
        if done is None:
            return Reach(self.name, INCONCLUSIVE, None, "git_unavailable")
        if done.returncode == 0:
            return Reach(self.name, REACHABLE, None, "git_listed_refs")
        err = done.stderr.lower()
        if "repository not found" in err or "not found" in err:
            return Reach(self.name, UNREACHABLE, 404, "github_refused")
        if "403" in err or ("permission to" in err and "denied" in err):
            return Reach(self.name, UNREACHABLE, 403, "github_refused")
        if ("could not read username" in err or "terminal prompts disabled" in err
                or "authentication failed" in err or "permission denied (publickey)" in err):
            return Reach(self.name, NO_CREDENTIAL, None, "git_no_credential")
        return Reach(self.name, INCONCLUSIVE, None, "git_unclassified_failure")


def data_key_findings(*, environ: dict[str, str], env_files: list[Path], scan_roots: list[Path]) -> list[str]:
    """Where the Board's data key could be: env NAMES, env-file KEY names, file PATHS. Never a value."""
    findings = [f"environment:{name}" for name in sorted(environ) if name.startswith("ARIA_BOARD_")]
    for env_file in env_files:
        try:
            lines = env_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        findings += [f"env_file:{env_file}:{line.split('=', 1)[0].strip()}" for line in lines
                     if line.split("=", 1)[0].strip().removeprefix("export ").strip().startswith("ARIA_BOARD_")]
    for root in scan_roots:
        base_depth = len(root.parts)
        for directory, subdirs, files in os.walk(root, onerror=lambda _error: None):
            depth = len(Path(directory).parts) - base_depth
            subdirs[:] = [] if depth >= _SCAN_MAX_DEPTH else [d for d in subdirs if d not in _SCAN_SKIP_DIRS]
            findings += [f"file:{Path(directory) / name}" for name in [*files, *subdirs]
                         if any(marker in name.lower() for marker in _DATA_KEY_NAME_MARKERS)]
    return findings


def run_probe(sources: list[CredentialSource], *, data_key: list[str], repository: str = VAULT_REPOSITORY,
              require: tuple[str, ...] = (AppPrivateKeySource.name,)) -> tuple[int, dict[str, Any]]:
    """(exit status, report) for ``sources`` and the data-key findings; see the module docstring."""
    reaches = [source.reach(repository) for source in sources]
    names = {reach.source for reach in reaches}
    missing = [name for name in require if name not in names]
    if any(reach.status == REACHABLE for reach in reaches) or data_key:
        verdict, status = "red", 1
    elif missing or any(reach.status == INCONCLUSIVE for reach in reaches):
        verdict, status = "inconclusive", 2
    else:
        verdict, status = "green", 0
    return status, {
        "probe": "aria-board runner-identity leak probe",
        "repository": repository,
        "uid": os.getuid(),
        "verdict": verdict,
        "sources": [reach.report() for reach in reaches],
        "required_sources_missing": missing,
        "data_key_findings": data_key,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app-id")
    parser.add_argument("--installation-id")
    parser.add_argument("--app-private-key", type=Path, help="path to the App PEM the runner's jobs use")
    parser.add_argument("--env-file", type=Path, action="append", default=[],
                        help="an environment file the runner service loads (key names are read, never values)")
    parser.add_argument("--scan-root", type=Path, action="append", default=[],
                        help="a directory whose file NAMES are searched for Board material")
    args = parser.parse_args(argv)
    sources: list[CredentialSource] = [GhCliSource(), GitRemoteSource(transport="https"),
                                       GitRemoteSource(transport="ssh")]
    if args.app_id and args.installation_id and args.app_private_key:
        sources.insert(0, AppPrivateKeySource(app_id=args.app_id, installation_id=args.installation_id,
                                              private_key_path=args.app_private_key))
    findings = data_key_findings(environ=dict(os.environ), env_files=args.env_file, scan_roots=args.scan_root)
    status, report = run_probe(sources, data_key=findings)
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
