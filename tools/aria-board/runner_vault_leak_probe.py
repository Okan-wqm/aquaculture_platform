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
classified ``unreachable`` (HTTP 404, "Repository not found": GitHub's answer
to a credential that cannot see a private repository), ``no_credential`` (the
uid holds no such credential), ``reachable`` (it answered), or
``inconclusive`` (anything else — a 403 included: a rate limit or a block
says nothing about the vault). The App key source mints an UNSCOPED
installation token (empty request body: every repository the installation
selects) and proves it first: it asks for THIS repository (the operators
policy's ``repository``, which the ARIA installation must reach), and counts
the vault's 404 only after that answered 200 — a token minted for the wrong
installation 404s on everything and proves nothing. Then it revokes the
token. The probe also checks that the Board's data key is in neither the
process environment nor any file the uid can name (environment-file lines and
file NAMES only).

THE JOB'S ENVIRONMENT (B0 corrective round 2, R2-2). The actions runner
exports its ``.env`` file — and the runner service exports its systemd
``EnvironmentFile`` files — into every job it runs, so a ``GH_TOKEN`` or
``GITHUB_TOKEN`` there is a credential ARIA's jobs hold. ``sudo -u gharunner
-H`` resets the environment, so the probe's own ``os.environ`` lacks them: the
gh and git sources therefore run with ``os.environ`` overlaid by every
``--env-file``'s ``KEY=VALUE`` lines (an ``export`` prefix and surrounding
quotes allowed; blank lines and ``#``/``;`` comments skipped). The values stay
in this process's memory; the report names an env file's Board keys and, for a
line that does not parse, its line NUMBER only — never its text. An env file
that cannot be read or holds such a line leaves the probe inconclusive.

EVERY gh CREDENTIAL, EACH ALONE (B0 corrective round 3, R3-4). gh prefers
``GH_TOKEN``, then ``GITHUB_TOKEN``, over its stored ``hosts.yml`` login, so
one gh call in the job's environment asks only the first of them: a revoked
token there would hide a stored login that reaches the vault. gh is asked once
per credential, each its own source: ``gh_cli:stored`` (no gh token variable;
see below for where it looks), and ``gh_cli:GH_TOKEN`` and
``gh_cli:GITHUB_TOKEN`` (each when the job's environment sets it, with that
token alone). Any of them reaching the vault is red.

EVERY PLACE A STORED LOGIN LIVES (B0 corrective round 4, R4-3). The uid's
stored gh login and git credential helper live under its passwd home, and a
job's code can always reach them there; an env file's ``GH_CONFIG_DIR``,
``XDG_CONFIG_HOME``, ``HOME`` or ``GIT_CONFIG_GLOBAL`` only moves where the
tool looks, and ``GH_HOST`` moves gh to another host. So ``gh_cli:stored`` and
``git_https:stored`` ask the passwd home's default place (``HOME`` from the
passwd entry, none of those variables), each place the job's environment names
is asked alone as ``<source>:stored:<VARIABLE>`` (its value never reported),
and no gh source carries ``GH_HOST``.

Exit status: 0 GREEN — every source ran and none reached the vault, the App
key source included, and no data key is present; 1 RED — a source reached the
vault or a data key is present; 2 INCONCLUSIVE — a source could not be
classified, the App key was not given (a probe that skipped the strongest
credential proves nothing), or an env file could not be read whole.

The report is one JSON object on stdout: source names, classifications and
HTTP statuses. It never carries a token, a key, a JWT, a variable's value or
any command output.

Operator step (PR body): run it as the runner uid, with the App key the
runner's jobs use, passing the runner's ``.env`` AND every ``EnvironmentFile``
its systemd unit loads (``systemctl cat 'actions.runner.*'`` lists the
unit's ``EnvironmentFile=`` lines; a leading ``-`` only marks one optional),
and record the report as the B0 exit evidence::

    sudo -u gharunner -H python3 -I tools/aria-board/runner_vault_leak_probe.py \\
        --app-id <id> --installation-id <id> --app-private-key <pem path the uid can read> \\
        --scan-root /home/gharunner --env-file /home/gharunner/actions-runner/.env \\
        --env-file <each EnvironmentFile of the runner unit>

Variables the unit sets inline (``systemctl show -p Environment``), and an
``EnvironmentFile`` only root can read (systemd reads it before dropping to
the runner uid; the probe reports it ``unreadable``, inconclusive), are passed
the same way: copied, by the operator, to a file the runner uid alone can read
(owner gharunner, mode 0600, removed after the run), given as one more
``--env-file``.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import pwd
import re
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
# The App source's positive control: the repository the ARIA installation
# exists for. Read from the operators policy file as data (the kernel's loader,
# operator_approval.load_operators_policy, imports the whole kernel); the test
# pins that both readings name the same repository.
_OPERATORS_POLICY = Path(__file__).resolve().parents[2] / "docs" / "aria" / "policy" / "operators.json"
CONTROL_REPOSITORY: str = json.loads(_OPERATORS_POLICY.read_text(encoding="utf-8"))["repository"]
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
    if status == 404:
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
                 opener: Opener = _open, api: str = GITHUB_API, control_repository: str = CONTROL_REPOSITORY) -> None:
        self.app_id, self.installation_id, self.private_key_path = app_id, installation_id, private_key_path
        self.opener, self.api, self.control_repository = opener, api, control_repository

    def _get_status(self, repository: str, token: str) -> int | None:
        """GitHub's HTTP status for the repository's metadata, or None when GitHub was not reached."""
        try:
            with self.opener(_request(f"{self.api}/repos/{repository}", method="GET",
                                      authorization=f"token {token}")) as response:
                return int(response.status)
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, OSError):
            return None

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
            control = self._get_status(self.control_repository, token)
            vault = self._get_status(repository, token)
            if vault is None:
                return Reach(self.name, INCONCLUSIVE, None, "github_unreachable")
            if vault == 404 and control != 200:
                # The token reaches nothing it must reach: a vault 404 proves nothing.
                return Reach(self.name, INCONCLUSIVE, control, "control_repository_not_answered")
            return _http_status_reach(self.name, vault)
        finally:
            try:
                with self.opener(_request(f"{self.api}/installation/token", method="DELETE",
                                          authorization=f"token {token}")):
                    pass
            except (urllib.error.URLError, OSError):
                # The provider's one-hour expiry bounds a token whose revoke failed.
                pass


def _run(command: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str] | None:
    """The command's answer, or None when it did not run to an answer (it could not start, or timed out).

    B0 corrective round 3, R3-5: None is one reading for every source — the
    command said nothing about the credential, so the source is
    ``inconclusive``; ``no_credential`` comes only from the tool's own answer.
    """
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS,
                              env=env, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


def uid_home() -> str:
    """The runner uid's home as its passwd entry names it (B0 corrective round 4, R4-3).

    gh and git keep the uid's stored login under it by default, and a job's
    code can always reach it there, whatever ``HOME`` the runner's env files
    or the probe's own environment set; so the probe never takes it from an
    environment.
    """
    return pwd.getpwuid(os.getuid()).pw_dir


def job_named_locations(env: dict[str, str], locations: tuple[str, ...]) -> list[str]:
    """The ``locations`` variables ``env`` sets: each a place, other than the default, a job may also keep a login.

    ``HOME`` counts only when it is not the passwd home, the default place itself.
    """
    home = uid_home()
    return [name for name in locations if env.get(name) and not (name == "HOME" and env[name] == home)]


def stored_login_environment(env: dict[str, str], *, locations: tuple[str, ...], location: str | None = None,
                             dropped: tuple[str, ...] = ()) -> dict[str, str]:
    """``env`` made to ask a tool for the uid's stored login: at its default place, or at one job-named ``location``.

    THE one rule for every stored-login source (B0 corrective round 4, R4-3):
    none of ``locations`` (the variables that move where the tool reads its
    login) and none of ``dropped`` stays, and ``HOME`` is the passwd home
    (:func:`uid_home`); with ``location``, that one variable comes back with
    ``env``'s value, so each place is asked alone and none hides another.
    """
    asked = {key: value for key, value in env.items() if key not in locations and key not in dropped}
    asked["HOME"] = uid_home()
    if location is not None:
        asked[location] = env[location]
    return asked


# gh reads these before its hosts.yml login (GH_TOKEN, then GITHUB_TOKEN, for
# github.com; the enterprise pair for a GH_HOST); any one present shadows it.
_GH_TOKEN_VARIABLES = ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")
# The tokens gh would use for github.com, each asked on its own.
_GH_TOKEN_CREDENTIALS = ("GH_TOKEN", "GITHUB_TOKEN")
GH_STORED_LOGIN = "stored"
# Where gh reads its hosts.yml: GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else $HOME/.config/gh.
_GH_LOGIN_LOCATIONS = ("GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME")
# GH_HOST sends every gh call to another host; each gh source asks github.com.
_GH_HOST = "GH_HOST"
# Where git reads the uid's global config, its credential helper included:
# GIT_CONFIG_GLOBAL, else $HOME/.gitconfig and $XDG_CONFIG_HOME/git/config.
_GIT_LOGIN_LOCATIONS = ("GIT_CONFIG_GLOBAL", "XDG_CONFIG_HOME", "HOME")


class GhCliSource:
    """One credential gh would use, asked alone: the uid's stored login (hosts.yml) at one place, or one token.

    B0 corrective round 3, R3-4. gh prefers GH_TOKEN, then GITHUB_TOKEN, over
    its stored login, so one gh call with every variable present asks only
    the first; a revoked or blind token would hide a stored login that
    reaches the vault. Each credential therefore runs in an environment
    holding it and no other: a token with that one variable alone, the
    stored login without any of :data:`_GH_TOKEN_VARIABLES`.

    Round 4, R4-3: GH_CONFIG_DIR, XDG_CONFIG_HOME and HOME move where gh
    reads hosts.yml, and GH_HOST moves every call to another host, so an env
    file setting one hid the login under the uid's passwd home, which a job's
    code can still use. ``stored`` therefore asks the passwd home's default
    place (:func:`stored_login_environment`), each place the job's
    environment names is asked alone as ``stored:<VARIABLE>`` (its value is
    never reported), and no gh source carries GH_HOST.
    """

    def __init__(self, *, env: dict[str, str], gh_cli: str = "gh", credential: str = GH_STORED_LOGIN,
                 location: str | None = None) -> None:
        self.gh_cli = gh_cli
        if credential == GH_STORED_LOGIN and (location is None or location in _GH_LOGIN_LOCATIONS):
            self.env = stored_login_environment(env, locations=_GH_LOGIN_LOCATIONS, location=location,
                                                dropped=(*_GH_TOKEN_VARIABLES, _GH_HOST))
            self.name = f"gh_cli:{credential}" + (f":{location}" if location is not None else "")
        elif credential in _GH_TOKEN_CREDENTIALS and location is None:
            self.env = {key: value for key, value in env.items() if key not in (*_GH_TOKEN_VARIABLES, _GH_HOST)}
            self.env[credential] = env[credential]
            self.name = f"gh_cli:{credential}"
        else:
            raise ValueError(f"{credential}:{location}")

    @classmethod
    def every_credential(cls, *, env: dict[str, str], gh_cli: str = "gh") -> list["GhCliSource"]:
        """A source per credential gh would use under ``env``: the stored login at each place, and each token."""
        return [cls(env=env, gh_cli=gh_cli),
                *(cls(env=env, gh_cli=gh_cli, location=name) for name in job_named_locations(env, _GH_LOGIN_LOCATIONS)),
                *(cls(env=env, gh_cli=gh_cli, credential=name) for name in _GH_TOKEN_CREDENTIALS if env.get(name))]

    def reach(self, repository: str) -> Reach:
        done = _run([self.gh_cli, "api", f"repos/{repository}"], env=self.env)
        if done is None:
            return Reach(self.name, INCONCLUSIVE, None, "gh_unavailable")
        if done.returncode == 0:
            return Reach(self.name, REACHABLE, 200, "github_answered")
        err = done.stderr
        if "HTTP 404" in err:
            return Reach(self.name, UNREACHABLE, 404, "github_refused")
        if "gh auth login" in err or "not logged" in err.lower() or "HTTP 401" in err:
            return Reach(self.name, NO_CREDENTIAL, None, "gh_not_authenticated")
        return Reach(self.name, INCONCLUSIVE, None, "gh_unclassified_failure")


class GitRemoteSource:
    """The uid's git credentials: the HTTPS credential helper at one config place, or its SSH keys.

    B0 corrective round 4, R4-3 (the appellate's measuring test): an env-file
    HOME or GIT_CONFIG_GLOBAL moves where git reads the uid's global config,
    and so hid the credential helper in the passwd home's ``.gitconfig``. The
    HTTPS source takes the rule the gh source takes
    (:func:`stored_login_environment`): ``git_https:stored`` asks the passwd
    home's default config, and each place the job's environment names is
    asked alone as ``git_https:stored:<VARIABLE>``. SSH keys are read from
    the passwd home by ssh itself, whatever HOME says.
    """

    def __init__(self, *, transport: str, env: dict[str, str], git_cli: str = "git",
                 location: str | None = None) -> None:
        self.transport, self.git_cli = transport, git_cli
        if transport == "https" and (location is None or location in _GIT_LOGIN_LOCATIONS):
            self.env = stored_login_environment(env, locations=_GIT_LOGIN_LOCATIONS, location=location)
            self.name = "git_https:stored" + (f":{location}" if location is not None else "")
        elif transport == "ssh" and location is None:
            self.env = dict(env)
            self.name = "git_ssh"
        else:
            raise ValueError(f"{transport}:{location}")

    @classmethod
    def every_credential(cls, *, env: dict[str, str], git_cli: str = "git") -> list["GitRemoteSource"]:
        """A source per place git keeps an HTTPS credential under ``env``, and the SSH keys."""
        return [cls(transport="https", env=env, git_cli=git_cli),
                *(cls(transport="https", env=env, git_cli=git_cli, location=name)
                  for name in job_named_locations(env, _GIT_LOGIN_LOCATIONS)),
                cls(transport="ssh", env=env, git_cli=git_cli)]

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
        if "repository not found" in err:
            return Reach(self.name, UNREACHABLE, 404, "github_refused")
        if ("could not read username" in err or "terminal prompts disabled" in err
                or "authentication failed" in err or "permission denied (publickey)" in err):
            return Reach(self.name, NO_CREDENTIAL, None, "git_no_credential")
        return Reach(self.name, INCONCLUSIVE, None, "git_unclassified_failure")


_ENV_LINE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


@dataclass(frozen=True)
class EnvFile:
    """One env file as the runner exports it: its KEY=VALUE pairs (in memory only) and what did not parse."""

    path: Path
    pairs: tuple[tuple[str, str], ...]
    problems: tuple[str, ...]


def read_env_file(path: Path) -> EnvFile:
    """The one parser of a runner env file; a problem names the file and a line NUMBER, never a line's text."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return EnvFile(path, (), (f"env_file:{path}:unreadable",))
    pairs: list[tuple[str, str]] = []
    problems: list[str] = []
    for number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        match = _ENV_LINE.match(line)
        if match is None:
            problems.append(f"env_file:{path}:line {number}:unparsable")
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        pairs.append((match.group(1), value))
    return EnvFile(path, tuple(pairs), tuple(problems))


def job_environment(*, environ: dict[str, str], env_files: list[EnvFile]) -> dict[str, str]:
    """What an ARIA job's process sees: ``environ`` overlaid with each env file, later files winning."""
    env = dict(environ)
    for env_file in env_files:
        env.update(env_file.pairs)
    return env


def data_key_findings(*, environ: dict[str, str], env_files: list[EnvFile], scan_roots: list[Path]) -> list[str]:
    """Where the Board's data key could be: env NAMES, env-file KEY names, file PATHS. Never a value."""
    findings = [f"environment:{name}" for name in sorted(environ) if name.startswith("ARIA_BOARD_")]
    findings += [f"env_file:{env_file.path}:{key}" for env_file in env_files for key, _value in env_file.pairs
                 if key.startswith("ARIA_BOARD_")]
    for root in scan_roots:
        base_depth = len(root.parts)
        for directory, subdirs, files in os.walk(root, onerror=lambda _error: None):
            depth = len(Path(directory).parts) - base_depth
            subdirs[:] = [] if depth >= _SCAN_MAX_DEPTH else [d for d in subdirs if d not in _SCAN_SKIP_DIRS]
            findings += [f"file:{Path(directory) / name}" for name in [*files, *subdirs]
                         if any(marker in name.lower() for marker in _DATA_KEY_NAME_MARKERS)]
    return findings


def run_probe(sources: list[CredentialSource], *, data_key: list[str], environment_problems: list[str] | None = None,
              repository: str = VAULT_REPOSITORY,
              require: tuple[str, ...] = (AppPrivateKeySource.name,)) -> tuple[int, dict[str, Any]]:
    """(exit status, report) for ``sources``, the data-key findings and the env files' problems; see the docstring."""
    reaches = [source.reach(repository) for source in sources]
    names = {reach.source for reach in reaches}
    missing = [name for name in require if name not in names]
    problems = list(environment_problems or [])
    if any(reach.status == REACHABLE for reach in reaches) or data_key:
        verdict, status = "red", 1
    elif missing or problems or any(reach.status == INCONCLUSIVE for reach in reaches):
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
        "environment_problems": problems,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app-id")
    parser.add_argument("--installation-id")
    parser.add_argument("--app-private-key", type=Path, help="path to the App PEM the runner's jobs use")
    parser.add_argument("--env-file", type=Path, action="append", default=[],
                        help="an environment file the runner exports into its jobs (.env, a systemd "
                             "EnvironmentFile); its values reach gh and git in memory and are never reported")
    parser.add_argument("--scan-root", type=Path, action="append", default=[],
                        help="a directory whose file NAMES are searched for Board material")
    args = parser.parse_args(argv)
    env_files = [read_env_file(path) for path in args.env_file]
    job_env = job_environment(environ=dict(os.environ), env_files=env_files)
    sources: list[CredentialSource] = [*GhCliSource.every_credential(env=job_env),
                                       *GitRemoteSource.every_credential(env=job_env)]
    if args.app_id and args.installation_id and args.app_private_key:
        sources.insert(0, AppPrivateKeySource(app_id=args.app_id, installation_id=args.installation_id,
                                              private_key_path=args.app_private_key))
    findings = data_key_findings(environ=dict(os.environ), env_files=env_files, scan_roots=args.scan_root)
    status, report = run_probe(sources, data_key=findings,
                               environment_problems=[problem for env_file in env_files for problem in env_file.problems])
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
