"""A registered adapter that declares per-rule judgment contracts.

The judge fan-out and consensus promotion read a rule's contract from the
tool registry (``aria_kernel.rule_contract``) and refuse a rule that declares
none, so a test that judges or promotes a finding registers its tool here
first, exactly as the cycle's manifest sync registers the shipped adapters.

The tool enters at SHADOW, the one initial lifecycle state
(tool_registry.INITIAL_LIFECYCLE_STATES, ORPHAN-MEDIUM-839), which requires a
runner; it names the fake runner the governance tests use and is never run here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from aria_kernel.tool_registry import register_tool

FAKE_RUNNER = Path(__file__).resolve().parent / "fake_tool_runner.py"

DEFAULT_RULE_CONTRACT: dict[str, Any] = {
    "claim_type": "wrong_code",
    "severity_cap": "HIGH",
    "defect_claim": "The cited code does the wrong thing for its callers.",
    "premises": [
        "The cited line performs the operation the finding names.",
        "Nothing upstream of the cited line already prevents the outcome.",
    ],
}


def contracted_tool(
    tool_id: str = "tool-x",
    *,
    rules: dict[str, dict[str, Any]] | None = None,
    declared_scope: list[str] | None = None,
) -> dict[str, Any]:
    scope = declared_scope if declared_scope is not None else ["src/**", "apps/**"]
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": scope,
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": f"fixtures/{tool_id}",
        "health_thresholds": {},
        "allowed_read_globs": list(scope),
        "forbidden_read_globs": [],
        "claim_types": ["test_contract"],
        "owner": "platform",
        "rules": rules if rules is not None else {"rule-a": dict(DEFAULT_RULE_CONTRACT)},
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix()],
            "cwd": ".",
            "timeout_ms": 60000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def register_contracted_tool(
    tools: Path,
    tool_id: str = "tool-x",
    **kwargs: Any,
) -> dict[str, Any]:
    return register_tool(contracted_tool(tool_id, **kwargs), base_dir=tools)
