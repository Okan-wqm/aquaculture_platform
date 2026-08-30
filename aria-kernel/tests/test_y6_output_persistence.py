"""Y6 (ORPHAN-707) — output envelopes survive the run that wrote them.

Second sealed night: 20 bridge replays died ``replay_output_envelope_
unreadable`` because (a) the declared surface pattern ``outputs/*.json``
matched NOTHING the writer produces (``outputs/<group>/*.md``) so no
artifact was ever attested or published, and (b) the result row recorded
an ABSOLUTE host path — machine-local state, dangling on any other root.

Deliberate-breakage pins:
- the manifest pattern matches the writer's real output shape (derived
  from _default_expected_output_path, not asserted by copy);
- result rows record store-relative paths; readers resolve through ONE
  helper; legacy absolute rows still resolve.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    _default_expected_output_path,
    resolve_output_artifact_path,
    store_relative_artifact_path,
)
from aria_kernel.state_manifest import STATE_SURFACES
from aria_kernel.state_snapshot import _surface_entries


def _output_surface():
    for surface in STATE_SURFACES:
        if surface.name == "agent_output_artifacts":
            return surface
    raise AssertionError("agent_output_artifacts surface missing")


class ArtifactPathTests(unittest.TestCase):
    def test_in_store_artifact_is_recorded_relative(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / "agent-invocations" / "outputs" / "general" / "r.md"
            artifact.parent.mkdir(parents=True)
            artifact.write_text("{}", encoding="utf-8")
            recorded = store_relative_artifact_path(root, artifact)
            self.assertEqual(recorded, "agent-invocations/outputs/general/r.md")
            self.assertEqual(resolve_output_artifact_path(root, recorded), artifact.resolve())

    def test_out_of_store_artifact_keeps_absolute_truth(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            outside = Path(tmp) / "elsewhere.md"
            outside.write_text("{}", encoding="utf-8")
            recorded = store_relative_artifact_path(root, outside)
            self.assertTrue(Path(recorded).is_absolute())
            self.assertEqual(resolve_output_artifact_path(root, recorded), outside.resolve())

    def test_legacy_absolute_rows_still_resolve(self) -> None:
        # Rows written before Y6 carry absolute paths; the resolver must
        # pass them through, not relativize history.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            legacy = "/old/host/store/agent-invocations/outputs/general/x.md"
            self.assertEqual(resolve_output_artifact_path(root, legacy), Path(legacy))


class ManifestCoversWriterTests(unittest.TestCase):
    def test_declared_pattern_matches_what_the_writer_writes(self) -> None:
        # The pin derives the artifact location from the WRITER's own path
        # template — a manifest pattern drifting from the writer again
        # (outputs/*.json vs outputs/<group>/*.md, zero matches for weeks)
        # must fail here, not in production replay.
        surface = _output_surface()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            written = Path(
                _default_expected_output_path(
                    root, "AIR-test-1", None, None, "evidence_judgment",
                )
            )
            written.parent.mkdir(parents=True, exist_ok=True)
            written.write_text("{}", encoding="utf-8")
            entries = _surface_entries(surface, root)
            self.assertEqual(len(entries), 1)
            key = entries[0][0]
            self.assertTrue(key.startswith("agent_output_artifacts:"))
            self.assertIn("round-na-evidence_judgment-AIR-test-1.md", key)

    def test_grouped_and_top_level_artifacts_both_attest(self) -> None:
        surface = _output_surface()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            grouped = root / "agent-invocations" / "outputs" / "conv-1" / "round-1-primary_plan-A.md"
            top = root / "agent-invocations" / "outputs" / "loose.md"
            grouped.parent.mkdir(parents=True)
            grouped.write_text("{}", encoding="utf-8")
            top.write_text("{}", encoding="utf-8")
            keys = {key for key, _ in _surface_entries(surface, root)}
            self.assertEqual(len(keys), 2)


if __name__ == "__main__":
    unittest.main()
