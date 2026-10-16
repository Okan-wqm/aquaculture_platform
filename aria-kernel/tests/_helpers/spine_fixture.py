"""The architecture spine's adapters, as fake tools the REAL tool runner runs.

WHY THIS EXISTS (ARIA-HIGH-045, ARIA-MEDIUM-516). The spine refresh judged its
adapters by a status the store never held and keyed its cache on a snapshot
the adapters never read; tests that mocked ``run_tool`` and
``build_repo_snapshot`` could see neither defect. Here every spine adapter id
the gate declares (``architecture_spine_gate.SPINE_ADAPTER_IDS``) is registered
as a SHADOW tool whose runner is ``fake_tool_runner.py --findings-file
.spine-fixture/<adapter>.json``: the run goes through ``run_tool`` (the room,
the evidence check, ``record_run``) and reports exactly the findings the test
wrote into the workspace. A test changes what an adapter finds by editing the
workspace, committed or not, the way a remediation does.

The room shows only what git tracks (ARIA-MEDIUM-432), so ``register_clean``
commits every findings file; ``set_findings(..., commit=False)`` leaves a
tracked file edited in the working tree.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Sequence

from aria_kernel.architecture_spine_gate import SPINE_ADAPTER_IDS
from aria_kernel.tool_registry import register_tool

from .git_fixtures import commit_files

FAKE_RUNNER = Path(__file__).resolve().parent / "fake_tool_runner.py"
SPINE_FIXTURE_DIR = ".spine-fixture"
SPINE_FIXTURE_VERSION = "1.0.0"
# What a fixture adapter may read: its findings file and the code its
# findings cite. Explicit roots, never "**": a catch-all would lift the
# store's default deny (aria-tools/**) the evidence check relies on.
SPINE_FIXTURE_READ_GLOBS = (f"{SPINE_FIXTURE_DIR}/**", "src/**", "apps/**", "libs/**")


def findings_path(adapter_id: str) -> str:
    """The workspace-relative findings file of one fixture adapter."""
    return f"{SPINE_FIXTURE_DIR}/{adapter_id}.json"


def spine_fixture_tool(adapter_id: str) -> dict[str, Any]:
    """A registrable SHADOW manifest for ``adapter_id`` reading its findings file."""
    return {
        "tool_id": adapter_id,
        "kind": "adapter",
        "version": SPINE_FIXTURE_VERSION,
        "status": "SHADOW",
        "declared_scope": list(SPINE_FIXTURE_READ_GLOBS),
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": f"fixtures/{adapter_id}",
        "health_thresholds": {"max_cost_units": 10},
        "allowed_read_globs": list(SPINE_FIXTURE_READ_GLOBS),
        "forbidden_read_globs": [],
        "claim_types": ["fixture"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix(), "--findings-file", findings_path(adapter_id)],
            "cwd": ".",
            "timeout_ms": 30000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def register_spine_adapters(tools: Path, adapter_ids: Sequence[str] = SPINE_ADAPTER_IDS) -> None:
    """Register the fixture manifests only (no workspace files)."""
    for adapter_id in adapter_ids:
        register_tool(spine_fixture_tool(adapter_id), base_dir=tools)


class SpineFixture:
    """The spine adapters of one test: a git workspace and a tools root."""

    def __init__(self, workspace: Path, tools: Path) -> None:
        self.workspace = workspace
        self.tools = tools

    def register_clean(self) -> None:
        """Every spine adapter registered and reporting no findings, committed."""
        commit_files(
            self.workspace,
            {findings_path(adapter_id): "[]\n" for adapter_id in SPINE_ADAPTER_IDS},
            message="fixture: clean spine adapters",
        )
        register_spine_adapters(self.tools)

    def set_findings(self, adapter_id: str, findings: list[dict[str, Any]], *, commit: bool) -> None:
        """What ``adapter_id`` reports from now on; committed or a working-tree edit."""
        if adapter_id not in SPINE_ADAPTER_IDS:
            raise ValueError(f"not a spine adapter: {adapter_id}")
        content = json.dumps(findings, indent=1, sort_keys=True) + "\n"
        if commit:
            commit_files(self.workspace, {findings_path(adapter_id): content}, message=f"fixture: {adapter_id}")
            return
        target = self.workspace / findings_path(adapter_id)
        if not target.is_file():
            raise ValueError(f"register_clean first: an untracked findings file is not in the room ({target})")
        target.write_text(content, encoding="utf-8")


__all__ = [
    "SPINE_FIXTURE_DIR",
    "SPINE_FIXTURE_VERSION",
    "SpineFixture",
    "findings_path",
    "register_spine_adapters",
    "spine_fixture_tool",
]
