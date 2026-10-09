"""ORPHAN-HIGH-573 (validate_file) — operator CLI verb for the V4
file-level narrative-prompt validator.

``narrative_prompt_validator.validate_file`` existed with no CLI verb
attached; the control-reachability waiver expires 2026-10-09. These
tests pin the verb end-to-end through the real ``cli_main`` entry
point — no mocks (same doctrine as
test_cli_tools_dir_position_uniformity).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import main as cli_main


def _run(argv: list[str]) -> tuple[int, str]:
    """Invoke cli_main with stdout/stderr captured; return
    (exit_code, stdout)."""
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli_main(argv) or 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue()


VALID_TIER_1 = """---
name: cli-verb-fixture-agent
pedagogy-tier: 1
---

Short tier-1 body with no narrative prohibition blocks.
"""

MISSING_TIER = """---
name: cli-verb-fixture-agent
---

Body without a pedagogy-tier declaration.
"""


class NarrativePromptValidateVerbTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.tools_dir = self.root / "aria-tools"
        self.tools_dir.mkdir()
        self.registry = self.root / "pedagogy-registry.json"
        self.registry.write_text(
            json.dumps({"consequence_leak_allowlist": []}), encoding="utf-8"
        )

    def _write(self, name: str, text: str) -> Path:
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def _argv(self, agent: Path, registry: str | None = None) -> list[str]:
        argv = [
            "--tools-dir", str(self.tools_dir),
            "narrative-prompt", "validate",
            "--file", str(agent),
        ]
        if registry is not None:
            argv += ["--registry", registry]
        return argv

    def test_valid_file_exits_zero_with_empty_violations(self) -> None:
        agent = self._write("valid-agent.md", VALID_TIER_1)
        code, out = _run(self._argv(agent, str(self.registry)))
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertEqual(payload["violations"], [])
        self.assertEqual(payload["pedagogy_tier"], 1)
        self.assertEqual(payload["violation_count"], 0)

    def test_missing_tier_exits_one_with_violation(self) -> None:
        agent = self._write("missing-tier.md", MISSING_TIER)
        code, out = _run(self._argv(agent, str(self.registry)))
        self.assertEqual(code, 1, out)
        payload = json.loads(out)
        self.assertTrue(payload["violations"])
        self.assertIn("pedagogy-tier", payload["violations"][0])
        self.assertEqual(payload["violation_count"], len(payload["violations"]))

    def test_registry_defaults_to_canonical_agents_path(self) -> None:
        """Without --registry the verb reads
        ``.claude/agents/_pedagogy-registry.json`` under the CWD —
        the same canonical file tools/gates/narrative-prompt-lint.ts
        hardcodes (one registry, not two)."""
        agents_dir = self.root / ".claude" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "_pedagogy-registry.json").write_text(
            json.dumps({"consequence_leak_allowlist": []}), encoding="utf-8"
        )
        agent = self._write("valid-agent.md", VALID_TIER_1)
        old_cwd = os.getcwd()
        os.chdir(self.root)
        try:
            code, out = _run(self._argv(agent))
        finally:
            os.chdir(old_cwd)
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertEqual(payload["violations"], [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
