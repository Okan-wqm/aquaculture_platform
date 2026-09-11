"""Plan ARIA-V3.1-C2 — MemoryHook orchestrator wire invariants.

Closes architectural anchors from V3.1-C that need orchestrator-side
invocation:

* Production MemoryHookImpl that chains bounded reader → stability
  check → record_convention → verify_chain_or_quarantine →
  skill_genesis HUMAN_REQUIRED dispatch in the correct order
  (V3.1-C HIGH-005 cycle-own-row-exclusion + MEDIUM-012 post-record
  verify + ai-safety HIGH-005 skill-genesis HUMAN_REQUIRED gate).
* Orchestrator post-CONVERGED body invokes memory_hook.record()
  BEFORE specialist_review_started so the V10 memory pillar fires
  per CONVERGED cycle.
* select_memory_hook factory dispatches observe/frozen → NoOp,
  others → MemoryHookImpl.

Invariants:

* I-V31-C2-01 — MemoryHookImpl source pipeline order:
  read_governance_rows_reverse → check_pattern_signature_stability
  → record_convention → verify_chain_or_quarantine.
* I-V31-C2-02 — skill_genesis dispatch goes through
  record_human_required (NOT direct registry.json write).
* I-V31-C2-03 — orchestrator body invokes memory_hook.record()
  BEFORE specialist_review_started.
* I-V31-C2-04 — select_memory_hook(profile=observe) returns NoOp.
* I-V31-C2-05 — MemoryHookImpl.record() returns the canonical
  result dict shape when invoked on an empty workspace.
* I-V31-C2-06 — stable=True triggers record_human_required call
  (behavioral, patched primitives).
"""
from __future__ import annotations

import inspect
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def _complete_memory_concurrently(base: Path, fingerprint: str, barrier, reports) -> None:
    from aria_kernel import knowledge_graph
    from aria_kernel.cycle_phases.memory import MemoryHookImpl
    append = knowledge_graph.record_convention

    def synchronize(pattern, **kwargs):
        barrier.wait(timeout=20)
        return append(pattern, **kwargs)

    report = {}
    try:
        with patch.object(knowledge_graph, "record_convention", side_effect=synchronize):
            MemoryHookImpl().complete_pending_observations(
                base_dir=base, signer_cycle_id="original", signer_key_fp=fingerprint, report=report,
            )
        reports.put(report)
    except Exception as exc:
        reports.put({"unexpected_error_class": type(exc).__name__})
        raise


class MemoryHookImplPipelineOrderTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-01 — pipeline order assertion."""

    def test_i_v31_c2_01_pipeline_order_correct(self) -> None:
        """Execute the shared operation: exclude the own row from stability,
        and verify only after the real append has returned.
        """
        from aria_kernel import governance_reader, knowledge_graph
        from aria_kernel.cycle_phases import memory
        from tests.test_implementation_lifecycle_continuity import drive_plan_to_converged, seed_reviewer_agent

        with tempfile.TemporaryDirectory(prefix="memory-order-") as directory:
            workspace = Path(directory)
            base = workspace / "aria-tools"
            seed_reviewer_agent(workspace)
            drive_plan_to_converged(
                plan_id="order", tools=base, workspace_root=workspace,
                plan_content={
                    "schema_version": 1, "title": "Order fixture", "summary": "Observe reviewed evidence",
                    "affected_surfaces": ["x.py"],
                    "key_changes": [{"id": "k1", "description": "d", "paths": ["x.py"]}],
                    "validation_commands": [{"cmd": "echo", "timeout_ms": 1000, "expected_exit": 0}],
                    "evidence_refs": [f"x.py:{line}" for line in range(1, 6)],
                },
            )
            path = base / "knowledge-graph/conventions.jsonl"
            order = []
            read = governance_reader.read_governance_rows_reverse
            append = knowledge_graph.record_convention
            verify = knowledge_graph.verify_chain_or_quarantine

            def read_rows(**kwargs):
                order.append("read")
                return read(**kwargs)

            def stability(**kwargs):
                self.assertFalse(path.exists(), "the cycle must not influence its own stability check")
                order.append("stability")
                return {"stable": False}

            def record(*args, **kwargs):
                self.assertEqual(order, ["read", "stability"])
                result = append(*args, **kwargs)
                order.append("append")
                return result

            def check(ledger):
                self.assertEqual(order, ["read", "stability", "append"])
                self.assertTrue(path.is_file())
                order.append("verify")
                return verify(ledger)

            with (
                patch.object(governance_reader, "read_governance_rows_reverse", side_effect=read_rows),
                patch("aria_kernel.skill_genesis_drainer.check_pattern_signature_stability", side_effect=stability),
                patch.object(knowledge_graph, "record_convention", side_effect=record),
                patch.object(knowledge_graph, "verify_chain_or_quarantine", side_effect=check),
            ):
                result = memory.MemoryHookImpl().record(
                    cycle_id="order", plan_id="order", workspace_root=workspace,
                    base_dir=base, plan_envelope_metadata={}, profile="standard",
                    signer_key_fp="SHA256:order-fixture",
                )
            self.assertEqual(order, ["read", "stability", "append", "verify"])
            self.assertTrue(result["chain_verified"])

    def test_i_v31_c2_02_skill_genesis_dispatch_via_human_required(self) -> None:
        """Plan ARIA-V3.1-C2-02 — skill genesis activation goes
        through record_human_required (NOT a direct write to
        aria-tools/registry.json). Closes ai-safety HIGH-005:
        operator-reviewed PR before adapter activation."""
        from aria_kernel.cycle_phases import memory
        src = inspect.getsource(memory.MemoryHookImpl.record)
        self.assertIn("record_human_required", src,
                      "MemoryHookImpl missing record_human_required call")
        self.assertIn("skill_genesis_adapter_authoring", src,
                      "MemoryHookImpl missing canonical HUMAN_REQUIRED reason")
        # Must NOT write to registry.json directly.
        self.assertNotIn("registry.json", src,
                         "MemoryHookImpl leaked direct registry write — "
                         "operator review bypass")


class OrchestratorMemoryHookWireTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-03 — orchestrator post-CONVERGED wire."""

    def test_i_v31_c2_03_orchestrator_invokes_memory_hook_before_specialist(self) -> None:
        """Plan ARIA-V3.1-C2-03 — the orchestrator body calls
        memory_hook.record() BEFORE specialist_review_started so the
        V10 memory contribution lands per cycle even when specialist
        review later rejects."""
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        idx_memory = src.find("memory_hook.record(")
        idx_specialist = src.find('phase="specialist_review_started"')
        self.assertGreater(idx_memory, 0,
                           "orchestrator missing memory_hook.record() call")
        self.assertGreater(idx_specialist, 0)
        self.assertLess(
            idx_memory, idx_specialist,
            "memory_hook.record() MUST fire BEFORE specialist_review_started "
            "(V31-C2 ordering anchor)",
        )

    def test_i_v31_c2_03_memory_hook_wrapped_in_try_except(self) -> None:
        """Plan ARIA-V3.1-C2-03 — memory_hook failure must not block
        specialist_review + worker + auto_merge. The wire is wrapped
        in try/except + emits memory_hook_failed governance event."""
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        # The try block immediately before memory_hook.record(...)
        idx_memory = src.find("memory_hook.record(")
        # Look backwards 200 chars for `try:` open.
        preamble = src[max(0, idx_memory - 200):idx_memory]
        self.assertIn("try:", preamble,
                      "memory_hook.record() not wrapped in try/except")
        # memory_hook_failed governance event present.
        self.assertIn("memory_hook_failed", src)


class MemoryHookFactoryTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-04 — select_memory_hook factory dispatch."""

    def test_i_v31_c2_04_observe_returns_noop(self) -> None:
        from aria_kernel.cycle_phases import (
            NoOpMemoryHook, MemoryHookImpl, select_memory_hook,
        )
        self.assertIsInstance(select_memory_hook(profile="observe"), NoOpMemoryHook)
        self.assertIsInstance(select_memory_hook(profile="frozen"), NoOpMemoryHook)
        # All non-passive profiles get the production impl.
        for profile in ("standard", "strict", "autonomous"):
            self.assertIsInstance(
                select_memory_hook(profile=profile), MemoryHookImpl,
                f"profile={profile!r} expected MemoryHookImpl",
            )


class MemoryHookImplBehavioralTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-05+06 — behavioral path tests with mocked
    primitives (kernel state machine drive too deep for this scope)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v31c2-")).resolve()
        self.base = self.tmp / "aria-tools"
        from aria_kernel.tool_registry import ensure_tools_dir
        ensure_tools_dir(self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _converge(self, plan_id: str) -> None:
        from tests.test_implementation_lifecycle_continuity import (
            drive_plan_to_converged, seed_reviewer_agent,
        )

        seed_reviewer_agent(self.tmp)
        drive_plan_to_converged(
            plan_id=plan_id, tools=self.base, workspace_root=self.tmp,
            plan_content={
                "schema_version": 1, "title": "t", "summary": "x",
                "affected_surfaces": ["x.py"],
                "key_changes": [{"id": "k1", "description": "d", "paths": ["x.py"]}],
                "validation_commands": [{"cmd": "echo", "timeout_ms": 1000, "expected_exit": 0}],
                "evidence_refs": [f"x.py:{line}" for line in range(1, 6)],
            },
        )

    def test_i_v31_c2_05_returns_canonical_dict_shape(self) -> None:
        """Plan ARIA-V3.1-C2-05 — record() returns a dict with the
        documented keys regardless of stability/convention outcome."""
        from aria_kernel.cycle_phases import MemoryHookImpl
        self._converge("plan-test")
        hook = MemoryHookImpl()
        result = hook.record(
            cycle_id="cyc-test", plan_id="plan-test",
            workspace_root=self.tmp, base_dir=self.base,
            plan_envelope_metadata={"_pressure_source_type": "git_diff"},
            profile="standard",
            signer_key_fp=None,  # No signing → record_convention skipped.
        )
        for key in (
            "status", "pattern_signature", "stability_result",
            "convention_recorded", "chain_verified",
            "skill_genesis_dispatched", "rows_scanned",
        ):
            self.assertIn(key, result, f"result missing key {key!r}")
        # signer_key_fp absent → no convention recorded.
        self.assertFalse(result["convention_recorded"])
        self.assertEqual(result["status"], "needs_signing")
        self.assertIsNone(result["chain_verified"])

    def test_real_key_fingerprint_records_only_a_hypothesis(self) -> None:
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.knowledge_graph import lookup_pattern

        self._converge("plan-fingerprint")
        key = mint_signing_key(cycle_id="cyc-fingerprint", workspace_root=self.tmp)
        try:
            result = MemoryHookImpl().record(
                cycle_id="cyc-fingerprint", plan_id="plan-fingerprint",
                workspace_root=self.tmp, base_dir=self.base,
                plan_envelope_metadata={}, profile="standard",
                signer_key_fp=key.fingerprint,
            )
        finally:
            revoke_signing_key(cycle_id="cyc-fingerprint", workspace_root=self.tmp)
        self.assertEqual(result["status"], "memory_hook_recorded")
        self.assertTrue(result["convention_recorded"])
        self.assertTrue(result["chain_verified"])
        pattern = lookup_pattern(
            f"conv_cyc-fingerprint_{result['pattern_signature'][:16]}",
            workspace_root=self.tmp, min_confidence=0.0,
        )
        self.assertIsNotNone(pattern)
        self.assertEqual(pattern["signer_key_fp"], key.fingerprint)
        self.assertEqual(pattern["plan_id"], "plan-fingerprint")
        self.assertEqual(pattern["outcome_status"], "hypothesis")
        self.assertEqual(pattern["confidence"], 0.5)

    def _pending_observation(self, plan_id: str = "pending", cycle_id: str = "original") -> object:
        from aria_kernel.cycle_phases import MemoryHookImpl
        self._converge(plan_id)
        hook = MemoryHookImpl()
        hook.record(cycle_id=cycle_id, plan_id=plan_id, workspace_root=self.tmp,
                    base_dir=self.base, plan_envelope_metadata={}, profile="standard",
                    signer_key_fp=None)
        return hook

    def test_pending_append_truth_survives_both_audit_failures(self) -> None:
        from aria_kernel import tool_registry
        from aria_kernel.ledger import load_jsonl
        hook = self._pending_observation()
        append = tool_registry.append_tools_governance
        report = {}

        def audit(base, kind, details, **kwargs):
            if kind in {"convention_recorded", "convention_audit_failed"}:
                raise OSError("harmless-private-diagnostic-sentinel")
            return append(base, kind, details, **kwargs)

        with patch.object(tool_registry, "append_tools_governance", side_effect=audit):
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="original",
                                               signer_key_fp="SHA256:fixture", report=report)
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1)
        observation = report["observations"][0]
        self.assertTrue(observation["convention_recorded"])
        self.assertEqual(observation["status"], "convention_audit_failed")
        self.assertEqual(observation["audit_error_class"], "OSError")
        self.assertEqual(report["status"], "completed_with_errors")
        before = (self.base / "knowledge-graph/conventions.jsonl").read_bytes()
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="original",
                                           signer_key_fp="SHA256:later-fixture", report={})
        self.assertEqual((self.base / "knowledge-graph/conventions.jsonl").read_bytes(), before)

    def test_completed_observation_replay_returns_receipt_without_new_attempt(self) -> None:
        from aria_kernel import knowledge_graph, tool_registry
        from aria_kernel.ledger import load_jsonl

        hook = self._pending_observation()
        pending = [row["details"] for row in load_jsonl(self.base / "governance.jsonl")
                   if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(len(pending), 1)
        first = {}
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="first-owner",
                                           signer_key_fp="SHA256:first-fixture", report=first)
        self.assertEqual(first["status"], "completed")
        self.assertEqual(first["attempted"], 1)
        self.assertTrue(first["observations"][0]["append_attempted"])
        paths = [self.base / relative for relative in (
            "governance.jsonl", "plans/events.jsonl", "knowledge-graph/conventions.jsonl",
        )]
        before = {path: path.read_bytes() for path in paths}
        rows = load_jsonl(paths[-1])
        self.assertEqual(len(rows), 1)
        original = rows[0]
        self.assertEqual(original["outcome_status"], "hypothesis")
        self.assertEqual(original["confidence"], 0.5)
        self.assertEqual(original["signer_key_fp"], "SHA256:first-fixture")

        second = {}
        with (
            patch.object(knowledge_graph, "record_convention", wraps=knowledge_graph.record_convention) as writer,
            patch.object(tool_registry, "append_tools_governance", wraps=tool_registry.append_tools_governance) as audit,
        ):
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="second-owner",
                                               signer_key_fp="SHA256:second-fixture", report=second)
        writer.assert_not_called()
        audit.assert_not_called()
        self.assertEqual(second["status"], "completed")
        self.assertEqual(second["attempted"], 0)
        self.assertEqual(second["already_recorded"], 1)
        self.assertEqual(len(second["observations"]), 1)
        receipt = second["observations"][0]
        self.assertEqual(receipt["status"], "already_recorded")
        self.assertTrue(receipt["convention_recorded"])
        self.assertTrue(receipt["chain_verified"])
        self.assertFalse(receipt["append_attempted"])
        for key in ("cycle_id", "plan_id", "plan_revision_id", "plan_content_hash", "pattern_signature"):
            self.assertEqual(receipt[key], pending[0][key])
        self.assertEqual(receipt["pending_event_hash"], first["observations"][0]["pending_event_hash"])
        self.assertEqual(receipt["convergence_event_hash"], first["observations"][0]["convergence_event_hash"])
        self.assertEqual(receipt["signer_cycle_id"], "second-owner")
        self.assertEqual(receipt["signer_key_fp"], "SHA256:second-fixture")
        self.assertEqual(original["discovered_by_cycle_id"], receipt["cycle_id"])
        self.assertEqual(original["pattern_id"], f"conv_{receipt['cycle_id']}_{receipt['pattern_signature'][:16]}")
        self.assertEqual({path: path.read_bytes() for path in paths}, before)
        self.assertEqual(load_jsonl(paths[-1]), [original])

    def test_pending_operation_failure_keeps_only_public_error_provenance(self) -> None:
        import json
        from aria_kernel import knowledge_graph
        from aria_kernel.ledger import load_jsonl
        hook = self._pending_observation()
        report = {}
        sentinel = "harmless-private-diagnostic-sentinel"
        with patch.object(knowledge_graph, "record_convention", side_effect=OSError(sentinel)):
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="original",
                                               signer_key_fp="SHA256:fixture", report=report)
        observation = report["observations"][0]
        self.assertFalse(observation["convention_recorded"])
        self.assertEqual(observation["status"], "convention_record_failed")
        self.assertNotIn(sentinel, json.dumps(report))
        failures = [row for row in load_jsonl(self.base / "governance.jsonl")
                    if row.get("kind") == "convention_record_failed"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["details"]["error_class"], "OSError")
        self.assertNotIn(sentinel, json.dumps(failures))
        self.assertEqual(observation["error_class"], "OSError")

    def test_pending_attempts_rotate_failures_without_starving_older_waiters(self) -> None:
        from aria_kernel import knowledge_graph
        from aria_kernel.cycle_phases import memory
        from aria_kernel.ledger import load_jsonl
        for plan in ("a", "b", "c"):
            hook = self._pending_observation(plan, "cycle-" + plan)
        append = knowledge_graph.record_convention
        attempted = []

        def persist(pattern, **kwargs):
            attempted.append(pattern.plan_id)
            if pattern.plan_id in {"a", "b"}:
                raise OSError("fixture repeated failure")
            return append(pattern, **kwargs)

        with (
            patch.object(memory, "PENDING_OBSERVATION_ATTEMPT_LIMIT", 2, create=True),
            patch.object(knowledge_graph, "record_convention", side_effect=persist),
        ):
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later-1",
                                               signer_key_fp="SHA256:fixture-1", report={})
            self.assertEqual(attempted, ["a", "b"])
            self._pending_observation("d", "cycle-d")
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later-2",
                                               signer_key_fp="SHA256:fixture-2", report={})
            self.assertEqual(attempted, ["a", "b", "c", "a"])
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later-3",
                                               signer_key_fp="SHA256:fixture-3", report={})
            self.assertEqual(attempted, ["a", "b", "c", "a", "b", "d"])
        self.assertEqual({row["plan_id"] for row in load_jsonl(self.base / "knowledge-graph/conventions.jsonl")},
                         {"c", "d"})
        attempts = [row["details"] for row in load_jsonl(self.base / "governance.jsonl")
                    if row.get("kind") == "convention_observation_attempted"]
        self.assertEqual([row["plan_id"] for row in attempts], attempted)

    def test_pending_attempt_audit_failure_stops_batch_before_knowledge_write(self) -> None:
        import json
        from aria_kernel import tool_registry
        hook = self._pending_observation()
        append = tool_registry.append_tools_governance
        report = {}

        def audit(base, kind, details, **kwargs):
            if kind == "convention_observation_attempted":
                raise OSError("harmless-private-diagnostic-sentinel")
            return append(base, kind, details, **kwargs)

        with patch.object(tool_registry, "append_tools_governance", side_effect=audit):
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later",
                                               signer_key_fp="SHA256:fixture", report=report)
        self.assertEqual(report["status"], "audit_error")
        self.assertEqual(report["audit_error_class"], "OSError")
        self.assertFalse((self.base / "knowledge-graph/conventions.jsonl").exists())
        self.assertNotIn("harmless-private-diagnostic-sentinel", json.dumps(report))
        retry = {}
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later-restart",
                                           signer_key_fp="SHA256:retry", report=retry)
        self.assertTrue(retry["observations"][0]["convention_recorded"])

    def test_pending_selection_rejects_truncated_governance_snapshot(self) -> None:
        from aria_kernel.ledger import LedgerIntegrityError
        hook = self._pending_observation()
        path = self.base / "governance.jsonl"
        path.write_bytes(path.read_bytes() + b'{"partial":')
        before = path.read_bytes()
        with self.assertRaises(LedgerIntegrityError):
            hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later",
                                               signer_key_fp="SHA256:fixture", report={})
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.base / "knowledge-graph/conventions.jsonl").exists())

    def test_success_audit_without_observation_cannot_suppress_later_retry(self) -> None:
        from aria_kernel.ledger import load_jsonl
        from aria_kernel.tool_registry import append_tools_governance
        hook = self._pending_observation()
        append_tools_governance(self.base, "convention_recorded", {
            "cycle_id": "original", "plan_id": "pending", "pattern_id": "forged-success",
        })
        report = {}
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later",
                                           signer_key_fp="SHA256:fixture", report=report)
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["discovered_by_cycle_id"], "original")
        self.assertTrue(report["observations"][0]["convention_recorded"])

    def test_concurrent_completions_keep_one_original_hypothesis(self) -> None:
        import multiprocessing
        from aria_kernel.ledger import load_jsonl
        self._pending_observation()
        context = multiprocessing.get_context("fork")
        barrier = context.Barrier(2)
        reports = context.Queue()
        workers = [context.Process(target=_complete_memory_concurrently,
                                   args=(self.base, f"SHA256:fixture-{i}", barrier, reports)) for i in range(2)]
        try:
            for worker in workers:
                worker.start()
            results = [reports.get(timeout=40) for _ in workers]
            for worker in workers:
                worker.join(timeout=10)
                self.assertEqual(worker.exitcode, 0)
            for report in results:
                self.assertEqual(report["status"], "completed")
                self.assertTrue(report["observations"][0]["convention_recorded"])
            rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["discovered_by_cycle_id"], "original")
            self.assertEqual(rows[0]["outcome_status"], "hypothesis")
            self.assertEqual(rows[0]["confidence"], 0.5)
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                worker.join(timeout=5)
            reports.close()

    def test_successful_convention_with_failed_audit_reports_audit_failure(self) -> None:
        from aria_kernel import tool_registry
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.ledger import load_jsonl

        self._converge("plan-audit-failure")
        key = mint_signing_key(cycle_id="cyc-audit-failure", workspace_root=self.tmp)
        original = tool_registry.append_tools_governance

        def fail_success_audit(base_dir, kind, details, **kwargs):
            if kind == "convention_recorded":
                raise OSError("fixture success audit write failed")
            return original(base_dir, kind, details, **kwargs)

        try:
            with patch(
                "aria_kernel.tool_registry.append_tools_governance",
                side_effect=fail_success_audit,
            ):
                result = MemoryHookImpl().record(
                    cycle_id="cyc-audit-failure", plan_id="plan-audit-failure",
                    workspace_root=self.tmp, base_dir=self.base,
                    plan_envelope_metadata={}, profile="standard",
                    signer_key_fp=key.fingerprint,
                )
        finally:
            revoke_signing_key(cycle_id="cyc-audit-failure", workspace_root=self.tmp)

        conventions = load_jsonl(self.base / "knowledge-graph" / "conventions.jsonl")
        self.assertEqual(len(conventions), 1)
        self.assertEqual(conventions[0]["outcome_status"], "hypothesis")
        self.assertEqual(conventions[0]["confidence"], 0.5)
        self.assertTrue(result["convention_recorded"])
        self.assertTrue(result["chain_verified"])
        self.assertEqual(result["status"], "convention_audit_failed")
        audits = [
            row for row in load_jsonl(self.base / "governance.jsonl")
            if row.get("kind", "").startswith("convention_")
        ]
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]["kind"], "convention_audit_failed")
        self.assertEqual(audits[0]["details"]["error_class"], "OSError")

    def test_convention_write_oserror_remains_recording_failure(self) -> None:
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.ledger import load_jsonl

        self._converge("plan-write-failure")
        key = mint_signing_key(cycle_id="cyc-write-failure", workspace_root=self.tmp)
        try:
            with patch(
                "aria_kernel.knowledge_graph.record_convention",
                side_effect=OSError("fixture convention write failed"),
            ):
                result = MemoryHookImpl().record(
                    cycle_id="cyc-write-failure", plan_id="plan-write-failure",
                    workspace_root=self.tmp, base_dir=self.base,
                    plan_envelope_metadata={}, profile="standard",
                    signer_key_fp=key.fingerprint,
                )
        finally:
            revoke_signing_key(cycle_id="cyc-write-failure", workspace_root=self.tmp)
        self.assertEqual(result["status"], "convention_record_failed")
        self.assertFalse(result["convention_recorded"])
        self.assertIsNone(result["chain_verified"])
        self.assertFalse((self.base / "knowledge-graph" / "conventions.jsonl").exists())
        audits = [
            row for row in load_jsonl(self.base / "governance.jsonl")
            if row.get("kind", "").startswith("convention_")
        ]
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]["kind"], "convention_record_failed")
        self.assertEqual(audits[0]["details"]["error_class"], "OSError")

    def test_both_audit_write_failures_escape_after_convention_is_written(self) -> None:
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.gh_token_factory import mint_signing_key, revoke_signing_key
        from aria_kernel.knowledge_graph import verify_chain_or_quarantine
        from aria_kernel.ledger import load_jsonl

        self._converge("plan-both-audits-fail")
        key = mint_signing_key(cycle_id="cyc-both-audits-fail", workspace_root=self.tmp)
        try:
            with patch(
                "aria_kernel.tool_registry.append_tools_governance",
                side_effect=OSError("fixture audit unavailable"),
            ) as audit:
                with self.assertRaisesRegex(OSError, "fixture audit unavailable"):
                    MemoryHookImpl().record(
                        cycle_id="cyc-both-audits-fail", plan_id="plan-both-audits-fail",
                        workspace_root=self.tmp, base_dir=self.base,
                        plan_envelope_metadata={}, profile="standard",
                        signer_key_fp=key.fingerprint,
                    )
        finally:
            revoke_signing_key(cycle_id="cyc-both-audits-fail", workspace_root=self.tmp)
        self.assertEqual(
            [call.args[1] for call in audit.call_args_list],
            ["convention_recorded", "convention_audit_failed"],
        )
        path = self.base / "knowledge-graph" / "conventions.jsonl"
        self.assertEqual(len(load_jsonl(path)), 1)
        self.assertTrue(verify_chain_or_quarantine(path)[0])

    def test_unsigned_replay_discloses_the_same_plan_revision_once(self) -> None:
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.ledger import load_jsonl

        self._converge("plan-replay")
        hook = MemoryHookImpl()
        for cycle_id in ("cyc-original", "cyc-original", "cyc-resumed"):
            result = hook.record(
                cycle_id=cycle_id, plan_id="plan-replay",
                workspace_root=self.tmp, base_dir=self.base,
                plan_envelope_metadata={}, profile="standard", signer_key_fp=None,
            )
            self.assertEqual(result["status"], "needs_signing")
            self.assertFalse(result["convention_recorded"])
            self.assertIsNone(result["chain_verified"])
        pending = [
            row for row in load_jsonl(self.base / "governance.jsonl")
            if row.get("kind") == "convention_record_needs_signing"
        ]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["details"]["plan_id"], "plan-replay")
        self.assertFalse((self.base / "knowledge-graph" / "conventions.jsonl").exists())

    def test_invalid_fingerprint_is_a_recording_failure(self) -> None:
        from aria_kernel.cycle_phases import MemoryHookImpl

        self._converge("plan-invalid-fingerprint")
        result = MemoryHookImpl().record(
            cycle_id="cyc-invalid-fingerprint", plan_id="plan-invalid-fingerprint",
            workspace_root=self.tmp, base_dir=self.base,
            plan_envelope_metadata={}, profile="standard", signer_key_fp="invalid",
        )
        self.assertEqual(result["status"], "convention_record_failed")
        self.assertFalse(result["convention_recorded"])
        self.assertIsNone(result["chain_verified"])

    def test_i_v31_c2_06_stable_triggers_human_required(self) -> None:
        """Plan ARIA-V3.1-C2-06 — when check_pattern_signature_stability
        returns stable=True, MemoryHookImpl invokes record_human_required
        + emits skill_genesis_human_required_dispatched event."""
        from aria_kernel.cycle_phases import MemoryHookImpl
        self._converge("plan-stable")
        called: dict[str, object] = {}
        def _fake_human_required(*, request_id, severity, reason,
                                 base_dir=None, now=None):
            called["request_id"] = request_id
            called["reason"] = reason
            called["severity"] = severity
            return {"status": "open", "request_id": request_id}
        hook = MemoryHookImpl()
        with patch(
            "aria_kernel.plan_synthesizer.compute_pattern_signature",
            return_value="sha256:" + "a" * 16,
        ), patch(
            "aria_kernel.skill_genesis_drainer.check_pattern_signature_stability",
            return_value={
                "stable": True,
                "matching_cycles": ["c0", "c1", "c2", "c3", "c4"],
                "distinct_pressure_source_types": ["operator_feedback", "failing_ci"],
                "distinct_cross_reviewer_agent_ids": ["rev-A", "rev-B"],
            },
        ), patch(
            "aria_kernel.human_required.record_human_required",
            side_effect=_fake_human_required,
        ):
            result = hook.record(
                cycle_id="cyc-stable", plan_id="plan-stable",
                workspace_root=self.tmp, base_dir=self.base,
                plan_envelope_metadata={"_pressure_source_type": "operator_feedback"},
                profile="standard",
                signer_key_fp=None,
            )
        self.assertTrue(result["skill_genesis_dispatched"])
        self.assertEqual(called["reason"], "skill_genesis_adapter_authoring")
        self.assertTrue(
            str(called["request_id"]).startswith("skill-genesis-cyc-stable-"),
        )


if __name__ == "__main__":
    unittest.main()
