"""ARIA-LOW-509 — every mock switch a workflow or a runbook sets is one some code reads.

The v3.1 smoke runbook ran its dry-run ``autonomy run`` with
``CLAUDE_CODE_MOCK=true`` and said that sent the LLM calls through the mock
path. No code reads that name: the switch is ``CLAUDE_CLI_MOCK``
(``tools/aria-poc/claude_runtime.py``, default ``0``), so the documented smoke
dispatched every claimed planner request to the live ``claude`` binary, and
only ``unshare --net`` kept it offline. A wrong name for a mock switch fails
open: the run is live and reads as mocked.

The pin: every ``*_MOCK`` name assigned in a workflow ``env:`` block or on a
runbook command line is either read by code (an env read or an env-name
constant in a non-test source file) or read by the same step's own script
(a shell local such as a ``workflow_dispatch`` input).
"""

from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the live checkout
# outside the kernel surface, so it runs in aria-kernel.yml's always-run
# `workspace` job (aria_kernel.live_partition), never in a skippable shard.
READS_LIVE_CHECKOUT = 'git grep over the live workflows, runbooks and code for mock switches'

import re
import subprocess
import unittest
from pathlib import Path
from typing import Any, Iterator

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MOCK_NAME = re.compile(r"^[A-Z][A-Z0-9_]*_MOCK$")
_RUNBOOK_ASSIGNMENT = re.compile(r"(?:^|[\s;(])(?:export\s+)?([A-Z][A-Z0-9_]*_MOCK)=")
_FENCE = re.compile(r"```(?:bash|sh|shell|console)?\n(.*?)```", re.S)
_CODE_PATHSPECS = ("*.py", "*.ts", "*.js", "*.mjs", "*.cjs", "*.sh")
_NOT_CODE = (":!docs/**", ":!**/tests/**", ":!**/__tests__/**", ":!**/*.spec.ts", ":!**/*.test.ts", ":!e2e/**")


def _env_blocks(node: Any) -> Iterator[tuple[dict[str, Any], str]]:
    """Every ``env:`` mapping in a workflow, with the ``run:`` script beside it ('' when none)."""
    if isinstance(node, dict):
        env = node.get("env")
        if isinstance(env, dict):
            yield env, str(node.get("run") or "")
        for value in node.values():
            yield from _env_blocks(value)
    elif isinstance(node, list):
        for item in node:
            yield from _env_blocks(item)


def _reads(script: str, name: str) -> bool:
    return re.search(r"\$\{?" + re.escape(name) + r"\b", script) is not None


def _read_by_code(name: str) -> bool:
    pattern = rf"([\"']{name}[\"']|process\.env\.{name}\b|\$\{{?{name}\b)"
    proc = subprocess.run(
        ["git", "-C", str(_REPO_ROOT), "grep", "-l", "-E", pattern, "--", *_CODE_PATHSPECS, *_NOT_CODE],
        capture_output=True, text=True, timeout=120, check=False,
    )
    if proc.returncode not in (0, 1):
        raise AssertionError(f"git grep failed: {proc.stderr}")
    return bool(proc.stdout.strip())


def mock_assignments(repo_root: Path = _REPO_ROOT) -> list[tuple[str, str, bool]]:
    """``(where, name, read_by_the_same_step)`` for every ``*_MOCK`` a workflow or runbook sets."""
    found: list[tuple[str, str, bool]] = []
    for workflow in sorted((repo_root / ".github" / "workflows").glob("*.y*ml")):
        document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
        for env, script in _env_blocks(document):
            for name in env:
                if _MOCK_NAME.match(str(name)):
                    found.append((workflow.relative_to(repo_root).as_posix(), str(name), _reads(script, str(name))))
    for runbook in sorted((repo_root / "docs" / "runbooks").rglob("*.md")):
        for block in _FENCE.findall(runbook.read_text(encoding="utf-8")):
            for name in sorted(set(_RUNBOOK_ASSIGNMENT.findall(block))):
                found.append((runbook.relative_to(repo_root).as_posix(), name, _reads(block, name)))
    return found


class MockSwitchNameTests(unittest.TestCase):
    def test_every_mock_switch_set_by_a_workflow_or_runbook_is_read(self) -> None:
        assignments = mock_assignments()
        self.assertTrue(any(name == "CLAUDE_CLI_MOCK" for _, name, _ in assignments),
                        "the scan finds the mock switch the lanes set")
        unread = sorted({f"{where}: {name}" for where, name, local in assignments
                         if not local and not _read_by_code(name)})
        self.assertEqual(unread, [], "a mock switch nothing reads leaves the run live while it reads as mocked")

    def test_the_scan_sees_both_shapes_and_a_step_local_input(self) -> None:
        # The two spellings the smoke runbook and the operational proof used.
        self.assertEqual(_RUNBOOK_ASSIGNMENT.findall("ARIA_DRY_RUN=true CLAUDE_CODE_MOCK=true \\\n  unshare --net"),
                         ["CLAUDE_CODE_MOCK"])
        step = {"steps": [{"env": {"INPUT_MOCK": "${{ inputs.mock }}"}, "run": 'echo "${INPUT_MOCK:-}"'}]}
        self.assertEqual([(sorted(env), _reads(run, "INPUT_MOCK")) for env, run in _env_blocks(step)],
                         [(["INPUT_MOCK"], True)])
        self.assertTrue(_read_by_code("CLAUDE_CLI_MOCK"))
        self.assertFalse(_read_by_code("CLAUDE_CODE_MOCK"))


if __name__ == "__main__":
    unittest.main()
