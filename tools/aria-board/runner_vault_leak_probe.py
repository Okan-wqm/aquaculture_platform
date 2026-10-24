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

SCOPE (program-lead decision, B0 round 6, 2026-10-24). The vault's CONTROL is
that its deploy key exists only in the GitHub-hosted ``aria-board``
environment, never on the droplet; this probe is point-in-time EVIDENCE of
that control, not the control. What it must not miss is a PASSIVE,
PERSISTENT lever: anything the runner uid holds or configures that makes a
run read no-reach (green) while a credential that reaches the vault exists
for the uid, with no process acting during the run (an env-file line, a
config file, a binary on a PATH). Active evasion — a process moving a key or
``hosts.yml`` aside, or racing the probe, while it runs — is outside what a
point-in-time measurement can exclude; it is a tracked finding of the
program, not a property this probe claims. Hence the operator step below: the
run counts as evidence only with no runner job in flight.

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

AN ALLOW-LIST, NOT A DENY-LIST (B0 corrective round 5, R5-3). git also takes
its configuration from the environment (``GIT_CONFIG_COUNT``/``KEY_n``/
``VALUE_n``, ``GIT_CONFIG_PARAMETERS``, ``GIT_EXEC_PATH`` and more), so a list
of job variables to drop always missed one: an env-file reset of
``credential.helper`` hid the passwd home's helper, and an env-file
``url.insteadOf`` moved ``git_ssh`` off ssh. Every source asked alone — each
gh and git stored source, https and ssh, and each gh token — therefore runs
under one named base, :data:`_CREDENTIAL_BASE` (``PATH``, ``LANG``, ``LC_*``)
with ``HOME`` from the passwd entry, plus the ONE job variable it asks (a
place, ``SSH_AUTH_SOCK``, or a token); no other job variable reaches it.
No git source is handed an askpass of the probe's: each runs with
``GIT_TERMINAL_PROMPT=0`` (a job has no terminal either), so an askpass git
finds is asked, and none found reads as no credential.

EVERY JOB GIT CREDENTIAL, EACH ALONE (B0 corrective round 6, R6-1). Round 5
asked the job's own git credentials in one call, ``git_https:job``; but git
asks every configured credential helper before any askpass, and the probe's
own ``GIT_SSH_COMMAND`` overrode every ssh command a job names, so a working
job credential hid behind a revoked one or was never asked — the R3-4 class
on the git side. Each env-borne git credential of the job is now its own
source, under the named base plus :data:`CONFIG_FILES_OFF` (no config file
answers first): ``git_https:GIT_ASKPASS``, ``git_https:SSH_ASKPASS``,
``git_ssh:GIT_SSH_COMMAND`` and ``git_ssh:GIT_SSH`` (each when set;
:data:`JOB_GIT_CREDENTIALS`), and ``git_<transport>:GIT_CONFIG:<n>`` for each
env-borne ``credential.helper``, ``credential.<url>.helper``,
``core.askPass`` or ``core.sshCommand`` entry, which git itself lists
(:func:`job_git_config_entries`) and which is set alone as
``GIT_CONFIG_COUNT=1`` — its value only ever in that child's environment.
``git_https:job`` and ``git_ssh:job`` (the job's environment exactly as a job
sees it, no probe ``GIT_SSH_COMMAND``) stay as composites in addition. Every
child runs with no stdin in its own session, so a job's ssh command or
askpass cannot prompt on the operator's terminal; only the probe's own ssh
sources pin GitHub's host key, and under a job's ssh command an unknown host
key fails, read as inconclusive.

NO CONFIG FILE MOVES THE PROBE'S SSH (B0 corrective round 6, R6-2). The
allow-list keeps the environment from moving ``git_ssh``, but git also reads
its config FILES — ``/etc/gitconfig`` and the passwd home's ``.gitconfig`` —
and a common ``url.<x>.insteadOf = git@github.com:`` there rewrote the
probe's ssh URL with no env file at all, while a job bypassing that config
reached the vault with the uid's key. Those files hold no ssh credential for
these sources (ssh reads ``~/.ssh`` itself; the probe's ``GIT_SSH_COMMAND``
overrides ``core.sshCommand``), so ``git_ssh`` and ``git_ssh:SSH_AUTH_SOCK``
carry :data:`CONFIG_FILES_OFF` (``GIT_CONFIG_GLOBAL=/dev/null``,
``GIT_CONFIG_NOSYSTEM=1``) beside their ``GIT_SSH_COMMAND`` pin.
``git_https:stored*`` never carries it: its config file is the place it asks.

NO REPOSITORY'S CONFIG REACHES A GIT CHILD (B0 corrective round 7, R7-3).
git reads a repository's ``.git/config`` as local config whatever
``GIT_CONFIG_GLOBAL`` says, and it finds that repository by climbing from its
working directory: the operator runs the probe from a checkout, and a
``/tmp/.git`` (or ``/tmp`` laid out as a bare repository) that the uid's own
``safe.directory`` admits sits above any scratch directory under ``/tmp``. Its
empty ``credential.helper`` cleared the stored helper, and its ``insteadOf``
moved ``git_ssh`` off ssh. Every git child therefore runs in a fresh scratch
directory with ``GIT_CEILING_DIRECTORIES`` set to that directory's parent
(:func:`outside_any_repository`, the one place both are chosen; a job's own
value is replaced in the ``:job`` composites too), so git looks for a
repository in the scratch directory alone and finds none.

THE PROBE'S OWN TOOLS (B0 corrective round 6, R6-3). The runner's ``.env``
is the runner uid's to write, so a ``PATH`` in it could put a directory of
its own first and replace every bare ``gh``, ``git`` or ``ssh`` the probe ran
— a stored login that reaches the vault would then read 404, green. Before
any env file is read, :func:`trusted_tools` resolves ``gh``, ``git`` and
``ssh`` to absolute paths from the probe's OWN ``PATH`` (sudo's
``secure_path``), and every source runs those (:class:`ProbeTools` refuses a
relative one); a tool that does not resolve is the named environment problem
``tool_missing:<name>``, inconclusive. The job's ``PATH`` stays in the base:
it decides only what a job's own helper, askpass or ssh command resolves to,
as it does for a job's git.

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
and record the report as the B0 exit evidence, with no runner job in flight
(see SCOPE)::

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
import contextlib
import importlib.util
import json
import os
import pwd
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

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


def _run(command: list[str], *, env: dict[str, str],
         cwd: str | None = None) -> subprocess.CompletedProcess[str] | None:
    """The command's answer, or None when it did not run to an answer (it could not start, or timed out).

    B0 corrective round 3, R3-5: None is one reading for every source — the
    command said nothing about the credential, so the source is
    ``inconclusive``; ``no_credential`` comes only from the tool's own answer.
    Round 6, R6-1: the probe now runs a job's own askpass, helper and ssh
    command, so every child gets no stdin and its own session: none can
    prompt on the operator's terminal (a job has none either).
    """
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS,
                              env=env, cwd=cwd, check=False, stdin=subprocess.DEVNULL, start_new_session=True)
    except (OSError, subprocess.TimeoutExpired):
        return None


@contextlib.contextmanager
def outside_any_repository() -> Iterator[tuple[str, dict[str, str]]]:
    """THE working directory of every git child the probe runs, with the environment that keeps git inside it.

    B0 corrective round 7, R7-3: git discovery climbs from its working
    directory, so a fresh scratch directory alone is not outside every
    repository — an ancestor's ``.git`` (``/tmp/.git`` admitted by the uid's
    own ``safe.directory``) is local config to it. ``GIT_CEILING_DIRECTORIES``
    set to the scratch directory's parent stops git from climbing into the
    parent, so it looks in the scratch directory alone, which holds no
    repository. Yields ``(scratch, environment addition)``; every git child
    takes both, the addition last, so a job's own value is replaced.
    """
    with tempfile.TemporaryDirectory(prefix="aria-leak-probe-") as scratch:
        yield scratch, {"GIT_CEILING_DIRECTORIES": os.path.dirname(scratch)}


# The binaries the probe itself runs (B0 corrective round 6, R6-3).
PROBE_TOOLS = ("gh", "git", "ssh")


@dataclass(frozen=True)
class ProbeTools:
    """The gh, git and ssh the probe itself runs: absolute paths from the probe's OWN ``PATH`` (round 6, R6-3).

    The runner's ``.env`` is the runner uid's to write, and a job's ``PATH``
    comes from it, so a bare ``gh``, ``git`` or ``ssh`` looked up through the
    job's ``PATH`` is whatever a uid-writable directory first on it holds — a
    stored login that reaches the vault would read 404. The probe therefore
    never runs a tool by a bare name: each source takes these paths, and a
    relative one is refused here. The job's ``PATH`` still reaches each
    source's environment: it decides what a job's OWN helper, askpass or ssh
    command resolves to, exactly as it does for a job's git.
    """

    gh: str
    git: str
    ssh: str

    def __post_init__(self) -> None:
        for tool in PROBE_TOOLS:
            if not os.path.isabs(getattr(self, tool)):
                raise ValueError(f"the probe's {tool} is not an absolute path")


def trusted_tools(path: str) -> tuple[ProbeTools | None, list[str]]:
    """The probe's tools resolved from ``path`` (the probe's own, never an env file's); ``tool_missing:<name>`` each.

    Only absolute ``path`` entries count: a relative one names whatever the
    working directory holds. ``sudo -u gharunner -H`` gives the probe sudo's
    ``secure_path``.
    """
    absolute = os.pathsep.join(entry for entry in path.split(os.pathsep) if os.path.isabs(entry))
    found = {tool: shutil.which(tool, path=absolute) for tool in PROBE_TOOLS}
    missing = [f"tool_missing:{tool}" for tool, where in found.items() if where is None]
    if missing:
        return None, missing
    return ProbeTools(**{tool: str(where) for tool, where in found.items()}), []


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


# THE named base (B0 corrective round 5, R5-3): the job variables every
# credential source asked alone takes — the PATH a job's own helper, askpass
# or ssh command resolves through (never the probe's tools: R6-3,
# ProbeTools), and the locale it speaks — and nothing else of the job's
# environment.
_CREDENTIAL_BASE = re.compile(r"PATH|LANG|LC_[A-Z_]+")


def credential_environment(env: dict[str, str], *, variable: str | None = None) -> dict[str, str]:
    """The environment a source asks ONE credential under: the named base, the passwd ``HOME``, and ``variable``.

    THE one rule for every source asked alone (B0 corrective round 4, R4-3;
    round 5, R5-3): the stored gh login and git credentials at their default
    place (no ``variable``), at one job-named place (``variable`` is the
    location: ``GH_CONFIG_DIR``, ``GIT_CONFIG_GLOBAL``, ``SSH_AUTH_SOCK`` …),
    and each gh token (``variable`` is the token). From ``env`` it keeps the
    variables :data:`_CREDENTIAL_BASE` names and that one variable; ``HOME``
    is the passwd home (:func:`uid_home`) unless ``variable`` is ``HOME``. An
    allow-list: whatever else a job's environment sets — a config reset, an
    ``insteadOf``, another token, another host — never reaches the source, so
    no place is hidden by another.
    """
    asked = {key: value for key, value in env.items() if _CREDENTIAL_BASE.fullmatch(key)}
    asked["HOME"] = uid_home()
    if variable is not None:
        asked[variable] = env[variable]
    return asked


# THE pin that keeps git's configuration FILES — the system file and the
# global one at the default place — from deciding a git source that asks a
# credential of its own (B0 corrective round 6, R6-2): the probe's ssh
# sources, whose URL an ``insteadOf`` there would rewrite. Never applied to
# the ``:job`` composites, nor to ``git_https:stored*``, whose config file is
# the place they ask.
CONFIG_FILES_OFF = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

# Each env-borne git credential a job's git uses, by the transport it serves
# (B0 corrective round 6, R6-1): git asks configured helpers before any
# askpass, and an env GIT_SSH_COMMAND overrides GIT_SSH and core.sshCommand,
# so one call under the job's env asks only the first; each is asked alone.
JOB_GIT_CREDENTIALS = {"GIT_ASKPASS": "https", "SSH_ASKPASS": "https", "GIT_SSH_COMMAND": "ssh", "GIT_SSH": "ssh"}
# git's configuration from the environment (``command`` scope): GIT_CONFIG_COUNT
# with its KEY_n/VALUE_n, and GIT_CONFIG_PARAMETERS.
_GIT_ENV_CONFIG = re.compile(r"GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_[0-9]+|VALUE_[0-9]+)")
_GIT_ENV_CONFIG_SET_BY = ("GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS")
# The source kind of one env-borne config entry asked alone: git_<transport>:GIT_CONFIG:<n>.
GIT_CONFIG_ENTRY = "GIT_CONFIG"


def credential_key_transport(key: str) -> str | None:
    """The transport a git config entry is a credential for, or None; ``key`` as git lists it.

    git lists a key with its section and name lowercased and its subsection
    as written, so ``credential.<url>.helper`` keeps its URL.
    """
    if key == "core.sshcommand":
        return "ssh"
    if key == "core.askpass" or (key.startswith("credential.") and key.endswith(".helper")):
        return "https"
    return None


@dataclass(frozen=True)
class GitConfigEntry:
    """One env-borne git config entry that is a credential: its index among git's ``command`` entries, key, value.

    The value lives in memory and in the one child's environment that asks
    it: never in argv, on disk or in the report (``repr`` omits it).
    ``None`` when git lists the key with no value.
    """

    index: int
    key: str
    value: str | None = field(repr=False)


def job_git_config_entries(env: dict[str, str], git_cli: str) -> list[GitConfigEntry] | None:
    """Each credential entry of the job's env-borne git configuration, as git itself lists them; None if git did not.

    git reads the entries (B0 corrective round 6, R6-1): ``git config --list
    -z --show-scope`` under the named base plus the job's ``GIT_CONFIG_*``
    variables alone, with :data:`CONFIG_FILES_OFF`, in
    :func:`outside_any_repository`, keeping the ``command`` scope. The index counts
    every ``command`` entry, so it names the entry's place in the job's
    configuration, never its key's URL or its value.
    """
    asked = {**credential_environment(env), **{k: v for k, v in env.items() if _GIT_ENV_CONFIG.fullmatch(k)},
             **CONFIG_FILES_OFF}
    with outside_any_repository() as (outside, discovery):
        done = _run([git_cli, "config", "--list", "-z", "--show-scope"], env={**asked, **discovery}, cwd=outside)
    if done is None or done.returncode != 0:
        return None
    fields = done.stdout.split("\0")
    if fields[-1] != "" or len(fields) % 2 != 1:
        return None
    command = [item for scope, item in zip(fields[0:-1:2], fields[1:-1:2]) if scope == "command"]
    entries: list[GitConfigEntry] = []
    for index, item in enumerate(command):
        key, newline, value = item.partition("\n")
        if credential_key_transport(key) is not None:
            entries.append(GitConfigEntry(index, key, value if newline else None))
    return entries


@dataclass(frozen=True)
class UnaskedSource:
    """A credential the probe found and could not ask: inconclusive under its own name, never silently skipped."""

    name: str
    reason: str

    def reach(self, repository: str) -> Reach:
        return Reach(self.name, INCONCLUSIVE, None, self.reason)


# The tokens gh would use for github.com, each asked on its own (gh prefers
# GH_TOKEN, then GITHUB_TOKEN, over its hosts.yml login).
_GH_TOKEN_CREDENTIALS = ("GH_TOKEN", "GITHUB_TOKEN")
GH_STORED_LOGIN = "stored"
# Where gh reads its hosts.yml: GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else $HOME/.config/gh.
_GH_LOGIN_LOCATIONS = ("GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME")
GIT_STORED_LOGIN = "stored"
# The job's own git configuration, asked as a job's git would use it.
GIT_JOB = "job"
# Where git reads the uid's global config, its credential helper included:
# GIT_CONFIG_GLOBAL, else $HOME/.gitconfig and $XDG_CONFIG_HOME/git/config.
_GIT_LOGIN_LOCATIONS = ("GIT_CONFIG_GLOBAL", "XDG_CONFIG_HOME", "HOME")
# Where ssh finds keys besides the passwd home's ~/.ssh (which it reads
# whatever HOME says): an agent's socket.
_SSH_LOGIN_LOCATIONS = ("SSH_AUTH_SOCK",)


class GhCliSource:
    """One credential gh would use, asked alone: the uid's stored login (hosts.yml) at one place, or one token.

    B0 corrective round 3, R3-4. gh prefers GH_TOKEN, then GITHUB_TOKEN, over
    its stored login, so one gh call with every variable present asks only
    the first; a revoked or blind token would hide a stored login that
    reaches the vault. Each credential therefore runs in an environment
    holding it and no other: a token with that one variable alone, the
    stored login with no gh token variable (``GH_TOKEN``, ``GITHUB_TOKEN`` or
    an enterprise one) at all.

    Round 4, R4-3: GH_CONFIG_DIR, XDG_CONFIG_HOME and HOME move where gh
    reads hosts.yml, and GH_HOST moves every call to another host, so an env
    file setting one hid the login under the uid's passwd home, which a job's
    code can still use. ``stored`` therefore asks the passwd home's default
    place, each place the job's environment names is asked alone as
    ``stored:<VARIABLE>`` (its value is never reported), and no gh source
    carries GH_HOST. Round 5, R5-3: every gh source's environment is
    :func:`credential_environment` — the named base plus its one location or
    its one token — so no other token, place or host reaches it.
    """

    def __init__(self, *, env: dict[str, str], tools: ProbeTools, credential: str = GH_STORED_LOGIN,
                 location: str | None = None) -> None:
        self.gh_cli = tools.gh
        if credential == GH_STORED_LOGIN and (location is None or location in _GH_LOGIN_LOCATIONS):
            self.env = credential_environment(env, variable=location)
            self.name = f"gh_cli:{credential}" + (f":{location}" if location is not None else "")
        elif credential in _GH_TOKEN_CREDENTIALS and location is None:
            self.env = credential_environment(env, variable=credential)
            self.name = f"gh_cli:{credential}"
        else:
            raise ValueError(f"{credential}:{location}")

    @classmethod
    def every_credential(cls, *, env: dict[str, str], tools: ProbeTools) -> list["GhCliSource"]:
        """A source per credential gh would use under ``env``: the stored login at each place, and each token."""
        return [cls(env=env, tools=tools),
                *(cls(env=env, tools=tools, location=name) for name in job_named_locations(env, _GH_LOGIN_LOCATIONS)),
                *(cls(env=env, tools=tools, credential=name) for name in _GH_TOKEN_CREDENTIALS if env.get(name))]

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
    """The uid's git credentials: the HTTPS credential at one config place, the job's own git, or the SSH keys.

    B0 corrective round 4, R4-3 (the appellate's measuring test): an env-file
    HOME or GIT_CONFIG_GLOBAL moves where git reads the uid's global config,
    and so hid the credential helper in the passwd home's ``.gitconfig``:
    ``git_https:stored`` asks the passwd home's default config, and each place
    the job's environment names is asked alone as
    ``git_https:stored:<VARIABLE>``.

    Round 5, R5-3: git reads configuration from the environment too
    (``GIT_CONFIG_COUNT``/``KEY_n``/``VALUE_n``, ``GIT_CONFIG_PARAMETERS``,
    ``GIT_EXEC_PATH`` …), so every stored source — https and ssh — runs under
    :func:`credential_environment`, the named base plus its one location, and
    no job variable can reset a helper or move ssh to another URL by
    ``insteadOf``. ``git_ssh`` reads the passwd home's keys (ssh reads them
    whatever HOME says) and ``git_ssh:SSH_AUTH_SOCK`` the agent the job's
    environment names. Round 6, R6-2: a config FILE at the default place
    could still rewrite their URL, so both also carry
    :data:`CONFIG_FILES_OFF`.

    Round 6, R6-1: each env-borne git credential of the job is its own
    source, asked alone under :func:`credential_environment` plus
    :data:`CONFIG_FILES_OFF` (no config file answers first):
    ``git_https:GIT_ASKPASS`` and ``git_https:SSH_ASKPASS``,
    ``git_ssh:GIT_SSH_COMMAND`` and ``git_ssh:GIT_SSH`` (no probe
    ``GIT_SSH_COMMAND``: the job's command decides), and one
    ``git_<transport>:GIT_CONFIG:<n>`` per env-borne ``credential.helper``,
    ``credential.<url>.helper``, ``core.askPass`` or ``core.sshCommand``
    entry (:func:`job_git_config_entries`), set alone as
    ``GIT_CONFIG_COUNT=1``. ``git_https:job`` and ``git_ssh:job`` run under
    the job's environment exactly as a job sees it, as composites IN ADDITION:
    neither is ever the only source that asks a credential. Only the probe's
    own ssh sources pin GitHub's host key; under a job's ssh command an
    unknown host key fails, read as inconclusive.
    """

    def __init__(self, *, transport: str, env: dict[str, str], tools: ProbeTools,
                 credential: str = GIT_STORED_LOGIN, location: str | None = None,
                 entry: GitConfigEntry | None = None) -> None:
        self.transport, self.tools = transport, tools
        # Only the probe's own ssh sources run its ssh, with GitHub's host key pinned.
        self.pins_ssh = transport == "ssh" and credential == GIT_STORED_LOGIN
        if entry is not None:
            if (credential != GIT_CONFIG_ENTRY or location is not None or entry.value is None
                    or credential_key_transport(entry.key) != transport):
                raise ValueError(f"{transport}:{credential}:{entry.index}")
            self.env = {**credential_environment(env), **CONFIG_FILES_OFF, "GIT_CONFIG_COUNT": "1",
                        "GIT_CONFIG_KEY_0": entry.key, "GIT_CONFIG_VALUE_0": entry.value}
            self.name = f"git_{transport}:{GIT_CONFIG_ENTRY}:{entry.index}"
        elif transport == "https" and credential == GIT_STORED_LOGIN and (
                location is None or location in _GIT_LOGIN_LOCATIONS):
            self.env = credential_environment(env, variable=location)
            self.name = "git_https:stored" + (f":{location}" if location is not None else "")
        elif transport == "ssh" and credential == GIT_STORED_LOGIN and (
                location is None or location in _SSH_LOGIN_LOCATIONS):
            self.env = {**credential_environment(env, variable=location), **CONFIG_FILES_OFF}
            self.name = "git_ssh" + (f":{location}" if location is not None else "")
        elif transport in ("https", "ssh") and credential == GIT_JOB and location is None:
            self.env = dict(env)
            self.name = f"git_{transport}:job"
        elif JOB_GIT_CREDENTIALS.get(credential) == transport and location is None and env.get(credential):
            self.env = {**credential_environment(env, variable=credential), **CONFIG_FILES_OFF}
            self.name = f"git_{transport}:{credential}"
        else:
            raise ValueError(f"{transport}:{credential}:{location}")

    @classmethod
    def every_credential(cls, *, env: dict[str, str], tools: ProbeTools) -> list[CredentialSource]:
        """THE one list of git sources under ``env``, per transport: each stored place, each job credential alone, the job.

        An env-borne config git could not list, or a credential entry with no
        value, is an :class:`UnaskedSource` (inconclusive), never skipped.
        """
        entries = (job_git_config_entries(env, tools.git) if any(name in env for name in _GIT_ENV_CONFIG_SET_BY)
                   else [])
        sources: list[CredentialSource] = []
        if entries is None:
            sources.append(UnaskedSource(f"git:{GIT_CONFIG_ENTRY}", "git_config_unlisted"))
        for transport, locations in (("https", _GIT_LOGIN_LOCATIONS), ("ssh", _SSH_LOGIN_LOCATIONS)):
            sources += [cls(transport=transport, env=env, tools=tools),
                        *(cls(transport=transport, env=env, tools=tools, location=name)
                          for name in job_named_locations(env, locations)),
                        *(cls(transport=transport, env=env, tools=tools, credential=name)
                          for name, served in JOB_GIT_CREDENTIALS.items() if served == transport and env.get(name))]
            for entry in entries or []:
                if credential_key_transport(entry.key) != transport:
                    continue
                sources.append(cls(transport=transport, env=env, tools=tools, credential=GIT_CONFIG_ENTRY, entry=entry)
                               if entry.value is not None else
                               UnaskedSource(f"git_{transport}:{GIT_CONFIG_ENTRY}:{entry.index}",
                                             "git_config_entry_without_value"))
            sources.append(cls(transport=transport, env=env, tools=tools, credential=GIT_JOB))
        return sources

    def reach(self, repository: str) -> Reach:
        # No askpass of the probe's: an askpass the source's env or config
        # names is a credential, and with none git fails "terminal prompts
        # disabled" (a job has no terminal either), read as no credential.
        with outside_any_repository() as (scratch, discovery):
            env = {**self.env, "GIT_TERMINAL_PROMPT": "0", **discovery}
            if self.transport == "https":
                url = f"https://github.com/{repository}.git"
            else:
                url = f"git@github.com:{repository}.git"
            if self.pins_ssh:
                known_hosts = Path(scratch) / "known_hosts"
                known_hosts.write_text(GITHUB_SSH_HOST_KEY + "\n", encoding="utf-8")
                env["GIT_SSH_COMMAND"] = (f"{shlex.quote(self.tools.ssh)} -o BatchMode=yes -o ConnectTimeout=10"
                                          f" -o StrictHostKeyChecking=yes"
                                          f" -o UserKnownHostsFile={shlex.quote(str(known_hosts))}"
                                          f" -o HostKeyAlgorithms=ssh-ed25519")
            # Outside any repository (R7-3): neither the operator's working
            # directory nor a repository above the scratch directory has a
            # say in what git reads (a repository's .git/config is config too).
            done = _run([self.tools.git, "ls-remote", "--heads", url], env=env, cwd=scratch)
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
    # R6-3: the tools are resolved from the probe's own PATH, before any env
    # file is read; the env files' PATH never chooses them.
    tools, missing_tools = trusted_tools(os.environ.get("PATH", os.defpath))
    env_files = [read_env_file(path) for path in args.env_file]
    job_env = job_environment(environ=dict(os.environ), env_files=env_files)
    sources: list[CredentialSource] = []
    if tools is not None:
        sources += [*GhCliSource.every_credential(env=job_env, tools=tools),
                    *GitRemoteSource.every_credential(env=job_env, tools=tools)]
    if args.app_id and args.installation_id and args.app_private_key:
        sources.insert(0, AppPrivateKeySource(app_id=args.app_id, installation_id=args.installation_id,
                                              private_key_path=args.app_private_key))
    findings = data_key_findings(environ=dict(os.environ), env_files=env_files, scan_roots=args.scan_root)
    problems = [*missing_tools, *(problem for env_file in env_files for problem in env_file.problems)]
    status, report = run_probe(sources, data_key=findings, environment_problems=problems)
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
