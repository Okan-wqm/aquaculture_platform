"""Plan ARIA-V7 §3 V7.5 — corpus-aware + evidence-pack pre-flight invariants.

Five invariants pin the chicken-and-egg break:

  * I-V7.5-01 — missing corpus + sufficient evidence-pack → authoring
                proceeds; result carries corpus_proxy="evidence_pack"
  * I-V7.5-02 — missing corpus + insufficient evidence-pack →
                skipped_evidence_insufficient verdict (NOT crash,
                NOT silent skip)
  * I-V7.5-03 — corpus present + sanity passing → standard authoring
                path (no corpus_proxy)
  * I-V7.5-04 — evidence-pack-only authoring marked in result
  * I-V7.5-05 — operator-visible counts in result
                (requests_skipped_evidence_insufficient)

Plus ARIA-HIGH-470: the corpus sanity pre-flight reads fixtures through the strict
JSONL reader, names a corrupt row instead of crashing, takes its floor from
convergent_skill_authoring.MIN_CALIBRATION_FIXTURES, and writes corruption
diagnostics to the tools store, never into the operator's corpus directory.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _drafter_ok(**kwargs):
    return {
        "draft_id": "ok", "role": "primary",
        "rules": [{"claim_class": "test_claim", "summary": "r"}],
        "evidence_refs": ["fixture/src.py:2:line"],
        "peer_audit": [], "critiques": [],
    }


def _judge_ok(**kwargs):
    return {"verdict": "no_gaps", "gaps": []}


def _sandbox_ok(**kwargs):
    return {
        "fixture_count": 10, "precision": 1.0, "recall": 1.0,
        "critical_false_positives": 0,
        "false_positives": [], "false_negatives": [],
    }


class PhaseV7_5CorpusAndEvidencePack(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v7_5-"))
        self.base = self.tmp / "aria-tools"
        self.workspace = self.tmp / "ws"
        self.workspace.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.email", "v7-5@example.com"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.name", "v7-5"], cwd=self.workspace, check=True)
        # 12 test_claim observations so evidence-pack succeeds.
        (self.workspace / "fixture").mkdir(exist_ok=True)
        (self.workspace / "fixture" / "src.py").write_text(
            "\n".join(["# fixture"] + [f"# test_claim observation {i}" for i in range(12)]),
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=self.workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "fixture"], cwd=self.workspace, check=True)
        self._env_snapshot = clear_aria_tools_env()
        set_profile("standard", operator_approval_ref="v7_5-test", base_dir=self.base)

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _mint_request(self, request_id, *, corpus_path, claim_types=None,
                      declared_scope=None):
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now
        from tests._helpers.declared_fixtures import append_declared_fixture
        root = ensure_tools_dir(self.base)
        path = root / "skill-genesis" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "schema_version": 1, "recorded_at": utc_now(),
            "request_id": request_id,
            "capability_gap_key": f"gap-{request_id}",
            "title": f"Request {request_id}",
            "status": "requested", "convergent": True,
            "seed": {
                "seed_id": request_id, "title": "T",
                "capability_gap_key": f"gap-{request_id}",
                "declared_scope": declared_scope or ["fixture/"],
                "claim_types": claim_types or ["test_claim"],
                "must_satisfy": [{"id": "m1", "description": "d"}],
                "calibration_corpus_path": corpus_path,
            },
        }
        return append_declared_fixture(
            path,
            row,
            expected_surface="skill_genesis_requests",
        )

    # I-V7.5-01 — missing corpus + sufficient evidence-pack → proceed.
    def test_i_v7_5_01_missing_corpus_evidence_pack_proceeds(self) -> None:
        """Plan ARIA-V7 §3 V7.5 — chicken-and-egg break."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        self._mint_request("req-no-corpus", corpus_path=str(self.tmp / "no-such-corpus"))
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-5-01",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
        )
        # Authoring proceeded (dispatched ≥1).
        self.assertGreaterEqual(
            result["requests_dispatched"], 1,
            msg=(
                "Plan ARIA-V7 §3 V7.5 — missing corpus + sufficient "
                "evidence-pack MUST allow authoring to proceed. "
                f"Got: {result}"
            ),
        )

    # I-V7.5-02 — missing corpus + insufficient evidence-pack → skip.
    def test_i_v7_5_02_missing_corpus_insufficient_evidence_skips(self) -> None:
        """Plan ARIA-V7 §3 V7.5 — operator-visible verdict, NO crash."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        # Use claim_type that doesn't match anything in the workspace.
        self._mint_request(
            "req-no-evidence",
            corpus_path=str(self.tmp / "no-such-corpus"),
            claim_types=["nonexistent_pattern_xyz"],
        )
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-5-02",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
        )
        self.assertEqual(result["requests_dispatched"], 0)
        self.assertGreaterEqual(
            result["requests_skipped_evidence_insufficient"], 1,
            msg=(
                "Plan ARIA-V7 §3 V7.5 — missing corpus + insufficient "
                "evidence-pack MUST surface as skipped_evidence_"
                f"insufficient (NO crash, NO silent skip). Got: {result}"
            ),
        )

    # I-V7.5-03 — corpus present → no corpus_proxy.
    def test_i_v7_5_03_corpus_present_no_proxy(self) -> None:
        """Plan ARIA-V7 §3 V7.5 — sane corpus → standard authoring."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        # Create a valid corpus directory with fixtures.jsonl.
        corpus_dir = self.tmp / "real-corpus"
        corpus_dir.mkdir()
        # validate_calibration_corpus_sanity requires ≥10 fixtures,
        # ≥20% TP, ≥20% FP, label freshness ≤90d, no dups.
        from aria_kernel.tool_registry import utc_now
        fixtures = []
        for i in range(12):
            label = "tp" if i % 2 == 0 else "fp"
            fixtures.append({
                "finding_fingerprint": f"fp-{i}",
                "label": label, "severity": "HIGH",
                "labeled_at": utc_now(),
            })
        (corpus_dir / "fixtures.jsonl").write_text(
            "\n".join(json.dumps(f) for f in fixtures) + "\n",
            encoding="utf-8",
        )
        self._mint_request("req-real-corpus", corpus_path=str(corpus_dir))
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-5-03",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
        )
        # When corpus is sane, authoring runs WITHOUT corpus_proxy flag.
        for ar in result["authoring_results"]:
            self.assertNotIn(
                "corpus_proxy", ar,
                msg=(
                    "Plan ARIA-V7 §3 V7.5 — sane corpus MUST NOT mark "
                    "authoring_result with corpus_proxy. "
                    f"Got: {ar}"
                ),
            )

    # I-V7.5-04 — evidence-pack-only marked.
    def test_i_v7_5_04_evidence_pack_only_marked(self) -> None:
        """Plan ARIA-V7 §3 V7.5 — operator-visible corpus_proxy flag."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        self._mint_request("req-mark", corpus_path=str(self.tmp / "no-such-corpus"))
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-5-04",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
        )
        proxy_marked = any(
            ar.get("corpus_proxy") == "evidence_pack"
            for ar in result["authoring_results"]
        )
        self.assertTrue(
            proxy_marked,
            msg=(
                "Plan ARIA-V7 §3 V7.5 — evidence-pack-only authoring "
                "MUST mark result with corpus_proxy='evidence_pack' "
                "for operator visibility. SHADOW promotion is gated "
                "until operator labels output."
            ),
        )

    # I-V7.5-05 — operator-visible counts.
    def test_i_v7_5_05_operator_visible_counts(self) -> None:
        """Plan ARIA-V7 §3 V7.5 — result carries counts for reflection v3."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-5-05",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
        )
        # Counts must exist in shape (zero is fine; absence is not).
        for key in (
            "requests_skipped_corpus_missing",
            "requests_skipped_evidence_insufficient",
            "requests_skipped_token_budget",
            "requests_skipped_already_terminal",
            "tokens_spent_this_cycle",
        ):
            self.assertIn(
                key, result,
                msg=(
                    f"Plan ARIA-V7 §3 V7.5 — result MUST carry {key!r} "
                    "for reflection v3 operator visibility."
                ),
            )


class CorpusSanityReaderTests(unittest.TestCase):
    """ARIA-HIGH-470 — validate_calibration_corpus_sanity on untrusted corpus rows."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.corpus = self.tmp / "corpus"
        self.corpus.mkdir()
        self.tools = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, extra_lines: list[str]) -> None:
        from aria_kernel.tool_registry import utc_now

        rows = [
            json.dumps({
                "finding_fingerprint": f"fp-{i}",
                "label": "tp" if i % 2 == 0 else "fp",
                "labeled_at": utc_now(),
            })
            for i in range(12)
        ]
        (self.corpus / "fixtures.jsonl").write_text(
            "\n".join([*rows, *extra_lines]) + "\n", encoding="utf-8",
        )

    def _sanity(self) -> dict:
        from aria_kernel.skill_genesis import validate_calibration_corpus_sanity

        return validate_calibration_corpus_sanity(corpus_path=self.corpus, base_dir=self.tools)

    def test_a_non_object_row_is_named_not_a_crash(self) -> None:
        self._write(["[1,2]"])
        result = self._sanity()
        self.assertEqual(result["status"], "failed")
        self.assertIn("fixture_row_corrupt", result["reasons"])

    def test_a_non_object_row_beside_transport_text_is_corruption(self) -> None:
        # Text naming the replay transport takes the reader's transport
        # branch; the reader applies the same row contract there, so the
        # pre-flight sees the same named corruption, not a passed-through row.
        from aria_kernel.ledger import REPLAY_TRANSPORT_SCHEMA_PREFIX

        self._write([json.dumps({"note": REPLAY_TRANSPORT_SCHEMA_PREFIX}), "[1,2]"])
        result = self._sanity()
        self.assertEqual(result["status"], "failed")
        self.assertIn("fixture_row_corrupt", result["reasons"])

    def test_corrupt_row_diagnostic_lands_in_the_tools_store(self) -> None:
        self._write(["{not json"])
        result = self._sanity()
        self.assertIn("fixture_row_corrupt", result["reasons"])
        self.assertFalse((self.corpus / "diagnostics").exists())
        self.assertTrue((self.tools / "diagnostics").is_dir())

    def test_fixture_floor_has_one_owner(self) -> None:
        import ast
        import inspect
        import textwrap

        from aria_kernel import skill_genesis

        tree = ast.parse(textwrap.dedent(inspect.getsource(skill_genesis.validate_calibration_corpus_sanity)))
        func = tree.body[0]
        defaults = {
            arg.arg: default
            for arg, default in zip(func.args.kwonlyargs, func.args.kw_defaults)
            if default is not None
        }
        self.assertIsInstance(defaults["min_fixtures"], ast.Name)
        self.assertEqual(defaults["min_fixtures"].id, "MIN_CALIBRATION_FIXTURES")


if __name__ == "__main__":
    unittest.main()
