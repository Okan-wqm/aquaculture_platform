"""The weekly eval has to leave something behind.

For as long as this workflow has existed it wrote five rows to `runs.jsonl`
inside an ephemeral checkout and discarded them with the runner.
`compare_eval_windows` needs five runs PER WINDOW before it will speak, so
`agent-eval delta` was structurally condemned to `insufficient_evidence`
whenever CI was the only producer: the baseline lived on one operator's disk
and nowhere else. Two PRs were individually coherent and jointly inert.

Removing the publish step restores that state exactly, and the workflow-contract
suite does not notice — it governs permissions, preflight ordering and upload
shape, not whether a lane persists what it measured. So these assert the three
things that decide whether the measurement survives the runner.
"""
from __future__ import annotations

import unittest
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github/workflows/aria-agent-eval.yml"


def _steps() -> list[dict]:
    doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    return list(doc["jobs"]["eval"]["steps"])


def _step_text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


class AgentEvalPersistenceTest(unittest.TestCase):
    def test_restores_the_accumulated_ledger_before_measuring(self) -> None:
        # Without the restore the eval starts from an empty tree every week and
        # each run is window one of one, forever.
        uses = [s.get("uses", "") for s in _steps()]

        self.assertIn("./.github/actions/restore-aria-state", uses)

    def test_publishes_what_it_measured(self) -> None:
        # The step this asserts is the one whose absence is invisible: the
        # workflow still runs, still prints, still passes, and remembers
        # nothing.
        self.assertIn("aria_kernel state publish", _step_text())

    def test_publishes_even_when_a_fixture_regressed(self) -> None:
        # A week where a fixture broke is exactly the week the trend needs. A
        # ledger that only records good weeks is not a measurement.
        publish = next(
            s for s in _steps() if s.get("name", "").startswith("Publish ARIA state")
        )

        self.assertIn("always()", str(publish.get("if", "")))

    def test_every_tools_dir_names_the_store_binding(self) -> None:
        # The trap this closes: one literal `--tools-dir aria-tools` sends that
        # command's writes back into the ephemeral checkout while the rest of
        # the job uses the durable store — half-persisted, and green.
        text = _step_text()

        self.assertNotIn("--tools-dir aria-tools", text)
        self.assertIn('--tools-dir "$ARIA_TOOLS_DIR"', text)

    def test_asks_for_the_delta_it_now_has_the_evidence_for(self) -> None:
        # Persisting without ever comparing would be the same defect one step
        # later: data accumulating that nothing reads.
        self.assertIn("agent-eval delta", _step_text())


if __name__ == "__main__":
    unittest.main()
