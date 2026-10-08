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
  is every ``.rs`` file under a ``tests/`` directory and every ``.rs`` file
  holding a ``#[cfg(test)]`` module.
* ``pyproject.toml`` / ``setup.cfg`` / ``tox.ini`` naming pytest, a
  ``pytest.ini``, or a ``tests/`` directory of ``test_*.py`` is a pytest
  project: target ``pytest``; its specs are ``test_*.py`` / ``*_test.py``.
* :data:`MODELLED_MANIFESTS` is the set of files this module reads. A project
  with none of them is reported ``modelled: False`` and rendered "not
  modelled": the map does not claim a fact it did not read.

:func:`spec_inventory` is one pruned ``os.walk`` (dependency and build trees
are never entered), measured at about 0.1 s on this repository, so the full
build and every refresh recompute it instead of patching a stored list.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

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
_RUST_TEST_MODULE = "#[cfg(test)]"

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


def _is_rust_spec(path: Path, rel: str) -> bool:
    if not rel.endswith(".rs"):
        return False
    if "/tests/" in f"/{rel}":
        return True
    try:
        return _RUST_TEST_MODULE in path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False


def spec_inventory(root: Path) -> list[str]:
    """Every spec file in the repository (TS, Python and Rust), repo-relative and sorted; one pruned walk."""
    found: list[str] = []
    for directory, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in _PRUNED_DIRS]
        base = Path(directory)
        prefix = base.relative_to(root).as_posix()
        for name in files:
            rel = name if prefix == "." else f"{prefix}/{name}"
            if name.endswith(_TS_SPEC_SUFFIXES) or _is_python_spec(name) or _is_rust_spec(base / name, rel):
                found.append(rel)
    return sorted(found)


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
    root: Path, projects: Mapping[str, Mapping[str, Any]], test_files: list[str],
) -> dict[str, dict[str, Any]]:
    """``{project: {"test_targets", "spec_files", "test_surface_modelled"}}`` for every project in ``projects``."""
    from .impact_graph import project_for_path

    roots = {name: str(meta["root"]) for name, meta in projects.items()}
    specs: dict[str, list[str]] = {name: [] for name in projects}
    for rel in test_files:
        owner = project_for_path(rel, roots)
        if owner is not None:
            specs[owner].append(rel)
    return {
        name: {"test_targets": project_test_targets(root / roots[name]), "spec_files": sorted(specs[name]),
               "test_surface_modelled": _modelled(root / roots[name])}
        for name in projects
    }


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
    return [
        f"  - test targets: {rendered}" if targets else "  - test targets: none declared or inferred",
        f"  - spec files ({count}): {shown}{more}" if count else "  - spec files: none",
    ]


__all__ = [
    "MODELLED_MANIFESTS",
    "is_test_target",
    "project_test_surface",
    "project_test_targets",
    "render_project_tests",
    "spec_inventory",
]
