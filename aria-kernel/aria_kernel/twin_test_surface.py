"""ARIA-MEDIUM-382 — every project's test targets and spec files, on the repository map.

WHY. The repository map (``twin``) is what a planner and a cross-reviewer read
instead of walking the tree. Its project entries carried ``root``,
``depends_on``, ``dependents`` and ``layer``; the only test fact it held was
the per-FILE ``tests`` list (specs that import a file or sit beside it). A
file nothing tests therefore rendered with no test line, and its project with
no test line either. Measured on plan ``plan-cyc-20261007T081056Z-auto``
(F-015): ``LeavesPage.tsx`` has no spec of its own, so the map said nothing
about testing in ``web-hr-module``, and the cross-reviewer read the silence as
"the repository map lists no spec under web-hr-module ... the runner may be
unconfigured". It is configured: ``web/modules/hr-module/package.json`` runs
``vitest run`` as ``test``, nx infers that script as the project's ``test``
target (``nx:run-script``; ``project.json`` declares no test target), and two
spec files under the project passed that day. Silence about a fact is read as
its negation, so the map has to state the fact for every project.

WHAT. :func:`project_test_surface` reports, per project:

* ``test_targets`` — the targets whose name is ``test`` or starts with
  ``test:`` / ``test-``, by nx's own resolution: ``project.json`` ``targets``
  first, then each ``package.json`` script nx infers as a target (every
  script, unless ``package.json`` ``nx.includedScripts`` narrows the list; a
  script whose name ``project.json`` already declares is the declared target,
  not a second one). Each entry names its ``source`` and the ``command`` it
  runs, so a reader sees the runner, not just a name.
* ``spec_files`` — every test file of the map (``twin._iter_test_files``)
  attributed to the project by ``impact_graph.project_for_path``, the one
  path-to-project rule.

An empty list is now a statement ("this project has no test target"), and the
renderer says it in words rather than leaving a gap.

Review corrections (PR #1859, MEDIUM-2). The first version read only the nx
manifests, so every Rust project (``sens-api-gateway``, the ``crates-*``) and
the Python kernel (``aria-kernel``, hundreds of pytest modules) rendered "test
targets: none" — a false explicit negative, the very failure this finding is
about. Now:

* ``Cargo.toml`` is a cargo project: target ``cargo test``; its spec evidence
  is every ``.rs`` file the Rust reader finds a test function in
  (:func:`read_rust_test_files`, ARIA-LOW-545).
* ``pyproject.toml`` / ``setup.cfg`` / ``tox.ini`` naming pytest, a
  ``pytest.ini``, or a ``tests/`` directory of ``test_*.py`` is a pytest
  project: target ``pytest``; its specs are ``test_*.py`` / ``*_test.py``.
* :data:`MODELLED_MANIFESTS` is the set of files this module reads. A project
  with none of them is reported ``modelled: False`` and rendered "not
  modelled": the map does not claim a fact it did not read.

:func:`spec_inventory` is one pruned ``os.walk`` (dependency and build trees
are never entered), measured at about 0.1 s on this repository, plus, when
the tree holds Rust, one run of the Rust reader in the adapter room (4.2 s
measured on a loaded host for the repository's 444 ``.rs`` files), so the
full build and every refresh recompute it instead of patching a stored list.

ARIA-LOW-545 — the map had its own Rust rule: a file under ``tests/``, or one
whose text contains ``#[cfg(test)]``. The adapters' Rust reader
(``tools/aria-adapters/rust-source.ts``) disagreed with it both ways:
``sens-api-gateway/src/scripting/bytecode_e2e_tests.rs`` holds four
``#[tokio::test]`` functions and no ``#[cfg(test)]`` (its declaring ``mod`` is
the gate), and the substring matched compile-fail inputs, doc comments and
bare ``#[cfg(test)] mod x;`` declarations. Rust has one reader, and it is
TypeScript, so the map asks it (``rust-test-files.ts``) through the adapter
room, the one seam that executes adapter code. When it cannot answer, the
files it did not read are counted per project and rendered "not modelled",
never as "no tests".
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .tool_registry import TS_NODE_RUNNER_PREFIX

# The files this module reads to decide a project's test surface.
MODELLED_MANIFESTS: tuple[str, ...] = (
    "project.json", "package.json", "Cargo.toml", "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini",
)
# Never entered by the spec walk: dependencies, build output, VCS and tool caches.
_PRUNED_DIRS = frozenset({
    "node_modules", "dist", "build", "coverage", "target", "vendor", "__pycache__", ".git", ".venv", ".nx",
    ".worktrees",
})
_TS_SPEC_SUFFIXES = (".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx")
_RUST_SUFFIX = ".rs"
# The Rust reader's entry point for "which of these files hold tests", run
# exactly as an adapter manifest's runner is (the normalised repo-local
# ts-node, the gates compiler configuration), with the workspace as cwd.
RUST_TEST_FILES_READER = "tools/aria-adapters/rust-test-files.ts"
RUST_TEST_FILES_ARGV: tuple[str, ...] = (
    *TS_NODE_RUNNER_PREFIX, "--project", "tools/gates/tsconfig.json", RUST_TEST_FILES_READER,
)
RUST_TEST_FILES_TIMEOUT_SECONDS = 120
# The reason recorded for files the reader was asked about and refused or
# could not lex (its per-file reasons stay in its own output).
RUST_FILES_UNREADABLE = "unreadable_by_the_rust_reader"
# Every key :func:`project_test_surface` owns on a project entry. A merge into
# a prior entry (``twin._with_test_surface``) replaces all of them, so a key
# this read did not emit, such as the unread record of a night the reader
# could not run, never survives an incremental refresh.
TEST_SURFACE_KEYS: tuple[str, ...] = (
    "test_targets", "spec_files", "test_surface_modelled", "rust_test_files_unread",
)

_TEST_TARGET_PREFIXES = ("test:", "test-")


def is_test_target(name: str) -> bool:
    return name == "test" or name.startswith(_TEST_TARGET_PREFIXES)


def _json_object(path: Path) -> dict[str, Any]:
    """The file's JSON object, or {} when it is absent or unreadable (no targets declared there)."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _declared_command(target: Any) -> str | None:
    if not isinstance(target, dict):
        return None
    options = target.get("options") if isinstance(target.get("options"), dict) else {}
    command = options.get("command") or options.get("script") or target.get("command") or target.get("executor")
    return command if isinstance(command, str) else None


def _is_python_spec(name: str) -> bool:
    return name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py"))


class RustReaderUnavailable(Exception):
    """The Rust reader gave no answer; the message names why."""


@dataclass(frozen=True)
class RustTestFiles:
    """The Rust reader's answer: which asked files hold tests, and which it could not read."""

    test_files: frozenset[str]
    unreadable: frozenset[str]


RustTestFilesReader = Callable[[Path, Sequence[str], Path | None], RustTestFiles]


def read_rust_test_files(root: Path, paths: Sequence[str], store: Path | None) -> RustTestFiles:
    """Ask the Rust reader, inside the adapter room, which of ``paths`` hold tests.

    The room (``adapter_room``) is the one seam that executes adapter code:
    no network, the tracked workspace read-only, the store ``store`` masked.
    Raises :class:`RustReaderUnavailable` naming why when there is no answer:
    the repository's ts-node is missing, the room cannot be built, the reader
    fails or times out, or its output is not an answer about ``paths``.
    """
    from .adapter_room import prepare_adapter_spawn, run_adapter
    from .implementation_safety import SandboxUnavailable
    from .tool_registry import missing_repo_local_dependencies

    missing = missing_repo_local_dependencies({"argv": list(RUST_TEST_FILES_ARGV), "cwd": "."}, workspace_root=root)
    if missing:
        raise RustReaderUnavailable("missing_repo_local_dependency:" + ",".join(missing))
    try:
        spawn = prepare_adapter_spawn(RUST_TEST_FILES_ARGV, workspace_root=root, cwd=root, store=store)
        done = run_adapter(spawn, input_text=json.dumps({"paths": list(paths)}),
                           timeout_seconds=RUST_TEST_FILES_TIMEOUT_SECONDS)
    except SandboxUnavailable as exc:
        raise RustReaderUnavailable(f"adapter_room_unavailable:{exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RustReaderUnavailable(f"timeout_after_{RUST_TEST_FILES_TIMEOUT_SECONDS}s") from exc
    except OSError as exc:
        raise RustReaderUnavailable(f"spawn_failed:{type(exc).__name__}") from exc
    if done.returncode != 0:
        raise RustReaderUnavailable(f"reader_exit_{done.returncode}")
    return rust_reader_answer(done.stdout, paths)


def rust_reader_answer(stdout: str, asked: Sequence[str]) -> RustTestFiles:
    """The reader's stdout as an answer about ``asked``, or :class:`RustReaderUnavailable`.

    Every path it names must be one it was asked about, and no asked path may
    be both a test file and unreadable: an answer about other files is not an
    answer about these.
    """
    try:
        payload = json.loads(stdout)
    except ValueError as exc:
        raise RustReaderUnavailable("reader_output_not_json") from exc
    if not isinstance(payload, dict):
        raise RustReaderUnavailable("reader_output_shape")
    test_files, unreadable = payload.get("test_files"), payload.get("unreadable")
    if not isinstance(test_files, list) or not isinstance(unreadable, list):
        raise RustReaderUnavailable("reader_output_shape")
    unread = [row.get("path") for row in unreadable if isinstance(row, dict)]
    named = [*test_files, *unread]
    if len(unread) != len(unreadable) or not all(isinstance(path, str) for path in named):
        raise RustReaderUnavailable("reader_output_shape")
    if not set(named) <= set(asked) or set(test_files) & set(unread):
        raise RustReaderUnavailable("reader_output_names_unasked_paths")
    return RustTestFiles(test_files=frozenset(test_files), unreadable=frozenset(unread))


@dataclass(frozen=True)
class SpecInventory:
    """Every spec file the map read, and the Rust files whose tests it does not know.

    ``files`` holds TS and Python specs by name and Rust files the reader
    found a test function in. ``rust_unread`` holds the ``.rs`` files the
    reader gave no answer for (all of them when it could not run), and
    ``rust_unread_reason`` says why; both are empty when every one was read.
    """

    files: tuple[str, ...]
    rust_unread: tuple[str, ...] = ()
    rust_unread_reason: str | None = None


def spec_inventory(
    root: Path, *, store: Path | None = None, read_rust: RustTestFilesReader | None = None,
) -> SpecInventory:
    """Every spec file in the repository (TS, Python and Rust), repo-relative and sorted.

    One pruned walk names TS and Python specs and collects the ``.rs`` files;
    the Rust reader (``read_rust``, :func:`read_rust_test_files` unless a
    caller supplies one) says which of those hold tests.
    """
    found: list[str] = []
    rust: list[str] = []
    for directory, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in _PRUNED_DIRS]
        prefix = Path(directory).relative_to(root).as_posix()
        for name in files:
            rel = name if prefix == "." else f"{prefix}/{name}"
            if name.endswith(_TS_SPEC_SUFFIXES) or _is_python_spec(name):
                found.append(rel)
            elif name.endswith(_RUST_SUFFIX):
                rust.append(rel)
    if not rust:
        return SpecInventory(files=tuple(sorted(found)))
    asked = sorted(rust)
    try:
        answer = (read_rust or read_rust_test_files)(root, asked, store)
    except RustReaderUnavailable as exc:
        return SpecInventory(files=tuple(sorted(found)), rust_unread=tuple(asked), rust_unread_reason=str(exc))
    return SpecInventory(
        files=tuple(sorted({*found, *answer.test_files})),
        rust_unread=tuple(sorted(answer.unreadable)),
        rust_unread_reason=RUST_FILES_UNREADABLE if answer.unreadable else None,
    )


def _text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _pytest_source(project_dir: Path) -> str | None:
    """The file (or ``tests/``) that makes the project a pytest project, or None."""
    if (project_dir / "pytest.ini").is_file():
        return "pytest.ini"
    for manifest, marker in (("pyproject.toml", "pytest"), ("setup.cfg", "[tool:pytest]"), ("tox.ini", "[pytest]")):
        if marker in _text(project_dir / manifest):
            return manifest
    tests = project_dir / "tests"
    if tests.is_dir() and any(_is_python_spec(child.name) for child in tests.iterdir()):
        return "tests/"
    return None


def project_test_targets(project_dir: Path) -> list[dict[str, Any]]:
    """The test targets nx, cargo and pytest resolve for the project at ``project_dir``, sorted by name."""
    declared = _json_object(project_dir / "project.json").get("targets")
    declared = declared if isinstance(declared, dict) else {}
    targets = {
        name: {"name": name, "source": "project.json", "command": _declared_command(spec)}
        for name, spec in declared.items() if isinstance(name, str) and is_test_target(name)
    }
    manifest = _json_object(project_dir / "package.json")
    scripts = manifest.get("scripts") if isinstance(manifest.get("scripts"), dict) else {}
    nx_block = manifest.get("nx") if isinstance(manifest.get("nx"), dict) else {}
    included = nx_block.get("includedScripts")
    for name, command in scripts.items():
        if not isinstance(name, str) or not is_test_target(name) or name in declared:
            continue
        if isinstance(included, list) and name not in included:
            continue
        targets[name] = {"name": name, "source": "package.json",
                         "command": command if isinstance(command, str) else None}
    if (project_dir / "Cargo.toml").is_file():
        targets.setdefault("cargo test", {"name": "cargo test", "source": "Cargo.toml", "command": "cargo test"})
    pytest_source = _pytest_source(project_dir)
    if pytest_source is not None:
        targets.setdefault("pytest", {"name": "pytest", "source": pytest_source, "command": "pytest"})
    return [targets[name] for name in sorted(targets)]


def _modelled(project_dir: Path) -> bool:
    return any((project_dir / manifest).is_file() for manifest in MODELLED_MANIFESTS) or (
        (project_dir / "tests").is_dir())


def project_test_surface(
    root: Path, projects: Mapping[str, Mapping[str, Any]], inventory: SpecInventory,
) -> dict[str, dict[str, Any]]:
    """``{project: {"test_targets", "spec_files", "test_surface_modelled"}}`` for every project in ``projects``.

    A project holding Rust files the reader gave no answer for also carries
    ``rust_test_files_unread`` (``{"files", "reason"}``): its spec list is
    complete only for the files that were read.
    """
    from .impact_graph import project_for_path

    roots = {name: str(meta["root"]) for name, meta in projects.items()}
    specs: dict[str, list[str]] = {name: [] for name in projects}
    unread: dict[str, int] = {name: 0 for name in projects}
    for rel in inventory.files:
        owner = project_for_path(rel, roots)
        if owner is not None:
            specs[owner].append(rel)
    for rel in inventory.rust_unread:
        owner = project_for_path(rel, roots)
        if owner is not None:
            unread[owner] += 1
    surface: dict[str, dict[str, Any]] = {}
    for name in projects:
        entry: dict[str, Any] = {
            "test_targets": project_test_targets(root / roots[name]), "spec_files": sorted(specs[name]),
            "test_surface_modelled": _modelled(root / roots[name]),
        }
        if unread[name]:
            entry["rust_test_files_unread"] = {"files": unread[name], "reason": inventory.rust_unread_reason}
        surface[name] = entry
    return surface


def render_project_tests(meta: Mapping[str, Any]) -> list[str]:
    """ARIA-MEDIUM-382 — what tests a blast-radius project, stated even when it is nothing.

    A map that said nothing here was read as "no runner" by a cross-reviewer
    on a project whose nx-inferred ``test`` target and two specs had passed
    that day. A row minted from a v1 map carries no ``test_targets`` key and
    renders exactly as it was sealed.
    """
    if "test_targets" not in meta:
        return []
    if not meta.get("test_surface_modelled", True) and not meta.get("test_targets") and not meta.get("spec_files"):
        # No manifest this map reads: say so, never "none" (review MEDIUM-2).
        return ["  - test targets: not modelled (no manifest the map reads)", "  - spec files: not modelled"]
    targets = [target for target in meta.get("test_targets") or [] if isinstance(target, dict)]
    rendered = ", ".join(
        f"`{target.get('name')}`" + (f" (`{target.get('command')}`, {target.get('source')})"
                                     if target.get("command") else f" ({target.get('source')})")
        for target in targets
    )
    specs = [path for path in meta.get("spec_files") or [] if isinstance(path, str)]
    count = int(meta.get("spec_file_count") or len(specs))
    shown = ", ".join(f"`{path}`" for path in specs)
    more = f" (+{count - len(specs)} more)" if count > len(specs) else ""
    unread = meta.get("rust_test_files_unread")
    lines = [
        f"  - test targets: {rendered}" if targets else "  - test targets: none declared or inferred",
        f"  - spec files ({count}): {shown}{more}" if count
        else ("  - spec files: none among the files read" if unread else "  - spec files: none"),
    ]
    if isinstance(unread, dict):
        # ARIA-LOW-545 — the Rust reader gave no answer for these files: say
        # so, never let the spec list above read as "they hold no tests".
        lines.append(f"  - Rust test files: not modelled for {unread.get('files')} file(s) ({unread.get('reason')})")
    return lines


__all__ = [
    "MODELLED_MANIFESTS",
    "RUST_FILES_UNREADABLE",
    "RUST_TEST_FILES_ARGV",
    "RUST_TEST_FILES_READER",
    "RustReaderUnavailable",
    "RustTestFiles",
    "SpecInventory",
    "TEST_SURFACE_KEYS",
    "is_test_target",
    "project_test_surface",
    "project_test_targets",
    "read_rust_test_files",
    "render_project_tests",
    "rust_reader_answer",
    "spec_inventory",
]
