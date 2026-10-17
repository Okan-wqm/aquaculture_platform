"""ARIA-LOW-547 — a run artifact is published only after the boundary's two refusals.

``runtime_artifacts.write_run_artifact`` writes ``run-artifacts/hot/**/*.json``,
a published surface (``state_manifest`` ``runtime_artifact_hot``), from
``scrub_json(payload)``. ``scrub_json`` rewrites values only, so a credential in
a mapping key was published verbatim, and so was a refusal hit that only the
encoding forms (``ensure_ascii`` writes an e-circumflex as an escape that ends
in ``a``). ``artifact_safety.write_sanitized_json`` refused both; the run-artifact
writer did not. Both writers now encode through one boundary function, and a
refusal takes the writer's existing ``write_failed`` path: nothing is written
and the error names a shape type, never the value.

Credential-shaped strings are assembled from parts, so this file's text
matches no detection shape.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import artifact_safety, runtime_artifacts
from aria_kernel.runtime_artifacts import write_run_artifact
from aria_kernel.runtime_profile import set_profile

_KEY_CREDENTIAL = "gh" + "p_" + "Kq7" * 12
# No raw substring is a refusal hit; JSON's ASCII escape of the e-circumflex
# ends in "a", and the escaped bytes read "...aws_secret_access_key=".
_ESCAPE_FORMED = "x" + chr(0xEA) + "ws_secret_access_key" + "=" + chr(0x1A)


class RunArtifactRefusalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-run-artifact-refusal-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def _write(self, payload: dict, run_id: str) -> dict:
        return write_run_artifact(
            base_dir=self.base, run_id=run_id, cycle_uid="cyc-547", tool_id="tool-a",
            kind="tool_run", payload=payload, run_status="ok",
        )

    def _hot_files(self) -> list[Path]:
        return sorted((self.base / "run-artifacts" / "hot").rglob("*.json")) if (self.base / "run-artifacts").exists() else []

    def test_a_credential_in_a_mapping_key_is_refused_not_published(self) -> None:
        for nested, payload in ((False, {_KEY_CREDENTIAL: 1}), (True, {"outer": [{_KEY_CREDENTIAL: "v"}]})):
            with self.subTest(nested=nested):
                result = self._write(payload, run_id="run-key")
                self.assertEqual(result["artifact_status"], "write_failed")
                self.assertIsNone(result["artifact_ref"])
                self.assertIn("artifact_credential_in_key", result["artifact_error"])
                self.assertNotIn(_KEY_CREDENTIAL, result["artifact_error"])
                self.assertEqual(self._hot_files(), [])

    def test_a_refusal_hit_the_encoding_forms_is_refused_not_published(self) -> None:
        result = self._write({"detail": _ESCAPE_FORMED}, run_id="run-escape")
        self.assertEqual(result["artifact_status"], "write_failed")
        self.assertIsNone(result["artifact_ref"])
        self.assertIn("artifact_credential_shape_unredacted", result["artifact_error"])
        self.assertEqual(self._hot_files(), [])

    def test_a_clean_payload_is_still_published_with_its_hash(self) -> None:
        result = self._write({"detail": "token " + _KEY_CREDENTIAL, "count_tokens": 7}, run_id="run-clean")
        self.assertEqual(result["artifact_status"], "present")
        written = self.base / result["artifact_ref"]["uri"]
        raw = written.read_text(encoding="utf-8")
        self.assertNotIn(_KEY_CREDENTIAL, raw)
        self.assertEqual(json.loads(raw)["payload"]["count_tokens"], 7)

    def test_both_published_json_writers_encode_through_the_one_boundary(self) -> None:
        boundary = artifact_safety.sanitized_json_text
        with mock.patch.object(runtime_artifacts, "sanitized_json_text", wraps=boundary) as run_writer, \
                mock.patch.object(artifact_safety, "sanitized_json_text", wraps=boundary) as envelope_writer:
            self._write({"detail": "ok"}, run_id="run-one-boundary")
            artifact_safety.write_sanitized_json(self.tmp / "envelope.json", {"summary": "ok"})
        self.assertEqual((run_writer.call_count, envelope_writer.call_count), (1, 1))


if __name__ == "__main__":
    unittest.main()
