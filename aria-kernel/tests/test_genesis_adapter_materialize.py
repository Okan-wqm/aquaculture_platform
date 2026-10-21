"""ARIA-HIGH-414 — a drafted adapter registers only as the bytes its passing
calibration ran, and reaches ACTIVE only on an operator act or the panel.

The materializer of draft PR #1900 (head fbfef05c5) wrote the drafted source
into ``<workspace>/tools/aria-adapters/<id>.py``, followed symlinks, left the
files behind when ``register_tool`` failed, kept the drafter's timeout, and
"verified" a sha256 it had written itself. It is superseded by
``genesis_adapter_custody.materialize_drafted_adapter``: no adapter file is
written at all (the bytes live in a hash-chained custody row), the digest
must be the passing calibration's, the scope and timeout come from the seed,
and a refused registration withdraws its custody. Promotion then needs an
operator act or the panel; the auto-promote token alone is refused.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.dispatcher_factory import select_sandbox_runner
from aria_kernel.genesis_adapter_custody import (
    GENESIS_ADAPTER_TIMEOUT_MS_DEFAULT,
    GENESIS_RUNNER_BASE,
    GenesisCustodyRefusal,
    genesis_custody,
    materialize_drafted_adapter,
    source_sha256,
    verify_genesis_promotion,
)
from aria_kernel.tool_registry import GovernanceError, get_tool, list_tools, register_tool, transition_tool
from aria_kernel.tool_runner import run_tool
from tests._helpers.active_evidence import stand_in_active_evidence
from tests._helpers.sandbox_pins import require_sandbox_backend
from tests.test_genesis_adapter_custody import (
    GOOD_SOURCE,
    _git_workspace,
    _manifest,
    accept_drafter_result,
)

TOOL_ID = "genesis-room-adapter"
SEED = {"seed_id": "seed-room", "declared_scope": ["src/app.ts"], "claim_types": ["fixture"]}


def _drafted_manifest(**overrides) -> dict:
    manifest = _manifest()
    manifest.update({
        "read_paths": ["src/app.ts"],
        "health_thresholds": {"precision_min": {"min": 0.0, "max": 0.0}, "max_cost_units": {"min": 0, "max": 10}},
        # What the drafter asked for; the kernel binds all of these.
        "declared_scope": ["**"], "allowed_read_globs": ["**"], "owner": "drafter", "status": "ACTIVE",
        # ARIA-LOW-533 — a drafter may not declare its adapter cuttable.
        "security_class": False,
        "runner": {"type": "subprocess", "argv": ["python3", "tools/aria-poc/elsewhere.py"], "cwd": ".",
                   "timeout_ms": 99_999_999, "stdin_json": True},
    })
    manifest.update(overrides)
    return manifest


class _MaterializeLayout(unittest.TestCase):
    def setUp(self) -> None:
        require_sandbox_backend()
        base = Path(tempfile.mkdtemp(prefix="aria-genesis-mat-", dir="/var/tmp"))
        self.addCleanup(shutil.rmtree, base, True)
        self.base = base
        self.workspace = _git_workspace(base)
        self.tools = base / "store" / "aria-tools"
        self.corpus = base / "fixtures.jsonl"
        self.corpus.write_text(json.dumps({"finding_fingerprint": "fp-1", "label": "tp"}) + "\n", encoding="utf-8")

    def _calibrate(self, request_id: str, source: str = GOOD_SOURCE, manifest: dict | None = None) -> dict:
        accept_drafter_result(self.tools, request_id, {"adapter_source": source, "adapter_manifest": manifest or _drafted_manifest()})
        return select_sandbox_runner()(
            primary_draft={"invocation_request_id": request_id}, calibration_corpus_path=self.corpus,
            workspace_root=self.workspace, base_dir=self.tools,
        )


    def _materialize(self, request_id: str, sandbox_result: dict, seed: dict | None = None) -> dict:
        return materialize_drafted_adapter(
            primary_draft={"invocation_request_id": request_id}, seed=seed or SEED, base_dir=self.tools,
            sandbox_result=sandbox_result,
        )

    def _calibrate_passing(self, request_id: str, **kwargs) -> tuple[dict, str]:
        # GOOD_SOURCE predicts nothing (recorded precision 0.0); this one
        # predicts the corpus's one TP, so its RECORDED calibration passes.
        source = GOOD_SOURCE.replace('"findings": []', '"findings": [{"finding_fingerprint": "fp-1"}]')
        return self._calibrate(request_id, source=source, **kwargs), source


class MaterializeTests(_MaterializeLayout):
    def test_registers_the_calibrated_bytes_as_a_seed_bound_shadow_tool_and_writes_no_file(self) -> None:
        result, source = self._calibrate_passing("req-m1")
        self.assertEqual((result["precision"], result["exit_code"]), (1.0, 0), result["raw_stderr_tail"])
        before = {path for path in self.base.rglob("*") if path.is_file()}
        materialized = self._materialize("req-m1", result)
        written = {path for path in self.base.rglob("*") if path.is_file()} - before
        tool = get_tool(TOOL_ID, self.tools)
        self.assertEqual(tool["status"], "SHADOW")
        self.assertEqual((tool["declared_scope"], tool["allowed_read_globs"]), (["src/app.ts"], ["src/app.ts"]))
        self.assertEqual(tool["runner"], {**GENESIS_RUNNER_BASE, "timeout_ms": GENESIS_ADAPTER_TIMEOUT_MS_DEFAULT})
        self.assertEqual(tool["owner"], "skill_genesis")
        self.assertEqual(tool["health_thresholds"]["precision_min"], 0.85, "the kernel's bar, not the drafter's")
        # The security class is kernel-owned: undeclared, so the calibration
        # actuator never cuts the drafted adapter (ARIA-LOW-533).
        self.assertNotIn("security_class", tool)
        # THE PIN: the registered digest IS the passing calibration's digest.
        custody = genesis_custody(TOOL_ID, base_dir=self.tools)
        self.assertEqual(custody["adapter_sha256"], result["adapter_sha256"])
        self.assertEqual(custody["adapter_sha256"], source_sha256(source))
        self.assertEqual(custody["calibration_ledger_hash"], result["calibration_ledger_hash"])
        self.assertEqual(materialized["adapter_sha256"], result["adapter_sha256"])
        # No adapter file anywhere: nothing to swap, nothing to follow. The
        # store gains ledger and registry rows only.
        self.assertEqual([p for p in written if not p.is_relative_to(self.tools)], [])
        self.assertEqual([p for p in written if p.suffix == ".py"], [])
        # And it runs, as those bytes, through the launcher.
        envelope = run_tool(TOOL_ID, {"repo_snapshot": {"allowed_paths": ["src/app.ts"], "snapshot_mode": "committed",
                                                        "snapshot_hash": "sha256:mat"}},
                            "cyc-mat", workspace_root=self.workspace, base_dir=self.tools)["envelope"]
        self.assertEqual(envelope["runner"]["genesis_adapter_sha256"], result["adapter_sha256"])

    def test_a_seed_timeout_binds_the_runner(self) -> None:
        result, _source = self._calibrate_passing("req-m2")
        self._materialize("req-m2", result, seed={**SEED, "timeout_ms": 120_000})
        self.assertEqual(get_tool(TOOL_ID, self.tools)["runner"]["timeout_ms"], 120_000)

    def test_bytes_other_than_the_calibrated_bytes_are_refused(self) -> None:
        passing, _source = self._calibrate_passing("req-m3")
        # The drafter's next result carries other bytes; it borrows the
        # passing calibration of the first.
        accept_drafter_result(self.tools, "req-m3b", {"adapter_source": GOOD_SOURCE + "\n# other\n",
                                                      "adapter_manifest": _drafted_manifest()})
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_calibration_mismatch"):
            self._materialize("req-m3b", passing)
        self.assertEqual([t for t in list_tools(base_dir=self.tools) if t["tool_id"] == TOOL_ID], [])

    def test_a_calibration_that_did_not_pass_on_its_own_record_is_refused(self) -> None:
        failing = self._calibrate("req-m4")  # predicts nothing: recorded precision 0.0
        # A sandbox result that CLAIMS a pass does not make one: the
        # materializer reads the recorded row.
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_calibration_not_passing"):
            self._materialize("req-m4", {**failing, "precision": 1.0})

    def test_a_tool_id_that_is_not_a_slug_or_is_taken_registers_nothing(self) -> None:
        for index, tool_id in enumerate(("../../escaped", "a/b", "Upper", "x", None)):
            with self.subTest(tool_id=tool_id):
                request_id = f"req-slug-{index}"
                result, _source = self._calibrate_passing(request_id, manifest=_drafted_manifest(tool_id=tool_id))
                with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_tool_id_invalid"):
                    self._materialize(request_id, result)
        taken = _manifest()
        taken["tool_id"] = TOOL_ID
        register_tool(taken, base_dir=self.tools)
        result, _source = self._calibrate_passing("req-taken")
        with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_tool_id_taken"):
            self._materialize("req-taken", result)

    def test_a_failed_registration_withdraws_its_custody(self) -> None:
        result, _source = self._calibrate_passing("req-m5")
        with mock.patch("aria_kernel.tool_registry.register_tool", side_effect=GovernanceError("registry_locked")):
            with self.assertRaisesRegex(GovernanceError, "registry_locked"):
                self._materialize("req-m5", result)
        self.assertEqual(genesis_custody(TOOL_ID, base_dir=self.tools)["event"], "withdrawn")
        # Re-running registers it cleanly (the custody row supersedes again).
        self._materialize("req-m5", result)
        self.assertEqual(genesis_custody(TOOL_ID, base_dir=self.tools)["event"], "custody")
        self.assertEqual(self._materialize("req-m5", result)["already_registered"], True)


class PromotionAuthorityTests(_MaterializeLayout):
    """SHADOW -> ACTIVE of drafted code: an operator act or the panel."""

    def setUp(self) -> None:
        super().setUp()
        result, _source = self._calibrate_passing("req-p")
        self._materialize("req-p", result)
        # The subject is the authority gate; the ACTIVE evidence gate
        # (ARIA-HIGH-004) is stood in, as the operator's act is.
        stand_in_active_evidence(self)

    def test_the_auto_promote_token_alone_is_refused_before_it_is_verified(self) -> None:
        with mock.patch("aria_kernel.adapter_calibration.verify_auto_promote_token") as verify:
            with self.assertRaisesRegex(GovernanceError, "genesis_adapter_promotion_requires_operator_or_panel"):
                transition_tool(TOOL_ID, "ACTIVE", reason="auto", base_dir=self.tools, auto_promote_token="tok",
                                precision=1.0, evidence_chains_valid=True)
        verify.assert_not_called()

    def test_an_operator_act_reaches_the_operator_verifier(self) -> None:
        proof = {"kind": "gh", "ref": "gh:o/r#1/comment/2"}
        with mock.patch("aria_kernel.operator_approval.verify_operator_approval", return_value=proof) as verify:
            row = transition_tool(TOOL_ID, "ACTIVE", reason="operator", base_dir=self.tools,
                                  operator_approval_ref="gh:o/r#1/comment/2", precision=1.0, evidence_chains_valid=True)
        verify.assert_called_once()
        self.assertEqual(row["status"], "ACTIVE")

    def test_a_forged_panel_string_beside_a_verified_auto_token_is_refused(self) -> None:
        # The wave-2 reproduction of item 6: the genesis gate counted the
        # panel token's PRESENCE, the predicate then counted the verified
        # auto token, and drafted code reached ACTIVE with neither an
        # operator act nor the panel.
        verified = {"tool_id": TOOL_ID}
        with mock.patch("aria_kernel.adapter_calibration.verify_auto_promote_token", return_value=verified):
            with self.assertRaisesRegex(GovernanceError, "genesis_adapter_promotion_requires_operator_or_panel"):
                transition_tool(TOOL_ID, "ACTIVE", reason="auto", base_dir=self.tools, auto_promote_token="tok",
                                panel_approval_token="forged", precision=1.0, evidence_chains_valid=True)
        self.assertEqual(get_tool(TOOL_ID, self.tools)["status"], "SHADOW")

    def test_a_forged_operator_ref_beside_a_verified_auto_token_is_refused(self) -> None:
        verified = {"tool_id": TOOL_ID}
        with mock.patch("aria_kernel.adapter_calibration.verify_auto_promote_token", return_value=verified):
            with self.assertRaisesRegex(GovernanceError, "tool_transition_approval_unrecorded"):
                transition_tool(TOOL_ID, "ACTIVE", reason="auto", base_dir=self.tools, auto_promote_token="tok",
                                operator_approval_ref="garbage", precision=1.0, evidence_chains_valid=True)
        self.assertEqual(get_tool(TOOL_ID, self.tools)["status"], "SHADOW")

    def test_the_authority_check_reads_verified_authority_never_a_string(self) -> None:
        # The reopen note's own probe, at the function: a ref or a panel
        # string is not authority; only a resolved act or a verified panel is.
        for operator_approval, panel in ((None, False), ("gh:o/r#1/comment/2", False), (None, "forged")):
            with self.subTest(operator_approval=operator_approval, panel=panel):
                with self.assertRaisesRegex(GenesisCustodyRefusal, "genesis_adapter_promotion_requires_operator_or_panel"):
                    verify_genesis_promotion(TOOL_ID, operator_approval=operator_approval, panel_promote_verified=panel)
        verify_genesis_promotion(TOOL_ID, operator_approval={"kind": "gh"}, panel_promote_verified=False)
        verify_genesis_promotion(TOOL_ID, operator_approval=None, panel_promote_verified=True)

    def test_a_verified_panel_token_promotes(self) -> None:
        pending = {"tool_id": TOOL_ID}
        with mock.patch("aria_kernel.promotion_veto.verify_panel_approval_token", return_value=pending) as verify:
            row = transition_tool(TOOL_ID, "ACTIVE", reason="panel", base_dir=self.tools,
                                  panel_approval_token="minted", precision=1.0, evidence_chains_valid=True)
        verify.assert_called_once()
        self.assertEqual(row["status"], "ACTIVE")

    def test_custody_that_no_longer_verifies_blocks_promotion_before_the_act_is_spent(self) -> None:
        tool = get_tool(TOOL_ID, self.tools)
        tool["runner"] = {**tool["runner"], "timeout_ms": 1}
        from aria_kernel.tool_registry import _update_tool_internal

        _update_tool_internal(TOOL_ID, {"runner": tool["runner"]}, self.tools)
        with mock.patch("aria_kernel.operator_approval.verify_operator_approval") as verify:
            with self.assertRaisesRegex(GovernanceError, "genesis_adapter_runner_drift"):
                transition_tool(TOOL_ID, "ACTIVE", reason="operator", base_dir=self.tools,
                                operator_approval_ref="gh:o/r#1/comment/2", precision=1.0, evidence_chains_valid=True)
        verify.assert_not_called()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
