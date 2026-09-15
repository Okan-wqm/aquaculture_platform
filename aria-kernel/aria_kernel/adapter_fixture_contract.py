"""An adapter enters the roster only with a fixture-backed evidence contract.

WHY. ``agent-harness-security-adapter`` shipped with a ``fixture_set`` that
named a directory nobody created. Nothing objected: ``register_tool`` sees a
manifest, not a checkout; the fixture refresh phase reported "fixture cases
directory does not exist" every night as one line among ten; and the adapter
ran anyway. On trial eleven (``cyc-20260912T221237Z-auto``) its 48 findings
carried a ``ref`` string where the validator requires a per-finding
``evidence`` list, the run was ``evidence_error``, and the night ended
``integrity_failed`` (ARIA-HIGH-098). The fixture runner would have said so
on the adapter's first commit — ``run_fixture_case`` applies
``validate_tool_output_evidence`` and a case expecting ``ok`` cannot pass an
``evidence_error`` — had there been a case to run.

WHAT. The manifest-sync phase (``cycle._phase_tool_manifest_sync``), the one
production door through which ``tools/aria-adapters/*.tool.json`` reaches
the registry, refuses a manifest whose ``fixture_set`` holds no case that
expects the run to be ``ok``. A refusal is recorded by name in the phase
result, like every other refusal that phase makes. ``register_tool`` itself
is untouched — it is called by fixtures and tests that own their own layout,
and it cannot see the checkout.

The PR-time pin (``tests/test_adapter_fixture_evidence_contract.py``) walks
the same function over every shipped manifest and runs the suites the
runner can execute, so a manifest cannot merge without the case that keeps
it honest — and both kernel PR lanes fire on ``tools/aria-adapters/**``
(``.github/workflows/aria-kernel*.yml``), because a pin in a lane that an
adapters-only change never triggers is a pin checked on main.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError

FIXTURE_CASES_DIRNAME = "cases"
# The only status a fixture case may expect of a registered adapter. The
# runner (``fixture_runner.run_fixture_case``) turns a failed evidence
# validation into ``evidence_error`` before the expectation is judged, so a
# case that expects ``ok`` IS the evidence contract; a case expecting
# anything else would let an adapter pass its suite while every production
# run of it is quarantined.
REQUIRED_EXPECTED_STATUS = "ok"


def expected_run_status(expected: Any) -> str:
    """The run status a case expects: ``expected.status`` when declared, ``ok`` otherwise.

    The one reading of a case's expectation, shared with the runner's judge
    (``fixture_runner.evaluate_fixture_expectation``). Two readers of one
    case shape had two defaults: the runner treated a case with no
    ``expected`` block as expecting ``ok`` while the registration door
    refused it as ``expected.status=None`` — a status the case never
    declared, refused under a name that said it had.
    """
    if isinstance(expected, dict):
        return str(expected.get("status", REQUIRED_EXPECTED_STATUS))
    return REQUIRED_EXPECTED_STATUS


def fixture_cases_dir(manifest: dict[str, Any], workspace_root: str | Path) -> Path:
    """Where the manifest's cases live, in the checkout the manifest ships in."""
    fixture_set = str(manifest.get("fixture_set") or "").strip()
    if not fixture_set:
        raise GovernanceError(
            f"fixture_set_missing:{manifest.get('tool_id')}: a registered adapter declares "
            "the fixture directory that holds its evidence contract",
        )
    return Path(workspace_root).resolve() / fixture_set / FIXTURE_CASES_DIRNAME


def fixture_cases_for_manifest(manifest: dict[str, Any], workspace_root: str | Path) -> list[Path]:
    """The manifest's case files, sorted; empty when the directory is absent."""
    cases = fixture_cases_dir(manifest, workspace_root)
    if not cases.is_dir():
        return []
    return sorted(path for path in cases.glob("*.json") if path.is_file())


def assert_fixture_backed(manifest: dict[str, Any], workspace_root: str | Path) -> list[Path]:
    """Refuse, by name, a manifest that carries no fixture-backed evidence contract.

    Returns the case paths that make the contract, so a caller that wants
    to run them does not resolve the directory a second time.
    """
    tool_id = str(manifest.get("tool_id") or "")
    cases = fixture_cases_for_manifest(manifest, workspace_root)
    if not cases:
        raise GovernanceError(
            f"fixture_cases_missing:{tool_id}: no case under "
            f"{fixture_cases_dir(manifest, workspace_root)} — an adapter is registered only "
            "with a fixture case that expects an ok run, because that case is where its "
            "output is validated against the evidence contract",
        )
    for case_path in cases:
        try:
            case = json.loads(case_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise GovernanceError(
                f"fixture_case_unreadable:{tool_id}:{case_path.name}: {exc}",
            ) from exc
        if not isinstance(case, dict):
            # The runner reads a case as a JSON object (``case.get("input")``,
            # ``case.get("expected")``); any other JSON is a file that is not a
            # case, refused under its own name rather than as an expectation
            # it could not have declared.
            raise GovernanceError(
                f"fixture_case_malformed:{tool_id}:{case_path.name}: a case is a JSON object, "
                f"got {type(case).__name__}",
            )
        status = expected_run_status(case.get("expected"))
        if status != REQUIRED_EXPECTED_STATUS:
            raise GovernanceError(
                f"fixture_case_expects_non_ok_run:{tool_id}:{case_path.name}: expected.status="
                f"{status!r}; a registered adapter's cases expect {REQUIRED_EXPECTED_STATUS!r}, "
                "the status the runner grants only to evidence-valid output",
            )
    return cases


__all__ = [
    "FIXTURE_CASES_DIRNAME",
    "REQUIRED_EXPECTED_STATUS",
    "assert_fixture_backed",
    "expected_run_status",
    "fixture_cases_dir",
    "fixture_cases_for_manifest",
]
