"""ARIA-HIGH-1083 — the judge is shown the line the finding cites.

A sampled adapter finding names its location in ``evidence`` as
``{"path": P, "line": 120}`` (19 of 19 adapters). The item carries it, but the
fan-out reads strings only, so at the branch base (main tip 6c4ca84a1c):

  * ``_evidence_refs(item) == [P]`` and both judge envelopes carry
    ``evidence_refs == [P]``;
  * the mint quotes ONE excerpt, lines 1..80 of a 300-line file, so line 120 is
    not in the bytes the judge is given;
  * the prompt's untrusted block reads ``path:`` and ``message:`` with no line.

These pins state the repaired input: the refs are ``[P, "P:120"]``, the packer
quotes the window around the cited line (80..159) beside the head excerpt, and
the one untrusted block gains one ``line: 120`` row between ``path:`` and
``message:`` — and ONLY for an item whose own path has a line-bearing evidence
ref, so every legacy input renders byte for byte as before (the golden digests
below were measured at the base; they are what keeps the replay lane, the
canary and the stability re-asks measuring the question they measured).

GREEN at the base on purpose (each marked where it is written): the two legacy
golden digests, the "no line-bearing evidence, no line row" cases, the
replay-shaped item, B6 (the calibration scope key does not contain the judge
input: the blend of input regimes is explicit, not silent). Everything else here
is red at the base by assertion.

This module also hosts ``FunnelStoreCase``: the production-shaped store the
three J4 test modules share (``tests.test_promotion_funnel_e2e._Funnel`` over
raw findings seeded through ``record_raw_findings_for_run``, which needs no
sandbox backend, so none of these tests can skip).
"""
from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.feedback_store import (
    _sample_item_from_finding,
    finding_fingerprint,
    record_raw_findings_for_run,
)
from aria_kernel.judge_calibration import _judge_version
from aria_kernel.judge_fanout import _evidence_refs, dispatch_judges_for_sample, judge_request_fields
from aria_kernel.judge_remint import remint_judge_request
from aria_kernel.judge_subject_liveness import JudgeSubjectLiveness
from aria_kernel.request_admission import admit_request
from aria_kernel.rule_contract import resolve_rule_contract
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.anchor_stale_store import EVIDENCE_JUDGE, AnchorStaleStore
from tests._helpers.rule_contracts import register_contracted_tool
from tests.test_promotion_funnel_e2e import SUBJECT, TOOL_ID, _findings, _Funnel, _FunnelCase

P = "apps/farm-service/src/x.service.ts"
# 300 lines of 102 bytes: the per-ref byte cap cuts the head excerpt at line 80.
FILE = "".join(f"// line {index:04d} " + "x" * 88 + "\n" for index in range(1, 301))

ADAPTER_FINDING = {
    "id": "t:x:120", "rule": "rule-a", "severity": "high", "path": P, "line": 120,
    "message": "suspicious", "evidence": [{"path": P, "line": 120}],
}
# The ten keys of the sample item (feedback_store._sample_item_from_finding): no `line` key is added.
ITEM_KEYS = [
    "cycle_id", "evidence", "finding_fingerprint", "finding_id", "message", "path",
    "rule", "run_id", "severity", "tool_id",
]

# Measured at the base: sha256 of the prompt ``judge_request_fields`` renders.
LEGACY_PATH_WITH_LINE_DIGEST = "f414c584ca0e5cc0d96ab2f532be15c6f9c6173b16737e3562946168760e83e4"
LEGACY_NO_EVIDENCE_DIGEST = "20410a27d1ce59473191dd43aaa07678e3c58b81ccca69813f9ba162ee6c8202"
ADAPTER_DICT_EVIDENCE_DIGEST_AT_BASE = "410f8bb6593d52d4a2352cb3f8e76f8f895d8faa68a49ae95c7b5e91b0ffda58"


def _item(**fields: Any) -> dict[str, Any]:
    return {
        "tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "finding_id": "F1", "rule": "rule-a",
        "severity": "medium", "path": "src/f1.py:1", "message": "suspicious",
        "evidence": ["src/f1.py:1"], "finding_fingerprint": "fp1", **fields,
    }


def _adapter_item() -> dict[str, Any]:
    return _item(path=P, evidence=[{"path": P, "line": 120}])


class FunnelStoreCase(_FunnelCase):
    """The production-shaped store: one workspace, one tools dir, raw findings seeded as the adapter run records them.

    ``record_raw_findings_for_run`` under the v1 ledger format keeps the inline
    finding, so the sampler and the fan-out run exactly as in the cycle without
    the sandbox backend ``_Funnel.run_adapter`` needs."""

    def setUp(self) -> None:
        super().setUp()
        self._saved_env["ARIA_RUN_LEDGER_FORMAT"] = os.environ.get("ARIA_RUN_LEDGER_FORMAT")
        os.environ["ARIA_RUN_LEDGER_FORMAT"] = "v1"

    def funnel(self, findings: int = 5) -> _Funnel:
        funnel = _Funnel(self.parent, findings=findings)
        record_raw_findings_for_run(
            {"tool_id": TOOL_ID, "run_id": "run-0", "cycle_id": "cycle-0", "status": "ok"},
            findings=_findings(findings), base_dir=funnel.tools,
        )
        return funnel


class _Tools(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h1083-")
        self.addCleanup(self._tmp.cleanup)
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(self.tools, "tool-x")
        self.repo = Path(self._tmp.name) / "repo"
        target = self.repo / P
        target.parent.mkdir(parents=True)
        target.write_text(FILE, encoding="utf-8")


class TheItemKeepsItsShapeAndItsReaderFindsTheLine(_Tools):
    def test_the_sampled_item_names_the_cited_line_to_the_fanout_and_keeps_its_ten_keys(self) -> None:
        # B1 — the finding's first test.
        item = _sample_item_from_finding("tool-x", "r1", "c1", "F1", ADAPTER_FINDING, "fp1")
        self.assertEqual(_evidence_refs(item), [P, f"{P}:120"])
        self.assertEqual(sorted(item), ITEM_KEYS, "the defect is in the readers; the item gains no `line` key")

    def test_both_judges_are_handed_the_cited_line_and_its_window(self) -> None:
        # B2 — the finding's second test, through the mint. Base: refs [P] and
        # one excerpt (1, 80, truncated); line 120 is not in what the judge reads.
        item = _sample_item_from_finding("tool-x", "r1", "c1", "F1", ADAPTER_FINDING, "fp1")
        dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [item]}, base_dir=self.tools, repo_root=self.repo,
        )
        requests = list_agent_invocation_requests(base_dir=self.tools)
        self.assertEqual(len(requests), 2)
        for request in requests:
            with self.subTest(agent=request["target_agent"]):
                self.assertEqual(request["evidence_refs"], [P, f"{P}:120"])
                excerpts = request["evidence_excerpts"]
                self.assertEqual(len(excerpts), 2)
                self.assertEqual(
                    [(entry["start_line"], entry["end_line"]) for entry in excerpts], [(1, 80), (80, 159)],
                )
                self.assertNotIn("// line 0120 ", excerpts[0]["content"])
                self.assertIn("// line 0120 ", excerpts[1]["content"])

    def test_the_prompt_names_the_line_inside_the_one_untrusted_block(self) -> None:
        # B3 — the row sits between `path:` and `message:`, and the adapter-shaped
        # prompt is no longer the bytes it was.
        contract = resolve_rule_contract(tool_id="tool-x", rule="rule-a", base_dir=self.tools)
        prompt = judge_request_fields(_adapter_item(), contract)["suggested_prompt"]
        self.assertIn(f"path: {P}\nline: 120\nmessage: suspicious", prompt)
        self.assertNotEqual(hashlib.sha256(prompt.encode()).hexdigest(), ADAPTER_DICT_EVIDENCE_DIGEST_AT_BASE)

    def test_the_line_row_is_one_untrusted_row_of_the_block_not_a_prompt_line(self) -> None:
        contract = resolve_rule_contract(tool_id="tool-x", rule="rule-a", base_dir=self.tools)
        prompt = judge_request_fields(_adapter_item(), contract)["suggested_prompt"]
        block = prompt.split("<untrusted_finding>", 1)[1].split("</untrusted_finding>", 1)[0]
        self.assertIn("\nline: 120\n", block)
        self.assertEqual(prompt.count("\nline: "), 1)

    def test_legacy_inputs_render_byte_for_byte_as_before(self) -> None:
        # GREEN at the base on purpose: the pins that make "legacy inputs
        # unchanged" a test. A path that carries its own `:line`, and an item
        # with no line-bearing evidence, are not given a `line:` row.
        contract = resolve_rule_contract(tool_id="tool-x", rule="rule-a", base_dir=self.tools)
        for name, item, digest in (
            ("path with its own line and string evidence", _item(), LEGACY_PATH_WITH_LINE_DIGEST),
            ("a path and no evidence", _item(path="src/f1.py", evidence=[]), LEGACY_NO_EVIDENCE_DIGEST),
        ):
            with self.subTest(name):
                prompt = judge_request_fields(item, contract)["suggested_prompt"]
                self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(), digest)

    def test_an_item_whose_evidence_names_no_line_for_its_own_path_gets_no_line_row(self) -> None:
        # GREEN at the base on purpose: nothing is added unless the owner's
        # `cited_line` names a line (a stray top-level `line` is not read).
        contract = resolve_rule_contract(tool_id="tool-x", rule="rule-a", base_dir=self.tools)
        for name, item in (
            ("a dict without a line", _item(path=P, evidence=[{"path": P}])),
            ("a line of another file only", _item(path=P, evidence=[{"path": "a/c.ts", "line": 7}])),
            ("a bool is not a line", _item(path=P, evidence=[{"path": P, "line": True}])),
            ("a top-level `line` the evidence does not carry", _item(path=P, evidence=[{"path": P}], line=99)),
            ("an item with no path", _item(path="", evidence=[{"path": P, "line": 120}])),
        ):
            with self.subTest(name):
                prompt = judge_request_fields(item, contract)["suggested_prompt"]
                self.assertNotIn("\nline: ", prompt)

    def test_the_replay_lane_builds_an_item_that_has_no_line_row(self) -> None:
        # GREEN at the base on purpose: judge_replay builds a path-and-message
        # item (no evidence); replay recall keeps measuring the question it
        # measured, pinned by the legacy digests above.
        contract = resolve_rule_contract(tool_id="tool-x", rule="rule-a", base_dir=self.tools)
        replay_item = {
            "tool_id": "tool-x", "run_id": "r1", "finding_id": "F1", "rule": "rule-a",
            "severity": "medium", "path": P, "message": "suspicious",
        }
        prompt = judge_request_fields(replay_item, contract)["suggested_prompt"]
        self.assertNotIn("\nline: ", prompt)


class TheProductionShapedMintCarriesTheLine(FunnelStoreCase):
    def test_every_sampled_finding_is_judged_with_its_own_cited_line(self) -> None:
        # B4 — through the sampler and the fan-out as the cycle runs them.
        funnel = self.funnel(findings=5)
        requests = funnel.mint_judges()
        self.assertEqual(len(requests), 10, "five findings, two judges each")
        for index in range(1, 6):
            with self.subTest(finding=f"F-{index}"):
                seats = [request for request in requests if request["finding_id"] == f"F-{index}"]
                self.assertEqual(len(seats), 2)
                for request in seats:
                    self.assertEqual(request["evidence_refs"], [SUBJECT, f"{SUBJECT}:{index}"])
                    self.assertIn(f"\nline: {index}\n", request["suggested_prompt"])


class AReMintedJudgeIsHandedTheLineToo(AnchorStaleStore):
    """B5 — the anchor-stale sweep re-mints through the same readers."""

    def setUp(self) -> None:
        super().setUp()
        self.finding = dict(ADAPTER_FINDING, id="F1")
        self.fingerprint = finding_fingerprint("tool-x", self.finding)
        ledger_format = patch.dict(os.environ, {"ARIA_RUN_LEDGER_FORMAT": "v1"})
        ledger_format.start()
        self.addCleanup(ledger_format.stop)
        record_raw_findings_for_run(
            {"tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "status": "ok"},
            [self.finding], base_dir=self.tools,
        )
        sampled = _sample_item_from_finding("tool-x", "r1", "c1", "F1", self.finding, self.fingerprint)
        result = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [sampled]}, base_dir=self.tools, target_sha=self.first_sha,
        )
        self.dead = {m["target_agent"]: m["request_id"] for m in result["minted"]}[EVIDENCE_JUDGE]

    def test_the_successor_carries_the_refs_and_the_prompt_the_fanout_mints_today(self) -> None:
        self.commit()
        self.expire(self.dead)
        self.sweep()
        successor = self.successors(self.dead)[0]
        self.assertEqual(successor["evidence_refs"], [P, f"{P}:120"])
        self.assertIn("\nline: 120\n", successor["suggested_prompt"])
        sampled = _sample_item_from_finding("tool-x", "r1", "c1", "F1", self.finding, self.fingerprint)
        contract = resolve_rule_contract(tool_id="tool-x", rule="rule-a", base_dir=self.tools)
        self.assertEqual(successor["suggested_prompt"], judge_request_fields(sampled, contract)["suggested_prompt"])

    def test_an_extra_ref_the_panel_adds_still_comes_last(self) -> None:
        successor = remint_judge_request(
            self.row(self.dead),
            subjects=JudgeSubjectLiveness(base_dir=self.tools, now=datetime.now(timezone.utc)),
            target_sha=self.first_sha,
            workspace=self.repo,
            admission=admit_request("anchor_stale.remint", "evidence_judgment", base_dir=self.tools),
            extra_evidence_refs=("human-required:AIR-x",),
        )
        self.assertEqual(successor["evidence_refs"], [P, f"{P}:120", "human-required:AIR-x"])


class TheCalibrationScopeKeyDoesNotContainTheJudgeInput(unittest.TestCase):
    def test_two_rows_that_differ_only_in_the_input_share_one_version(self) -> None:
        # B6 — GREEN at the base on purpose. `_judge_version` is (model,
        # agent_contract_hash): a change of the judge input does not open a new
        # calibration version, so before/after rows of one judge are scored as
        # one population. This pin makes that blend explicit (the lead accepted
        # it while `calibration_gate` is `measure_only`; the split by input
        # regime is pre-registered as a read-only analysis, not widened here).
        row = {"model": "m", "agent_contract_hash": "h", "evidence_refs": [P]}
        self.assertEqual(_judge_version(row), ("m", "h"))
        self.assertEqual(
            _judge_version({**row, "evidence_refs": [P, f"{P}:120"], "request_ids": ["AIR-1"]}),
            _judge_version({**row, "evidence_refs": [P], "request_ids": ["AIR-2"]}),
        )


if __name__ == "__main__":
    unittest.main()
