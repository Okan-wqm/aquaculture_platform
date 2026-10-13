"""ARIA-HIGH-433 — calibration does not hand the drafted adapter its answer key.

``execute_adapter_against_corpus`` piped the corpus fixtures to the adapter
whole, operator labels included (``json.dumps({"fixtures": fixtures})``), and
then scored the adapter's predictions against those same labels. An adapter
that echoed the fingerprints labelled ``tp`` scored precision = recall = 1.0,
the structural exit of the authoring loop, without detecting anything. The
adapter now sees each fixture's location only; the labels stay kernel-side.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.dispatcher_factory import select_sandbox_runner
from aria_kernel.skill_genesis import CALIBRATION_FIXTURE_VISIBLE_FIELDS
from tests.test_genesis_adapter_custody import _git_workspace, _manifest, _requires_backend, accept_drafter_result

# Reads its stdin and answers from whatever judgment it can find there.
ANSWER_KEY_ECHO = """import json
import sys

fixtures = json.loads(sys.stdin.read())["fixtures"]
seen = sorted({key for fixture in fixtures for key in fixture})
judged_tp = [f["finding_fingerprint"] for f in fixtures
             if str(f.get("label") or f.get("legacy_label") or f.get("verdict") or "").lower() in ("tp", "true_positive")]
print(json.dumps({"seen": seen, "findings": [{"finding_fingerprint": fp} for fp in judged_tp]}))
"""


class AnswerKeyTests(unittest.TestCase):
    def setUp(self) -> None:
        _requires_backend(self)
        base = Path(tempfile.mkdtemp(prefix="aria-genesis-key-", dir="/var/tmp"))
        self.addCleanup(shutil.rmtree, base, True)
        self.workspace = _git_workspace(base)
        self.tools = base / "store" / "aria-tools"
        self.corpus = base / "fixtures.jsonl"
        rows = [
            {"finding_fingerprint": f"fp-{n}", "label": label, "verdict": verdict, "legacy_label": label,
             "labeled_at": "2026-10-10T00:00:00Z", "severity": "high", "note": f"operator says {label}",
             "evidence_refs": [f"src/app.ts:{n}"], "finding_id": f"f-{n}"}
            for n, label, verdict in ((1, "tp", "true_positive"), (2, "tp", "true_positive"),
                                      (3, "fp", "false_positive"), (4, "fp", "false_positive"))
        ]
        self.corpus.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        accept_drafter_result(self.tools, "req-key", {"adapter_source": ANSWER_KEY_ECHO, "adapter_manifest": _manifest()})

    def test_the_adapter_sees_where_each_case_is_and_not_how_it_was_judged(self) -> None:
        result = select_sandbox_runner()(
            primary_draft={"invocation_request_id": "req-key"}, calibration_corpus_path=self.corpus,
            workspace_root=self.workspace, base_dir=self.tools,
        )
        self.assertEqual(result["exit_code"], 0, result["raw_stderr_tail"])
        seen = json.loads(result["raw_stdout_tail"])["seen"]
        self.assertEqual(seen, ["evidence_refs", "finding_fingerprint", "finding_id"])
        self.assertTrue(set(seen) <= set(CALIBRATION_FIXTURE_VISIBLE_FIELDS))
        # Echoing the answer key no longer reaches the structural exit.
        self.assertEqual((result["precision"], result["recall"]), (0.0, 0.0))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
