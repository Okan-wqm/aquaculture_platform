"""The human labeling channel becomes real, in the one vocabulary readers speak.

Four defects, one theme — the operator's path into ground truth was written
about, printed, and never built:

1. The kernel embedded `aria-kernel feedback record …` into every judgment
   sample's operator instructions, and the verb did not exist.
2. The one wired human-verdict path (`resolve_human_required(verdict=…)`)
   had no CLI flag, so Plan 024 §B's ground-truth fan-out was dead from
   every keyboard.
3. `calibration_bootstrap.finalize_corpus` wrote `label`/`labeled_at` rows —
   a schema no ground-truth reader reads: judge_calibration skipped them
   (no source_type), goldset counted them as neither TP nor FP (no verdict).
   Every label an operator ever finalized was invisible.
4. `record_seeding_finding` had zero producers, so the pool the operator was
   supposed to label from was permanently empty.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


class PromisedVerbsExistTest(unittest.TestCase):
    def test_feedback_record_and_batch_are_real_subcommands(self) -> None:
        import ast
        from aria_kernel import cli as cli_mod

        source = Path(cli_mod.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        literals = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertIn("record", literals)
        self.assertIn("record-batch", literals)
        calls = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertIn("record_operator_feedback", calls)
        self.assertIn("record_operator_feedback_batch", calls)

    def test_hr_resolve_carries_the_verdict_flag(self) -> None:
        from aria_kernel import cli as cli_mod

        source = Path(cli_mod.__file__).read_text(encoding="utf-8")
        self.assertIn('"--verdict"', source.replace("'", '"'))
        self.assertIn("verdict=args.verdict", source)


class FinalizeWritesTheCanonicalVocabularyTest(unittest.TestCase):
    def _finalize(self, label: str):
        from aria_kernel import calibration_bootstrap as cb

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            from aria_kernel.tool_registry import ensure_tools_dir
            ensure_tools_dir(root)
            for i in range(10):
                cb.record_seeding_finding(
                    tool_id="adapter-a",
                    finding={"id": f"f{i}", "finding_fingerprint": f"fp-{i}", "run_id": f"r{i}"},
                    base_dir=root,
                )
                cb.label_finding(
                    tool_id="adapter-a",
                    finding_fingerprint=f"fp-{i}",
                    label=label,
                    severity="MEDIUM",
                    base_dir=root,
                )
            summary = cb.finalize_corpus(tool_id="adapter-a", base_dir=root)
            from aria_kernel.strict_jsonl_reader import read_strict_jsonl
            corpus = list(read_strict_jsonl(cb.corpus_path(root), on_corruption="tolerant"))
            return summary, corpus

    def test_tp_labels_become_verdict_rows_readers_can_see(self) -> None:
        summary, corpus = self._finalize("tp")

        self.assertEqual(summary["fixtures_appended"], 10)
        row = corpus[-1]
        self.assertEqual(row["verdict"], "true_positive")
        self.assertEqual(row["source_type"], "human")
        self.assertTrue(row["run_id"])
        self.assertTrue(row["finding_id"])
        self.assertEqual(row["legacy_label"], "tp")

    def test_fp_labels_map_to_false_positive(self) -> None:
        _, corpus = self._finalize("false_positive")

        self.assertEqual(corpus[-1]["verdict"], "false_positive")

    def test_judge_calibration_accepts_the_new_rows(self) -> None:
        # The point of the whole change: the ground-truth filter that used to
        # skip every finalized label must now admit them.
        #
        # JJ-1 (ORPHAN-HIGH-731) REWROTE this pin. It read a source_type
        # ALLOW-LIST that judge_calibration owned privately; that list was one
        # of five copies of "what counts as ground truth", and the copies are
        # exactly why tightening the rule used to miss readers. The successor
        # is the shared predicate, which is also strictly stronger: it asserts
        # the finalized label is USABLE as ground truth, not merely that its
        # source string appears in a tuple.
        from aria_kernel.feedback_store import is_ground_truth_row

        _, corpus = self._finalize("tp")

        self.assertTrue(is_ground_truth_row(corpus[-1]))


class SeedingHasAProducerTest(unittest.TestCase):
    def test_recorded_findings_flow_into_the_seeding_ledger(self) -> None:
        from aria_kernel import calibration_bootstrap as cb
        from aria_kernel.feedback_store import record_findings_for_run
        from aria_kernel.tool_registry import ensure_tools_dir

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            run = {
                "tool_id": "adapter-a",
                "run_id": "run-1",
                "emitted_findings": [{"id": "f1", "title": "t", "evidence": ["apps/x.ts:1"]}],
            }
            record_findings_for_run(run, base_dir=root)

            from aria_kernel.strict_jsonl_reader import read_strict_jsonl
            pool = list(read_strict_jsonl(
                cb.seeding_path(root, "adapter-a"), on_corruption="tolerant",
            ))
            self.assertEqual(len(pool), 1)
            self.assertTrue(pool[0]["finding"]["finding_fingerprint"])


class ReportSectionTest(unittest.TestCase):
    def test_silent_when_no_samples_wait(self) -> None:
        from aria_kernel.reflection import _render_label_queue_section

        with TemporaryDirectory() as tmp:
            self.assertEqual(_render_label_queue_section(Path(tmp)), [])

    def test_renders_the_ready_made_command(self) -> None:
        import json
        from aria_kernel.reflection import _render_label_queue_section

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "judgment-samples.jsonl").write_text(json.dumps({
                "sample_id": "S1", "tool_id": "adapter-a",
                "items": [{"finding_id": "f1", "run_id": "r1"}],
            }) + "\n")
            lines = "\n".join(_render_label_queue_section(root))

        self.assertIn("Labels wanted", lines)
        self.assertIn("feedback record", lines)
        self.assertIn("--finding-id f1", lines)


if __name__ == "__main__":
    unittest.main()
