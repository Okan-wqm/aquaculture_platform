"""ARIA-HIGH-397 — a plan converges only on module specifiers its projects can resolve.

WHY. Convergence measures agreement between two planners and the coverage
witness measures the impact closure of the surfaces a plan names; neither
asks the compiler anything. On 2026-10-08 F-015's plan converged prescribing
``import type { LeaveRequestStatus } from
'@platform/shared-ui/generated/graphql-types'`` in hr-module, whose tsconfig
maps no ``@platform/shared-ui/*`` alias. The implementer was the first to run
the compiler (TS2307); it refused, and the plan went to a person.

WHAT. :func:`prescribed_imports` reads the module specifiers a plan's key
changes prescribe (``from '…'``, ``import '…'``, ``import('…')``,
``require('…')``) and attributes each to the key change's own TypeScript or
JavaScript paths. :func:`compute_import_resolution` asks the repository's
TypeScript, through ``tools/gates/plan-import-witness.ts``, whether each
specifier resolves from each of those files under the project's own compiler
configuration, with the plan's planned files overlaid on the file view. The
result rides the round's ``coverage_computed`` event as its
``import_resolution`` block, and every unresolved specifier is a material
synthetic risk (``IMP-R{N}-…``) on the same risk channel coverage gaps use, so
the next revision addresses it like a reviewer's risk. The evaluator refuses
CONVERGED by name while one stands (``plan_convergence``, gate
``prescribed_imports_resolve``).

A plan that changes a project's compiler configuration itself takes the
answer on: its specifiers in that project are reported ``config_planned`` and
not judged, because the configuration they depend on is content the plan has
not written yet; the implementation's validation suite judges it.

Fail-closed: a witness that cannot run (no repository TypeScript, a crash, a
timeout, unparseable output) is ``environment_unable``, which the evaluator
escalates to HUMAN_REQUIRED, never "resolved".
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable

WITNESS_RELPATH = "tools/gates/plan-import-witness.ts"
WITNESS_TSCONFIG = "tools/gates/tsconfig.json"
# The repository's own ts-node: no global toolchain answers for this repo.
TS_NODE_RELPATH = "node_modules/.bin/ts-node"
DEFAULT_TIMEOUT_SECONDS = 120

VERDICT_RESOLVED = "resolved"
VERDICT_UNRESOLVED = "unresolved"
VERDICT_NOT_APPLICABLE = "not_applicable"
VERDICT_ENVIRONMENT_UNABLE = "environment_unable"
VERDICTS = frozenset({VERDICT_RESOLVED, VERDICT_UNRESOLVED, VERDICT_NOT_APPLICABLE, VERDICT_ENVIRONMENT_UNABLE})

SYNTHETIC_RISK_CATEGORY = "import_unresolved"
SYNTHETIC_RISK_SEVERITY = "material"

# Source files whose imports the TypeScript compiler resolves.
_SOURCE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
_SPECIFIER = r"""['"]([^'"\s`]{1,200})['"]"""
_PRESCRIPTION_PATTERNS = (
    re.compile(r"\bfrom\s+" + _SPECIFIER),
    re.compile(r"\bimport\s+" + _SPECIFIER),
    re.compile(r"\bimport\s*\(\s*" + _SPECIFIER + r"\s*\)"),
    re.compile(r"\brequire\s*\(\s*" + _SPECIFIER + r"\s*\)"),
)
MAX_CHECKS = 200

Runner = Callable[[list[str], str, int], "subprocess.CompletedProcess[str]"]


def _default_runner(cmd: list[str], cwd: str, timeout_seconds: int) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout_seconds)  # noqa: S603


def _source_paths(paths: Any) -> list[str]:
    return [str(path) for path in paths or [] if isinstance(path, str) and path.endswith(_SOURCE_SUFFIXES)]


def planned_paths(plan_content: dict[str, Any]) -> list[str]:
    """Every path the plan writes: its surfaces and its key changes' paths."""
    from .plan_convergence import affected_surface_paths

    affected = plan_content.get("affected_surfaces") or []
    paths = {str(path) for path in affected_surface_paths([affected] if isinstance(affected, dict) else affected)}
    for change in plan_content.get("key_changes") or []:
        if isinstance(change, dict):
            paths.update(str(path) for path in change.get("paths") or [] if isinstance(path, str))
    return sorted(paths)


def prescribed_imports(plan_content: Any) -> list[dict[str, str]]:
    """The (specifier, from_path, key_change_id) a plan's key changes prescribe, deduplicated, in order."""
    if not isinstance(plan_content, dict):
        return []
    found: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for index, change in enumerate(plan_content.get("key_changes") or []):
        if not isinstance(change, dict):
            continue
        sources = _source_paths(change.get("paths"))
        text = str(change.get("description") or "")
        if not sources or not text:
            continue
        specifiers: list[str] = []
        for pattern in _PRESCRIPTION_PATTERNS:
            specifiers.extend(match.group(1) for match in pattern.finditer(text))
        change_id = str(change.get("id") or f"key-change-{index + 1}")
        for specifier in specifiers:
            for source in sources:
                if (specifier, source) in seen:
                    continue
                seen.add((specifier, source))
                found.append({"specifier": specifier, "from_path": source, "key_change_id": change_id})
    return found[:MAX_CHECKS]


def build_synthetic_risk(entry: dict[str, Any], *, round_number: int) -> dict[str, Any]:
    """One unresolved specifier as a CROSS_REVIEW_RISK-schema risk (round-scoped id, like coverage)."""
    digest = hashlib.sha256(f"{entry['specifier']}|{entry['from_path']}".encode("utf-8")).hexdigest()[:8]
    project = entry.get("project_config")
    return {
        "risk_id": f"IMP-R{round_number}-{digest}",
        "risk_category": SYNTHETIC_RISK_CATEGORY,
        "severity": SYNTHETIC_RISK_SEVERITY,
        "summary": (
            f"Key change {entry['key_change_id']} prescribes the module specifier '{entry['specifier']}' in "
            f"{entry['from_path']}, which the repository's TypeScript does not resolve for that file "
            f"(project {project or 'none'}: {entry['reason']})"
        ),
        "recommendation": (
            "Prescribe a specifier the project resolves, or make this one resolve inside the plan's write set "
            "(the project's compiler configuration, e.g. its tsconfig paths) and name that file in a key change"
        ),
        "affected_files": [path for path in (entry["from_path"], project) if path],
        "evidence_refs": [project] if project else [],
    }


def _unable(reason: str, *, checked: int, witness: dict[str, Any]) -> dict[str, Any]:
    return {"verdict": VERDICT_ENVIRONMENT_UNABLE, "checked": checked, "unresolved": [], "config_planned": [],
            "reason": reason, "witness": witness}


def compute_import_resolution(
    *,
    plan_content: dict[str, Any],
    round_number: int,
    workspace_root: str | Path,
    input_path: Path,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    runner: Runner | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(the ``import_resolution`` block, its synthetic risks) for one plan revision."""
    checks = prescribed_imports(plan_content)
    if not checks:
        return {"verdict": VERDICT_NOT_APPLICABLE, "checked": 0, "unresolved": [], "config_planned": []}, []
    workspace = Path(workspace_root).resolve()
    ts_node = workspace / TS_NODE_RELPATH
    witness: dict[str, Any] = {"tool": WITNESS_RELPATH}
    if not ts_node.is_file():
        return _unable(f"toolchain_missing: {TS_NODE_RELPATH}", checked=len(checks), witness=witness), []
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_text(json.dumps({
        "schema_version": 1,
        "repo_root": str(workspace),
        "checks": [{"specifier": item["specifier"], "from_path": item["from_path"]} for item in checks],
        "planned_paths": planned_paths(plan_content),
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    cmd = [str(ts_node), "--project", WITNESS_TSCONFIG, WITNESS_RELPATH, "--input", str(input_path)]
    try:
        proc = (runner or _default_runner)(cmd, str(workspace), timeout_seconds)
    except FileNotFoundError as exc:
        return _unable(f"toolchain_missing: {exc}", checked=len(checks), witness=witness), []
    except subprocess.TimeoutExpired:
        return _unable(f"timeout_after_{timeout_seconds}s", checked=len(checks), witness=witness), []
    witness["exit_code"] = proc.returncode
    if proc.returncode != 0:
        witness["stderr_tail"] = (proc.stderr or "")[-1000:]
        return _unable(f"witness_environment_exit_{proc.returncode}", checked=len(checks), witness=witness), []
    try:
        report = json.loads(proc.stdout)
        results = report["results"]
        if not isinstance(results, list) or len(results) != len(checks):
            raise ValueError("witness results do not answer every check")
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return _unable(f"witness_output_unparseable: {exc}", checked=len(checks), witness=witness), []
    witness["typescript_version"] = str(report.get("typescript_version") or "")
    unresolved: list[dict[str, Any]] = []
    config_planned: list[dict[str, Any]] = []
    for check, result in zip(checks, results):
        if not isinstance(result, dict) or result.get("specifier") != check["specifier"] \
                or result.get("from_path") != check["from_path"]:
            return _unable("witness_output_misaligned", checked=len(checks), witness=witness), []
        entry = {**check, "project_config": result.get("project_config"), "reason": str(result.get("reason") or "")}
        if result.get("config_planned") is True:
            config_planned.append(entry)
        elif result.get("resolved") is not True:
            unresolved.append(entry)
    block = {
        "verdict": VERDICT_UNRESOLVED if unresolved else VERDICT_RESOLVED,
        "checked": len(checks),
        "unresolved": unresolved,
        "config_planned": config_planned,
        "witness": witness,
    }
    return block, [build_synthetic_risk(entry, round_number=round_number) for entry in unresolved]


def validate_import_resolution(block: Any) -> None:
    """Shape of a recorded ``import_resolution`` block (``plan_convergence`` validates the risks)."""
    from .tool_registry import GovernanceError

    if not isinstance(block, dict) or block.get("verdict") not in VERDICTS:
        raise GovernanceError(f"import_resolution verdict must be one of {sorted(VERDICTS)}")
    if not isinstance(block.get("checked"), int) or block["checked"] < 0:
        raise GovernanceError("import_resolution checked must be a non-negative integer")
    for field in ("unresolved", "config_planned"):
        entries = block.get(field)
        if not isinstance(entries, list):
            raise GovernanceError(f"import_resolution {field} must be an array")
        for entry in entries:
            if not isinstance(entry, dict) or not all(isinstance(entry.get(key), str) and entry[key]
                                                      for key in ("specifier", "from_path", "key_change_id")):
                raise GovernanceError(f"import_resolution {field} entries name specifier, from_path, key_change_id")
    if (block["verdict"] == VERDICT_UNRESOLVED) != bool(block["unresolved"]):
        raise GovernanceError("import_resolution unresolved verdict and entries must agree")


__all__ = [
    "SYNTHETIC_RISK_CATEGORY",
    "VERDICTS",
    "VERDICT_ENVIRONMENT_UNABLE",
    "VERDICT_NOT_APPLICABLE",
    "VERDICT_RESOLVED",
    "VERDICT_UNRESOLVED",
    "build_synthetic_risk",
    "compute_import_resolution",
    "planned_paths",
    "prescribed_imports",
    "validate_import_resolution",
]
