"""ARIA-CRITICAL-399 — the room every adapter runs in.

WHY: ``tool_runner.run_tool`` spawned each adapter with ``env=dict(os.environ)``
and ``fixture_runner.run_fixture_case`` with no ``env=`` at all, both
unconfined. An adapter — curated, or drafted by skill genesis — therefore ran
as the runner's user with the job's ``GH_TOKEN``, the OIDC request token,
``GITHUB_ENV``, the host network and the whole filesystem. On the nightly
lane that filesystem holds the GitHub App private key the cycle step writes
to ``$RUNNER_TEMP/aria-gh-app-private-key-*.pem``. Scrubbing the environment
alone does not close that: the key is a FILE the same uid can read, and
``/proc/<pid>/environ`` of the kernel process still carries every scrubbed
name to anything that shares its PID namespace.

WHAT: one seam — :func:`prepare_adapter_spawn` + :func:`run_adapter` — that
every adapter execution passes through (the tool runner, the fixture runner,
the genesis sandbox). It composes owners that already exist, adding no
second copy of either policy:

* the ENVIRONMENT is built by ``validation_env.build_validation_env`` (the
  closed allowlist the validation lane uses), plus exactly two declared
  names: ``NODE_OPTIONS`` carrying the manifest's heap contract, and
  ``ARIA_REPO_ROOT`` naming the workspace the adapter scans (the Python
  adapters' root override, otherwise derived by walking up from the cwd);
* the ROOM is ``implementation_safety.wrap_bash_in_sandbox`` with:
  - no network;
  - the toolchain prefixes the command resolves to, bound read-only
    (``validation_executable_binds``);
  - the checkout's read-only git shape (``derive_git_containment``);
  - private PID/IPC/UTS namespaces and a new session
    (``MANAGED_SPAWN_ISOLATION_FLAGS``), so no host process, the kernel
    included, is visible in ``/proc``;
  - the TRACKED VIEW of the workspace (``workspace_view``): what git tracks,
    read-only, plus the installed dependency trees. Whatever git does not
    track is not in the room: the store, the signing keys, the request
    worktrees, the tools root and an operator's gitignored ``.env``, keys and
    deploy secrets alike, with no list naming them (ARIA-MEDIUM-432; the
    room hid a fixed list of ARIA's own directories before).

Read-only, not the validation room's writable workspace: an adapter is a
scanner and the shipped roster writes nothing (measured in and out of the
room, docs/reviews/claude/2026-10-10-aria-adapter-sandbox.md). A writable
workspace would let an adapter plant code in the gitignored ``node_modules``
— invisible to the tool runner's ``git status`` mutation check — for a later
step to execute outside any room.

No mock exemption: ``CLAUDE_CLI_MOCK`` governs Claude spawns, and an adapter
is real code in every mode. Without a usable backend this module raises
``SandboxUnavailable``; it never runs an adapter unconfined.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .git_containment import GitContainmentRefusal, derive_git_containment
from .implementation_safety import (
    KERNEL_CHECKOUT_ROOT,
    MANAGED_SPAWN_ISOLATION_FLAGS,
    BashAllowlistMiss,
    SandboxUnavailable,
    sandbox_backend,
    sandbox_unavailable_detail,
    trusted_python_script,
    validation_executable_binds,
    wrap_bash_in_sandbox,
)
from .state_store import STORE_DIRNAME
from .request_worktree import REQUEST_WORKTREES_DIR
from .tool_registry import GovernanceError, tools_dir
from .validation_env import ValidationEnv, build_validation_env
from .workspace_view import WorkspaceView, WorkspaceViewRefused, build_workspace_view

# The heap every Node adapter gets unless its manifest declares one
# (`runner.node_max_old_space_mb`): Node's own default (~1 GB) OOM-crashed
# the widest-scope adapters the first time they ran.
ADAPTER_NODE_HEAP_DEFAULT_MB = 2048
ADAPTER_REPO_ROOT_ENV = "ARIA_REPO_ROOT"
# Runtimes the shipped roster executes BESIDES the command's own argv[0]:
# banned-phrase-adapter is `python3 …` and spawns the repository's ts-node,
# whose `#!/usr/bin/env node` resolves node on PATH. Bound read-only when
# the host has it; a host without node fails the same adapters outside.
ADAPTER_RUNTIME_EXECUTABLES: tuple[str, ...] = ("node",)
# The runner's private temp directory: the App key file lives directly in
# it (aria-auto-cycle.yml, "Run the nightly cycle"), so no bind may reach it.
RUNNER_TEMP_ENV = "RUNNER_TEMP"


@dataclass(frozen=True)
class AdapterSpawn:
    """One adapter command, contained: what to execute and with what.

    ``argv`` is the bwrap-wrapped command, ``env`` the built environment,
    ``spawn_environment`` that environment's report by NAME (never value),
    ``backend`` the verified sandbox backend that contains it.
    """

    argv: list[str]
    cwd: Path
    env: dict[str, str]
    spawn_environment: dict[str, Any]
    backend: str


def adapter_environment(
    base: Mapping[str, str], *, workspace_root: str | Path, node_heap_mb: int | None = None,
) -> ValidationEnv:
    """The adapter's environment: the validation allowlist over ``base`` plus
    the two names an adapter is declared to read. ``NODE_OPTIONS`` is
    COMPOSED — an operator's own flags survive, the heap flag is appended —
    exactly as the tool runner always did; the fixture runner never set it,
    so its Node adapters ran on a smaller heap than the night's."""
    heap_mb = int(node_heap_mb or ADAPTER_NODE_HEAP_DEFAULT_MB)
    node_options = f"{base.get('NODE_OPTIONS', '')} --max-old-space-size={heap_mb}".strip()
    return build_validation_env(
        base,
        declared={
            "NODE_OPTIONS": node_options,
            ADAPTER_REPO_ROOT_ENV: str(Path(workspace_root).resolve()),
        },
    )


def _resolve_executable(executable: str, *, cwd: Path, environment: Mapping[str, str]) -> Path:
    """Where ``executable`` resolves for a child started in ``cwd`` — the
    same answer exec gives. A command that does not resolve raises
    ``FileNotFoundError`` naming it, the error ``subprocess`` raised before
    the room existed, so the tool runner's fault ownership is unchanged."""
    if os.sep in executable:
        candidate = Path(executable) if os.path.isabs(executable) else cwd / executable
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
        raise FileNotFoundError(2, "No such file or directory", executable)
    found = shutil.which(executable, path=environment.get("PATH", os.defpath))
    if found is None:
        raise FileNotFoundError(2, "No such file or directory", executable)
    return Path(found)


def _toolchain_binds(
    argv: Sequence[str], *, workspace: Path, cwd: Path, environment: Mapping[str, str], store: Path | None,
) -> list[Path]:
    """Host paths bound read-only so the command can run: the prefix of the
    command's own executable and of each runtime the roster spawns, and the
    Python program file when it lies outside the workspace (a kernel test
    helper; the argv policy already confines it to trusted prefixes)."""
    binds: list[Path] = []

    def add_prefix(executable: Path) -> None:
        if executable.is_relative_to(workspace):
            return
        for path in validation_executable_binds(str(executable), environment=environment, workspace=workspace, store=store):
            if path not in binds:
                binds.append(path)

    add_prefix(_resolve_executable(str(argv[0]), cwd=cwd, environment=environment))
    for runtime in ADAPTER_RUNTIME_EXECUTABLES:
        found = shutil.which(runtime, path=environment.get("PATH", os.defpath))
        if found is not None:
            add_prefix(Path(found))
    if len(argv) > 1 and Path(str(argv[0])).name.startswith("python"):
        program = Path(str(argv[1]))
        if program.is_absolute() and program.suffix == ".py" and program.is_file():
            resolved = program.resolve()
            # Only the running kernel's own code, by the argv policy's one
            # rule (`trusted_python_script`, ARIA-HIGH-431): a path an agent
            # chose — a drafted adapter's `adapter_path` — is never bound.
            try:
                trusted_python_script(str(resolved), checkout_root=KERNEL_CHECKOUT_ROOT)
            except BashAllowlistMiss:
                return binds
            if not resolved.is_relative_to(workspace) and resolved not in binds:
                binds.append(resolved)
    return binds


def _refuse_a_private_root_workspace(workspace: Path, *, store: Path | None, base: Mapping[str, str]) -> None:
    """A workspace that IS one of ARIA's private directories is no room.

    The private directories are the durable store (its canonical checkout
    directory and the tools root this run writes), the request worktrees,
    the tools root the kernel resolves even when no ``store`` is passed, and
    the RUNNER_TEMP that holds the App key. Inside a workspace the view
    hides whatever of them git does not track, so no list of them shapes the
    room any more. But a view OF one would show its tracked files, the
    store's ledgers among them, and hiding it would hide the tree being
    scanned. (A workspace strictly INSIDE one exposes only its own subtree.)
    """
    candidates = [workspace / STORE_DIRNAME, workspace / REQUEST_WORKTREES_DIR]
    if store is not None:
        candidates.append(Path(store))
    try:
        candidates.append(tools_dir())
    except GovernanceError:
        pass  # no tools root is bound on this host
    runner_temp = base.get(RUNNER_TEMP_ENV)
    if runner_temp:
        candidates.append(Path(runner_temp))
    for candidate in candidates:
        if candidate.resolve() == workspace:
            raise SandboxUnavailable(f"adapter_room_workspace_is_private_root:{candidate.name}")


def _refuse_binds_reaching_runner_temp(command: Sequence[str], *, view: WorkspaceView, base: Mapping[str, str]) -> None:
    """No bind of the finished room may contain RUNNER_TEMP unless the view
    hides it. A toolchain prefix resolved there (an action that unpacks a
    binary into the temp dir), the interpreter's prefix or a dependency tree
    would mount the App key file beside it. Read off the argv, so every bind
    the builders added is covered, not only the ones this module chose."""
    runner_temp = base.get(RUNNER_TEMP_ENV)
    if not runner_temp:
        return
    secret_root = Path(runner_temp).resolve()
    if secret_root.is_relative_to(view.root) and secret_root != view.root and view.hides(secret_root):
        return
    for index, flag in enumerate(command[:-2]):
        if flag in ("--bind", "--ro-bind"):
            source = Path(command[index + 1])
            if secret_root == source or secret_root.is_relative_to(source):
                raise SandboxUnavailable(f"adapter_room_bind_contains_runner_temp:{source}")


def wrap_adapter_in_sandbox(
    argv: Sequence[str],
    *,
    workspace_root: str | Path,
    cwd: str | Path,
    environment: Mapping[str, str],
    store: str | Path | None,
    base: Mapping[str, str],
) -> list[str]:
    """The bwrap argv for one adapter command (see the module docstring).
    Raises ``SandboxUnavailable`` by name when the room cannot be built."""
    workspace = Path(workspace_root).resolve()
    run_dir = Path(cwd).resolve()
    store_root = Path(store).resolve() if store is not None else None
    binds = _toolchain_binds(argv, workspace=workspace, cwd=run_dir, environment=environment, store=store_root)
    _refuse_a_private_root_workspace(workspace, store=store_root, base=base)
    try:
        view = build_workspace_view(workspace)
    except WorkspaceViewRefused as exc:
        raise SandboxUnavailable(f"adapter_room_{exc.reason}") from exc
    try:
        git = derive_git_containment(workspace, commit_capable=False)
    except GitContainmentRefusal as exc:
        raise SandboxUnavailable(f"git_containment_refused:{exc.reason}") from exc
    command = wrap_bash_in_sandbox(
        list(argv), workspace_root=workspace, allow_network=False, write_scope=(),
        extra_ro_binds=tuple(binds), git=git, chdir=run_dir, workspace_view=view,
    )
    separator = command.index("--")
    _refuse_binds_reaching_runner_temp(command[:separator], view=view, base=base)
    return command[:separator] + list(MANAGED_SPAWN_ISOLATION_FLAGS) + command[separator:]


def prepare_adapter_spawn(
    argv: Sequence[str],
    *,
    workspace_root: str | Path,
    cwd: str | Path,
    node_heap_mb: int | None = None,
    store: str | Path | None = None,
    base: Mapping[str, str] | None = None,
) -> AdapterSpawn:
    """Build the contained command for one adapter run, or refuse by name.

    ``base`` is the environment the adapter's is built from (the runner's,
    ``os.environ``, by default — a parameter so the policy is a function of
    a mapping). ``store`` is the tools root this run writes, masked when it
    lies inside the workspace. Raises ``SandboxUnavailable`` when no backend
    is usable or the room cannot be built, and ``FileNotFoundError`` when
    the command's executable does not resolve.
    """
    environ = os.environ if base is None else base
    backend = sandbox_backend()
    if backend is None:
        raise SandboxUnavailable(f"sandbox_backend_unavailable:{sandbox_unavailable_detail()}")
    built = adapter_environment(environ, workspace_root=workspace_root, node_heap_mb=node_heap_mb)
    wrapped = wrap_adapter_in_sandbox(
        argv, workspace_root=workspace_root, cwd=cwd, environment=built.env, store=store, base=environ,
    )
    return AdapterSpawn(
        argv=wrapped, cwd=Path(cwd).resolve(), env=built.env,
        spawn_environment=built.report.to_ledger(), backend=backend,
    )


def run_adapter(
    spawn: AdapterSpawn, *, input_text: str | None, timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    """Execute a prepared adapter spawn: the ONE process start of adapter
    code in the kernel. ``subprocess.TimeoutExpired`` propagates to the
    caller, which owns the timeout's status; killing ``bwrap`` takes the
    whole room with it (``--die-with-parent`` over a private PID
    namespace), so no adapter process outlives its budget."""
    return subprocess.run(
        spawn.argv,
        cwd=spawn.cwd,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        shell=False,
        env=spawn.env,
    )


__all__ = [
    "ADAPTER_NODE_HEAP_DEFAULT_MB",
    "ADAPTER_REPO_ROOT_ENV",
    "ADAPTER_RUNTIME_EXECUTABLES",
    "AdapterSpawn",
    "adapter_environment",
    "prepare_adapter_spawn",
    "run_adapter",
    "wrap_adapter_in_sandbox",
]
