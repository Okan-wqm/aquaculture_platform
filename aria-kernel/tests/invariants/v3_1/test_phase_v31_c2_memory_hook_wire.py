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
* I-V31-C2-07 — the orchestrator's memory_hook.record(...) and
  .complete_pending_observations(...) keyword sets EQUAL the
  keyword-only parameter names of every hook variant (Protocol,
  NoOp, Impl). WHY: MemoryHookImpl.record once required a kwonly
  ``converged_plan`` the orchestrator never passed; the TypeError was
  swallowed into a memory_hook_failed governance row and I-V31-C2-05
  exercised record() with its OWN kwargs, so the drift stayed green.
  The caller and the callee are pinned to each other here, by AST on
  the caller and inspect on the callee.
* I-V31-C2-08 — the except clause around memory_hook.record(...) is
  the hook's declared runtime-fault set, never ``Exception``: a
  signature drift (TypeError) is a programming error and must raise,
  while GovernanceError / ledger integrity / OSError stay the
  governance row.
* I-V31-C2-09 — memory_hook_runtime_faults() excludes programming
  errors and covers the faults the record pipeline actually raises.
* I-B7-01 — the orchestrator hands memory_hook.record() the cycle
  knowledge signer's fingerprint (never a literal None) and owns the
  replay of earlier disclosures itself, before the V9 phase; the V9
  runner is no longer asked to call back with a signer.
* I-B7-02 — a signed record() carries public signer provenance on the
  result and on the convention_recorded governance row.
* I-B7-03 — a signed record() whose append fails discloses a pending
  row under reason `cycle_append_failed`, and the replay selects that
  reason and completes the original observation under a later signer.
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



def _memory_plan_content(title: str) -> dict:
    """The shared converging body, with the evidence cardinality the memory
    pillar demands: `compute_pattern_signature` returns None below
    MIN_EVIDENCE_REF_CARDINALITY distinct refs and the hook then records
    nothing (`no_pattern_signature`). A private copy of the body here
    silently stopped converging when the plan contract (ARIA-HIGH-103)
    started demanding the tier claim and a canonical validation command."""
    from aria_kernel.plan_synthesizer import MIN_EVIDENCE_REF_CARDINALITY
    from tests.test_implementation_lifecycle_continuity import converging_plan_content

    return converging_plan_content(
        title,
        affected_surfaces=["x.py"],
        key_changes=[{"id": "k1", "description": "d", "paths": ["x.py"]}],
        evidence_refs=[f"x.py:{line}" for line in range(1, MIN_EVIDENCE_REF_CARDINALITY + 1)],
    )


class MemoryHookImplPipelineOrderTests(unittest.TestCase):
    """Plan ARIA-V3.1-C2-01 — pipeline order assertion."""

    def test_i_v31_c2_01_pipeline_order_correct(self) -> None:
        """Execute the shared operation: exclude the own row from stability,
        and verify only after the real append has returned.
        """
        from aria_kernel import governance_reader, knowledge_graph
        from aria_kernel.cycle_phases import memory
        from tests.test_implementation_lifecycle_continuity import (
            drive_plan_to_converged, seed_reviewer_agent,
        )

        with tempfile.TemporaryDirectory(prefix="memory-order-") as directory:
            workspace = Path(directory)
            base = workspace / "aria-tools"
            seed_reviewer_agent(workspace)
            drive_plan_to_converged(
                plan_id="order", tools=base, workspace_root=workspace,
                plan_content=_memory_plan_content("Order fixture"),
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


def _memory_hook_calls(tree: "ast.Module", method: str) -> list["ast.Call"]:
    """Every ``memory_hook.<method>(...)`` call in the orchestrator module."""
    import ast

    return [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == method
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "memory_hook"
    ]


def _innermost_try_enclosing(tree: "ast.Module", target: "ast.AST") -> "ast.Try":
    """The innermost ``try`` whose body contains ``target``."""
    import ast

    enclosing = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Try)
        and any(target is inner for stmt in node.body for inner in ast.walk(stmt))
    ]
    return max(enclosing, key=lambda node: node.lineno)


class OrchestratorMemoryHookSignatureParityTests(unittest.TestCase):
    """B1 (2026-09-12 audit residual) — caller and callee pinned together."""

    def test_i_v31_c2_07_orchestrator_call_keywords_equal_every_hook_signature(self) -> None:
        """The keyword set the orchestrator passes to memory_hook.record(...)
        and .complete_pending_observations(...) equals the keyword-only
        parameter names of MemoryHook (Protocol), NoOpMemoryHook and
        MemoryHookImpl. A parameter added to one side without the other
        is a red test, not a memory_hook_failed row at 01:00."""
        import ast
        from aria_kernel import autonomy_orchestrator
        from aria_kernel.cycle_phases.memory import MemoryHook, MemoryHookImpl, NoOpMemoryHook

        tree = ast.parse(inspect.getsource(autonomy_orchestrator))
        for method in ("record", "complete_pending_observations"):
            calls = _memory_hook_calls(tree, method)
            self.assertEqual(
                len(calls), 1,
                f"expected exactly one orchestrator call site for memory_hook.{method}",
            )
            call = calls[0]
            self.assertEqual(call.args, [], f"memory_hook.{method} must be called by keyword only")
            passed = {keyword.arg for keyword in call.keywords}
            self.assertNotIn(None, passed, f"memory_hook.{method}(**splat) hides the keyword set")
            for hook in (MemoryHook, NoOpMemoryHook, MemoryHookImpl):
                parameters = inspect.signature(getattr(hook, method)).parameters
                kwonly = {
                    name for name, parameter in parameters.items()
                    if parameter.kind is inspect.Parameter.KEYWORD_ONLY
                }
                positional = [
                    name for name, parameter in parameters.items()
                    if name != "self" and parameter.kind is not inspect.Parameter.KEYWORD_ONLY
                ]
                self.assertEqual(
                    positional, [],
                    f"{hook.__name__}.{method} must take keyword-only parameters",
                )
                self.assertEqual(
                    passed, kwonly,
                    f"orchestrator memory_hook.{method}(...) keywords {sorted(passed)} "
                    f"!= {hook.__name__}.{method} keyword-only parameters {sorted(kwonly)}",
                )

    def test_i_v31_c2_08_memory_hook_except_is_the_declared_runtime_fault_set(self) -> None:
        """The try around memory_hook.record(...) catches the hook's
        declared runtime faults and nothing broader. ``except Exception``
        laundered a signature-drift TypeError into a governance row."""
        import ast
        from aria_kernel import autonomy_orchestrator

        tree = ast.parse(inspect.getsource(autonomy_orchestrator))
        (call,) = _memory_hook_calls(tree, "record")
        guard = _innermost_try_enclosing(tree, call)
        self.assertEqual(len(guard.handlers), 1, "one handler: the runtime-fault set")
        handler = guard.handlers[0]
        self.assertIsNotNone(handler.type, "bare except around memory_hook.record")
        caught = ast.unparse(handler.type)
        self.assertNotIn(caught, {"Exception", "BaseException"},
                         "memory_hook.record guarded by a broad except")
        self.assertEqual(
            caught, "memory_hook_runtime_faults()",
            "the handler must name the hook's own declared fault set",
        )

    def test_i_v31_c2_09_runtime_fault_set_excludes_programming_errors(self) -> None:
        from aria_kernel.cycle_phases.memory import memory_hook_runtime_faults
        from aria_kernel.knowledge_graph import KnowledgeGraphSchemaError, KnowledgeGraphTamper
        from aria_kernel.ledger import (
            LedgerIntegrityError, LedgerReadLimitError, LedgerRowTooLargeError,
        )
        from aria_kernel.tool_registry import GovernanceError

        faults = memory_hook_runtime_faults()
        for programming_error in (TypeError, AttributeError, KeyError, NameError, AssertionError, IndexError):
            self.assertFalse(
                issubclass(programming_error, faults),
                f"{programming_error.__name__} is a programming error, not a runtime fault",
            )
        for runtime_fault in (
            GovernanceError, LedgerIntegrityError, LedgerReadLimitError,
            LedgerRowTooLargeError, KnowledgeGraphTamper, KnowledgeGraphSchemaError,
            OSError, TimeoutError, PermissionError,
        ):
            self.assertTrue(
                issubclass(runtime_fault, faults),
                f"{runtime_fault.__name__} is a runtime fault the hook can raise",
            )


class KnowledgeSignerWireTests(unittest.TestCase):
    """I-B7-01 — the post-CONVERGED seam owns the signer and the replay."""

    def test_i_b7_01_memory_hook_receives_the_cycle_signer_not_none(self) -> None:
        from aria_kernel import autonomy_orchestrator
        src = inspect.getsource(autonomy_orchestrator.run_autonomy_orchestrator)
        idx_seam = src.find("with cycle_knowledge_signer(")
        idx_memory = src.find("memory_hook.record(")
        idx_replay = src.find("memory_hook.complete_pending_observations(")
        idx_v9 = src.find("v9_implementation_runner.run(")
        for name, idx in (("seam", idx_seam), ("record", idx_memory),
                          ("replay", idx_replay), ("v9", idx_v9)):
            self.assertGreater(idx, 0, f"orchestrator missing the {name} call site")
        self.assertLess(idx_seam, idx_memory, "the signer must exist before the hook records")
        self.assertLess(idx_memory, idx_replay, "replay follows the cycle's own observation")
        self.assertLess(idx_replay, idx_v9, "replay must not depend on the implementation phase")
        record_call = src[idx_memory:src.find(")", src.find("signer_key_fp=", idx_memory))]
        self.assertIn("signer_key_fp=knowledge_signer.fingerprint", record_call)
        self.assertNotIn("signer_key_fp=None", record_call)
        # The runner-side callback was the coupling: only a profile with
        # pr_create ever fired it. The orchestrator no longer produces it.
        self.assertNotIn("on_signer_ready=", src)


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
            plan_content=_memory_plan_content("t"),
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
        self.assertIsNone(result["signer_cycle_id"])
        self.assertIsNone(result["signer_key_fp"])

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
        # I-B7-02 — public signer provenance rides the result and the audit
        # row, the way the replay path already reports it.
        self.assertEqual(result["signer_cycle_id"], "cyc-fingerprint")
        self.assertEqual(result["signer_key_fp"], key.fingerprint)
        pattern = lookup_pattern(
            f"conv_cyc-fingerprint_{result['pattern_signature'][:16]}",
            workspace_root=self.tmp, min_confidence=0.0,
        )
        self.assertIsNotNone(pattern)
        self.assertEqual(pattern["signer_key_fp"], key.fingerprint)
        self.assertEqual(pattern["plan_id"], "plan-fingerprint")
        self.assertEqual(pattern["outcome_status"], "hypothesis")
        self.assertEqual(pattern["confidence"], 0.5)
        from aria_kernel.ledger import load_jsonl
        recorded = [row["details"] for row in load_jsonl(self.base / "governance.jsonl")
                    if row.get("kind") == "convention_recorded"]
        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["signer_cycle_id"], "cyc-fingerprint")
        self.assertEqual(recorded[0]["signer_key_fp"], key.fingerprint)
        self.assertEqual(recorded[0]["pattern_id"], pattern["pattern_id"])

    def test_i_b7_03_signed_append_failure_is_disclosed_pending_and_replayed(self) -> None:
        """B7 — durable retry on the direct path (verifier MUST FIX 2).

        A signer is present and `record_convention` fails transiently. The
        hook audits `convention_record_failed` AND discloses a
        `convention_record_needs_signing` row under reason
        `cycle_append_failed`, so the existing replay owns the retry: a later
        signer's `complete_pending_observations` selects that reason too and
        records the ORIGINAL observation under the original cycle's identity.
        Before this the failure was audited and the observation was gone.
        """
        from aria_kernel import knowledge_graph
        from aria_kernel.cycle_phases import MemoryHookImpl
        from aria_kernel.ledger import load_jsonl

        self._converge("plan-append-failed")
        hook = MemoryHookImpl()
        with patch.object(knowledge_graph, "record_convention", side_effect=OSError("fixture transient failure")):
            result = hook.record(
                cycle_id="cyc-first", plan_id="plan-append-failed", workspace_root=self.tmp,
                base_dir=self.base, plan_envelope_metadata={}, profile="standard",
                signer_key_fp="SHA256:first-fixture",
            )
        self.assertEqual(result["status"], "convention_record_failed")
        self.assertFalse(result["convention_recorded"])
        self.assertEqual(result["pending_reason"], "cycle_append_failed")
        self.assertEqual(result["signer_key_fp"], "SHA256:first-fixture")
        governance = load_jsonl(self.base / "governance.jsonl")
        failed = [row["details"] for row in governance if row.get("kind") == "convention_record_failed"]
        self.assertEqual([row["error_class"] for row in failed], ["OSError"])
        pending = [row["details"] for row in governance if row.get("kind") == "convention_record_needs_signing"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["reason"], "cycle_append_failed")
        self.assertEqual(pending[0]["error_class"], "OSError")
        self.assertEqual(pending[0]["cycle_id"], "cyc-first")
        self.assertEqual(pending[0]["plan_revision_id"], result["plan_revision_id"])
        self.assertEqual(pending[0]["plan_content_hash"], result["plan_content_hash"])
        self.assertFalse((self.base / "knowledge-graph/conventions.jsonl").exists())

        # The replay selects the new reason and completes the original
        # observation under the later signer.
        report: dict = {}
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="cyc-later",
                                           signer_key_fp="SHA256:later-fixture", report=report)
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["attempted"], 1)
        recovered = report["observations"][0]
        self.assertTrue(recovered["convention_recorded"])
        self.assertEqual(recovered["cycle_id"], "cyc-first")
        self.assertEqual(recovered["signer_cycle_id"], "cyc-later")
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["discovered_by_cycle_id"], "cyc-first")
        self.assertEqual(rows[0]["signer_key_fp"], "SHA256:later-fixture")
        # A second replay is a receipt, not a second row, and the same
        # failure disclosed again is not a second pending row.
        again: dict = {}
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="cyc-later-2",
                                           signer_key_fp="SHA256:later-2", report=again)
        self.assertEqual(again["already_recorded"], 1)
        self.assertEqual(again["attempted"], 0)
        self.assertEqual(len(load_jsonl(self.base / "knowledge-graph/conventions.jsonl")), 1)

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

    def test_pending_selection_survives_a_torn_governance_tail(self) -> None:
        """ORPHAN-CRITICAL-561 — a torn trailing record is a crash artifact,
        never a disclosure: the appender writes ``json + "\n"`` in one write,
        so an unparseable final line without its newline was never
        acknowledged to any caller. The verified prefix is the ledger; the
        replay reads it, completes the observation it discloses, and the
        first append heals the tail. Refusing here would leave every pending
        observation stranded behind one interrupted write until an operator
        truncated the file by hand — the earlier draft of this test pinned
        that refusal against the ledger's own contract."""
        from aria_kernel.ledger import load_jsonl, torn_tail_length
        hook = self._pending_observation()
        path = self.base / "governance.jsonl"
        verified_prefix = path.read_bytes()
        path.write_bytes(verified_prefix + b'{"partial":')
        self.assertGreater(torn_tail_length(path.read_text(encoding="utf-8")), 0)
        report = {}
        hook.complete_pending_observations(base_dir=self.base, signer_cycle_id="later",
                                           signer_key_fp="SHA256:fixture", report=report)
        rows = load_jsonl(self.base / "knowledge-graph/conventions.jsonl")
        self.assertEqual(len(rows), 1)
        after = path.read_bytes()
        self.assertTrue(after.startswith(verified_prefix), "the verified prefix is left byte-identical")
        self.assertEqual(torn_tail_length(after.decode("utf-8")), 0, "the first append healed the torn tail")
        self.assertNotIn(b'{"partial":', after)

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
        # A failed WRITE is a recording failure, never an audit failure —
        # and, B7 (I-B7-03), never the end of the observation: the same
        # hook discloses it pending under `cycle_append_failed` so the
        # replay owns the retry. Two rows, in that order, and no third.
        self.assertEqual([row["kind"] for row in audits],
                         ["convention_record_failed", "convention_record_needs_signing"])
        self.assertEqual(audits[0]["details"]["error_class"], "OSError")
        self.assertEqual(audits[0]["details"]["signer_key_fp"], key.fingerprint)
        self.assertEqual(audits[1]["details"]["reason"], "cycle_append_failed")
        self.assertEqual(audits[1]["details"]["error_class"], "OSError")
        self.assertEqual(result["pending_reason"], "cycle_append_failed")

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
