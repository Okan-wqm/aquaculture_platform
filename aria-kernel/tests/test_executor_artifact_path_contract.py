"""The executor's artifact paths must come from the executor, not from YAML.

The upload step rebuilt the envelope path from the request id
(`outputs/<request_id>.json`) while `agent_invocations.expected_output_path`
names `outputs/<group>/<round>-<role>-<request_id>.md`. With
`if-no-files-found: error` that made every executor run red at the last step,
after the agent had run and the result had been submitted — and the contract
registry pinned the WRONG spelling, so the gate certified the mismatch.

These tests pin the derivation instead of a literal: the producer publishes
where it wrote, and the workflow consumes that.
"""

from __future__ import annotations

import os
import re
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github/workflows/aria-agent-executor.yml"
EXECUTOR = REPO_ROOT / "tools/aria-poc/ci_executor.py"


def _load_publisher():
    import importlib.util

    spec = importlib.util.spec_from_file_location("ci_executor_under_test", EXECUTOR)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._publish_artifact_paths


class ExecutorArtifactPathContractTest(unittest.TestCase):
    def test_workflow_uploads_the_paths_the_executor_reports(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        upload_block = workflow.split("Upload response envelope", 1)[1].split("retention-days", 1)[0]

        self.assertIn("${{ steps.executor.outputs.envelope_path }}", upload_block)
        self.assertIn("${{ steps.executor.outputs.transcript_path }}", upload_block)

    def test_workflow_never_respells_the_envelope_path_itself(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")

        # The exact shape that shipped broken: an outputs/ path assembled in
        # YAML out of the request id.
        respelled = re.findall(
            r"agent-invocations/outputs/\$\{\{ steps\.pending\.outputs\.request_id \}\}",
            workflow,
        )

        self.assertEqual(respelled, [])

    def test_the_run_step_is_identified_so_its_outputs_are_addressable(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        run_block = workflow.split("- name: Run CI executor", 1)[1].split("- name:", 1)[0]

        self.assertIn("id: executor", run_block)

    def test_publisher_emits_workspace_relative_paths(self) -> None:
        publish = _load_publisher()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            output_file = workspace / "gh-output.txt"
            envelope = workspace / ".aria-state-store/tools/agent-invocations/outputs/general/round-na-role-AIR-x.md"
            transcript = envelope.with_suffix(".transcript.jsonl")
            envelope.parent.mkdir(parents=True, exist_ok=True)

            previous = {k: os.environ.get(k) for k in ("GITHUB_OUTPUT", "GITHUB_WORKSPACE")}
            os.environ["GITHUB_OUTPUT"] = str(output_file)
            os.environ["GITHUB_WORKSPACE"] = str(workspace)
            try:
                publish(envelope, transcript)
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

            emitted = output_file.read_text(encoding="utf-8")

        # Relative, because upload-artifact resolves against the workspace and
        # an absolute path outside it uploads nothing while looking fine.
        self.assertIn(
            "envelope_path=.aria-state-store/tools/agent-invocations/outputs/general/"
            "round-na-role-AIR-x.md",
            emitted,
        )
        self.assertIn("transcript_path=", emitted)
        self.assertNotIn(f"envelope_path={workspace}", emitted)

    def test_publisher_is_silent_outside_actions(self) -> None:
        # Running the executor locally must not require a GITHUB_OUTPUT file.
        publish = _load_publisher()
        previous = os.environ.pop("GITHUB_OUTPUT", None)
        try:
            publish(Path("/tmp/envelope.md"), Path("/tmp/envelope.transcript.jsonl"))
        finally:
            if previous is not None:
                os.environ["GITHUB_OUTPUT"] = previous


if __name__ == "__main__":
    unittest.main()
