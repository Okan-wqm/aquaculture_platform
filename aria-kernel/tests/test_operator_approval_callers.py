"""ARIA-CRITICAL-216 — every operator-approval caller, classified and pinned.

Three classes, one rule each:

* RAISING — success widens what ARIA may do. Proven only by a GitHub act of a
  listed operator (``operator_approval.verify_operator_approval``), scoped to
  exactly the grant and consumed once. ``gov:``/``review:``/``ack-env:`` are
  refused: ARIA can author every one of them.
* LOWERING — success narrows authority (revoke a grant, freeze, lower a
  profile or ceiling). A reason string on the record is enough; these callers
  reference neither verifier.
* RECORD — the reference attests a decision that grants no authority (a
  consensus finding admitted, an anti-pattern that SKIPS work, a run-ledger
  format, a surface reset). They keep the recorded-reference grammar
  (``operator_approval.verify_recorded_reference``), which refuses every
  RAISING surface by construction.

The table below is the whole population. A new call to either verifier, a new
surface, or a caller moving class fails here until it is classified.
"""
from __future__ import annotations

import ast
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aria_kernel
from aria_kernel.operator_approval import AUTHORITY_RAISING_SURFACES, RECORD_SURFACES
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests._helpers.operator_acts import github_operator_acts, operator_set_profile

KERNEL = Path(aria_kernel.__file__).resolve().parent

GITHUB_VERIFIER = "verify_operator_approval"
RECORDED_VERIFIER = "verify_recorded_reference"
# ARIA-HIGH-238 — the owner module's wrapper every new raising surface calls
# (verify + the GovernanceError mapping, in one place).
GITHUB_VERIFIERS = frozenset({GITHUB_VERIFIER, "require_operator_act"})

# (module, function) -> (verifier it calls, surfaces it names). The direct call
# sites; the entry points that reach them are listed in ENTRY_POINTS.
VERIFIER_CALL_SITES: dict[tuple[str, str], tuple[str, frozenset[str]]] = {
    ("runtime_profile", "set_profile"): (GITHUB_VERIFIER, frozenset({"runtime_profile"})),
    ("runtime_profile", "set_merge_lane_grant"): (GITHUB_VERIFIER, frozenset({"merge_lane_grant"})),
    ("self_merge_freeze", "unfreeze_self_merge"): (GITHUB_VERIFIER, frozenset({"self_merge_unfreeze"})),
    ("tool_registry", "resolve_transition_approval"): (
        GITHUB_VERIFIER, frozenset({"tool_promote", "tool_unquarantine"}),
    ),
    ("policy_approval", "record_policy_approval"): (GITHUB_VERIFIER, frozenset({"l3_policy_approval"})),
    # ARIA-HIGH-238 — surfaced as their fixes land; every row is also an
    # ENTRY_POINTS key above.
    ("circuit_breaker", "reset_breaker"): (GITHUB_VERIFIER, frozenset({"circuit_breaker_reset"})),
    ("circuit_breaker", "quarantine_breaker_evidence"): (
        GITHUB_VERIFIER, frozenset({"breaker_evidence_quarantine"}),
    ),
    ("cost_budget", "reset_breaker"): (GITHUB_VERIFIER, frozenset({"cost_breaker_reset"})),
    ("autonomous_host_lease", "release_lease"): (GITHUB_VERIFIER, frozenset({"host_lease_release"})),
    ("self_modification", "request_kernel_change"): (
        GITHUB_VERIFIER, frozenset({"kernel_change_request"}),
    ),
    ("proposal", "approve_proposal"): (GITHUB_VERIFIER, frozenset({"proposal_approval"})),
    ("instinct_candidate", "promote_candidate"): (
        GITHUB_VERIFIER, frozenset({"instinct_promotion"}),
    ),
    ("genesis_lifecycle", "record_transition"): (
        GITHUB_VERIFIER, frozenset({"genesis_transition"}),
    ),
    ("agent_genesis", "approve_agent_pr"): (GITHUB_VERIFIER, frozenset({"agent_pr_approval"})),
    ("agent_genesis", "record_draft_lifecycle_chain"): (
        GITHUB_VERIFIER, frozenset({"genesis_request"}),
    ),
    ("skill_genesis", "approve_skill_pr"): (GITHUB_VERIFIER, frozenset({"skill_pr_approval"})),
    ("skill_genesis", "sandbox_skill"): (
        GITHUB_VERIFIER, frozenset({"skill_synthetic_sandbox"}),
    ),
    ("skill_curator", "decide_curation"): (
        GITHUB_VERIFIER, frozenset({"skill_curation_decision"}),
    ),
    ("agent_eval", "run_agent_eval"): (GITHUB_VERIFIER, frozenset({"agent_eval_run"})),
    ("shadow_eval_bridge", "bridge_shadow_eval_from_invocation"): (
        GITHUB_VERIFIER, frozenset({"shadow_eval_bridge"}),
    ),
    ("agent_invocations", "_submit_legacy_invocation_result_internal"): (
        GITHUB_VERIFIER, frozenset({"legacy_result_submit"}),
    ),
    ("security.grant", "new_claims"): (GITHUB_VERIFIER, frozenset({"grant_human_approval"})),
    ("pressure", "record_weight_override"): (
        GITHUB_VERIFIER, frozenset({"pressure_weight_override"}),
    ),
    ("ack_ledger", "init_ack_ledger"): (GITHUB_VERIFIER, frozenset({"ack_key_operation"})),
    ("ack_ledger", "rotate_key"): (GITHUB_VERIFIER, frozenset({"ack_key_operation"})),
    ("runtime_artifacts", "retention_apply"): (
        GITHUB_VERIFIER, frozenset({"retention_apply"}),
    ),
    ("runtime_artifacts", "restore_artifact"): (
        GITHUB_VERIFIER, frozenset({"artifact_restore"}),
    ),
    ("runtime_artifacts", "rollback_retention"): (
        GITHUB_VERIFIER, frozenset({"retention_rollback"}),
    ),
    ("tool_registry", "update_tool"): (GITHUB_VERIFIER, frozenset({"tool_update"})),
    ("finding_promotion", "promote_consensus_findings"): (
        RECORDED_VERIFIER, frozenset({"consensus_finding_promotion"}),
    ),
    ("knowledge_graph", "record_anti_pattern"): (RECORDED_VERIFIER, frozenset({"knowledge_graph_anti_pattern"})),
    ("runtime_artifacts", "approve_runtime_v2_promotion"): (RECORDED_VERIFIER, frozenset({"runtime_v2_promotion"})),
    ("memory_gap", "record_surface_reset"): (RECORDED_VERIFIER, frozenset({"surface_reset"})),
}

# Every entry point an operator (or a lane) reaches, with its class. set_profile
# is both: a transition that widens the recorded grant is RAISING, any other
# transition (frozen, observe, a lower ceiling, a lane inside its ceiling) is
# LOWERING. transition_tool is RAISING for ACTIVE and for leaving QUARANTINED.
ENTRY_POINTS: dict[tuple[str, str], str] = {
    ("runtime_profile", "set_profile"): "RAISING|LOWERING",
    ("runtime_profile", "set_merge_lane_grant"): "RAISING",
    ("runtime_profile", "revoke_merge_lane_grant"): "LOWERING",
    ("self_merge_freeze", "unfreeze_self_merge"): "RAISING",
    ("self_merge_freeze", "freeze_self_merge"): "LOWERING",
    ("tool_registry", "transition_tool"): "RAISING",
    ("tool_registry", "unquarantine_tool"): "RAISING",
    ("promotion", "promote_tool"): "RAISING",
    ("policy_approval", "record_policy_approval"): "RAISING",
    ("finding_promotion", "promote_consensus_findings"): "RECORD",
    ("knowledge_graph", "record_anti_pattern"): "RECORD",
    ("runtime_artifacts", "approve_runtime_v2_promotion"): "RECORD",
    ("memory_gap", "record_surface_reset"): "RECORD",
    # ARIA-HIGH-238 — the surfaces beyond the original six, classified as
    # their fix lands. Conditional raisers (a ref kwarg that is None unless
    # the caller claims operator authority) verify exactly when supplied.
    ("circuit_breaker", "reset_breaker"): "RAISING",
    ("circuit_breaker", "quarantine_breaker_evidence"): "RAISING",
    ("cost_budget", "reset_breaker"): "RAISING",
    ("autonomous_host_lease", "release_lease"): "RAISING|LOWERING",
    ("self_modification", "request_kernel_change"): "RAISING",
    ("proposal", "approve_proposal"): "RAISING",
    ("instinct_candidate", "promote_candidate"): "RAISING",
    ("genesis_lifecycle", "record_transition"): "RAISING|LOWERING",
    ("agent_genesis", "approve_agent_pr"): "RAISING",
    ("agent_genesis", "record_draft_lifecycle_chain"): "RAISING",
    ("skill_genesis", "approve_skill_pr"): "RAISING",
    ("skill_genesis", "sandbox_skill"): "RAISING",
    ("skill_curator", "decide_curation"): "RAISING",
    ("skill_curator", "rollback_skill_materialization"): "LOWERING",
    ("agent_eval", "run_agent_eval"): "RAISING",
    ("shadow_eval_bridge", "bridge_shadow_eval_from_invocation"): "RAISING",
    ("agent_invocations", "_submit_legacy_invocation_result_internal"): "RAISING",
    ("security.grant", "new_claims"): "RAISING",
    ("pressure", "record_weight_override"): "RAISING",
    ("ack_ledger", "init_ack_ledger"): "RAISING",
    ("ack_ledger", "rotate_key"): "RAISING",
    ("runtime_artifacts", "retention_apply"): "RAISING",
    ("runtime_artifacts", "restore_artifact"): "RAISING",
    ("runtime_artifacts", "rollback_retention"): "RAISING",
    ("tool_registry", "update_tool"): "RAISING",
}


# Internal plumbing: the function hands the ref to the layer that owns its
# proof and never decides anything on the string itself. PASS_THROUGH is not
# an honour class — every entry names the layer that holds the rule.
PASS_THROUGH: dict[tuple[str, str], str] = {
    ("runtime_profile", "_transition_merge_lane_grant"):
        "set_merge_lane_grant verifies the act before the state writer runs",
    ("proposal", "_write_approval"):
        "approve_proposal verifies; record_machine_approval passes no operator ref",
    ("promotion_veto", "resolve_panel_approval"):
        "resolves a PANEL adjudication (human_required.resolve_panel_adjudication_proof); "
        "a panel ref is not operator authority",
    ("promotion_veto", "record_pending_promotion"):
        "calls resolve_panel_approval, the panel-proof resolver above",
    ("agent_genesis", "draft_agent_from_gap"):
        "hands the ref to record_draft_lifecycle_chain, which verifies the operator "
        "path (genesis_request) before the chain records REQUEST",
}


# ARIA-HIGH-238 — the shrink-to-zero queue. Every kernel function that takes
# an ``*approval_ref`` parameter must be classified above (or here while its
# fix is in flight). An entry leaves this table only with its production fix
# in the same commit; the completing commit empties it.
PENDING_CLASSIFICATION: frozenset[tuple[str, str]] = frozenset()


def _functions(tree: ast.AST) -> list[ast.FunctionDef]:
    return [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]


def _approval_ref_parameters() -> set[tuple[str, str]]:
    """Every (module, function) whose signature takes an ``*approval_ref``."""
    found: set[tuple[str, str]] = set()
    for path in sorted(KERNEL.rglob("*.py")):
        module = path.relative_to(KERNEL).with_suffix("").as_posix().replace("/", ".")
        for function in _functions(ast.parse(path.read_text(encoding="utf-8"))):
            arguments = function.args.args + function.args.kwonlyargs
            if any(arg.arg.endswith("approval_ref") for arg in arguments):
                found.add((module, function.name))
    return found


def _called_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for call in ast.walk(node):
        if isinstance(call, ast.Call):
            func = call.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def _verifier_calls() -> dict[tuple[str, str], tuple[str, frozenset[str]]]:
    found: dict[tuple[str, str], tuple[str, frozenset[str]]] = {}
    for path in sorted(KERNEL.rglob("*.py")):
        module = path.relative_to(KERNEL).with_suffix("").as_posix().replace("/", ".")
        if module == "operator_approval":
            continue
        for function in _functions(ast.parse(path.read_text(encoding="utf-8"))):
            for call in ast.walk(function):
                if not isinstance(call, ast.Call):
                    continue
                func = call.func
                name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
                if name not in (GITHUB_VERIFIERS | {RECORDED_VERIFIER}):
                    continue
                verifier = GITHUB_VERIFIER if name in GITHUB_VERIFIERS else RECORDED_VERIFIER
                surface = next((kw.value for kw in call.keywords if kw.arg == "surface"), None)
                literals = frozenset(
                    node.value for node in ast.walk(surface)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str)
                ) if surface is not None else frozenset()
                key = (module, function.name)
                prior = found.get(key)
                if prior is not None:
                    literals = literals | prior[1]
                found[key] = (verifier, literals)
    return found


class CallerClassificationTests(unittest.TestCase):
    def test_every_verifier_call_site_is_classified(self) -> None:
        self.assertEqual(_verifier_calls(), VERIFIER_CALL_SITES)

    def test_every_approval_ref_parameter_is_classified(self) -> None:
        """ARIA-HIGH-238 — the parameter list is the whole caller population.

        A function that takes an ``*approval_ref`` parameter claims operator
        authority somewhere. Every such (module, function) must be classified:
        an entry point in ``ENTRY_POINTS``/``VERIFIER_CALL_SITES``, internal
        plumbing in ``PASS_THROUGH`` (naming the layer that owns the proof),
        or queued in ``PENDING_CLASSIFICATION`` — which shrinks to zero and
        must be empty when the finding closes.
        """
        classified = set(ENTRY_POINTS) | set(VERIFIER_CALL_SITES) | set(PASS_THROUGH)
        pending = set(PENDING_CLASSIFICATION)
        self.assertEqual(pending & classified, set(), "a PENDING row was fixed but not removed")
        unclassified = _approval_ref_parameters() - classified
        self.assertEqual(
            sorted(unclassified - pending),
            [],
            "kernel functions taking an *approval_ref parameter with no class",
        )
        self.assertEqual(
            sorted(pending - _approval_ref_parameters()),
            [],
            "PENDING rows that no longer take an approval-ref parameter",
        )
        # Plumbing must stay plumbing: a PASS_THROUGH that starts verifying
        # is an entry point and belongs in ENTRY_POINTS instead.
        trees = {
            path.relative_to(KERNEL).with_suffix("").as_posix().replace("/", "."):
                ast.parse(path.read_text(encoding="utf-8"))
            for path in KERNEL.rglob("*.py")
        }
        for (module, name) in PASS_THROUGH:
            with self.subTest(pass_through=f"{module}.{name}"):
                function = next(f for f in _functions(trees[module]) if f.name == name)
                self.assertFalse(
                    _called_names(function) & (GITHUB_VERIFIERS | {RECORDED_VERIFIER}),
                )

    def test_the_surface_sets_are_exactly_the_classified_surfaces(self) -> None:
        raising = set().union(*(s for v, s in VERIFIER_CALL_SITES.values() if v == GITHUB_VERIFIER))
        record = set().union(*(s for v, s in VERIFIER_CALL_SITES.values() if v == RECORDED_VERIFIER))
        self.assertEqual(raising, set(AUTHORITY_RAISING_SURFACES))
        self.assertEqual(record, set(RECORD_SURFACES))

    def test_the_legacy_verifier_is_gone(self) -> None:
        for path in sorted(KERNEL.rglob("*.py")):
            self.assertNotIn("verify_operator_approval_ref", path.read_text(encoding="utf-8"), msg=str(path))

    def test_every_entry_point_exists_and_reaches_its_class(self) -> None:
        trees = {
            path.relative_to(KERNEL).with_suffix("").as_posix().replace("/", "."):
                ast.parse(path.read_text(encoding="utf-8"))
            for path in KERNEL.rglob("*.py")
        }
        for (module, name), klass in ENTRY_POINTS.items():
            with self.subTest(entry=f"{module}.{name}"):
                function = next(f for f in _functions(trees[module]) if f.name == name)
                called = _called_names(function)
                if klass == "LOWERING":
                    self.assertFalse(
                        called & (GITHUB_VERIFIERS | {RECORDED_VERIFIER, "resolve_transition_approval"}),
                    )
                elif klass == "RECORD":
                    self.assertIn(RECORDED_VERIFIER, called)
                elif (module, name) in VERIFIER_CALL_SITES:
                    self.assertTrue(called & GITHUB_VERIFIERS, called)
                else:
                    # Reaches the verifier through the tool lifecycle resolver.
                    self.assertTrue(called & {"resolve_transition_approval", "transition_tool"}, called)


class VerifiedApprovalSurfaces(unittest.TestCase):
    """ARIA-HIGH-238 — one red per surface: a free string is not an approval.

    Each test drives the REAL entry point in a real tools dir: a free string
    such as ``"ok"`` is refused with the GitHub-act grammar, a fixture
    operator act (``tests/_helpers/operator_acts``) is accepted, and the same
    act is refused a second time — one act authorizes one grant.
    """

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-238-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")

    def _refused_as_unrecorded(self, action, ref: str = "ok") -> None:
        with self.assertRaisesRegex(GovernanceError, "gh:<owner>/<repo>#<number>"):
            action(ref)

    def _refused_as_consumed(self, action, ref: str) -> None:
        with self.assertRaisesRegex(GovernanceError, "already consumed"):
            action(ref)

    def test_circuit_breaker_reset(self) -> None:
        from aria_kernel.circuit_breaker import reset_breaker

        self._refused_as_unrecorded(
            lambda ref: reset_breaker(base_dir=self.tools, operator_approval_ref=ref, reason="investigated"),
        )
        with github_operator_acts() as github:
            ref = github.approve("circuit_breaker_reset", {"target": "breaker"})
            self.assertEqual(
                reset_breaker(base_dir=self.tools, operator_approval_ref=ref, reason="investigated"),
                {"status": "ok"},
            )
            self._refused_as_consumed(
                lambda _: reset_breaker(base_dir=self.tools, operator_approval_ref=ref, reason="again"),
                ref,
            )

    def test_breaker_evidence_quarantine(self) -> None:
        from aria_kernel.circuit_breaker import quarantine_breaker_evidence

        from aria_kernel.circuit_breaker import _failures_path

        damaged = _failures_path(self.tools)
        damaged.parent.mkdir(parents=True, exist_ok=True)
        run = lambda ref: quarantine_breaker_evidence(  # noqa: E731 - test local
            base_dir=self.tools, operator_approval_ref=ref, reason="damaged ledger",
        )
        damaged.write_text('{"failure": 1}\nnot-json-at-all\n', encoding="utf-8")
        self._refused_as_unrecorded(run)
        with github_operator_acts() as github:
            ref = github.approve("breaker_evidence_quarantine", {"target": "breaker_evidence"})
            result = run(ref)
            self.assertEqual(result["quarantined"], 1)
            # A second damaged row: the same act must not authorize a second
            # repair — one GitHub act authorizes one grant.
            damaged.write_text('{"failure": 2}\nstill-not-json\n', encoding="utf-8")
            self._refused_as_consumed(run, ref)

    def test_cost_breaker_reset(self) -> None:
        from aria_kernel.cost_budget import reset_breaker

        self._refused_as_unrecorded(
            lambda ref: reset_breaker(base_dir=self.tools, reason="investigated", operator_approval_ref=ref),
        )
        with github_operator_acts() as github:
            ref = github.approve("cost_breaker_reset", {"target": "cost_breaker"})
            self.assertEqual(
                reset_breaker(base_dir=self.tools, reason="investigated", operator_approval_ref=ref),
                {"status": "ok"},
            )
            self._refused_as_consumed(
                lambda _: reset_breaker(base_dir=self.tools, reason="again", operator_approval_ref=ref),
                ref,
            )

    def test_host_lease_release_takeover(self) -> None:
        from aria_kernel.autonomous_host_lease import acquire_lease, release_lease

        acquire_lease(base_dir=self.tools, host_id="host-a", pid=111)
        # Own-host release needs no act at all (LOWERING half of the surface).
        self.assertEqual(release_lease(base_dir=self.tools, host_id="host-a")["status"], "released")
        acquire_lease(base_dir=self.tools, host_id="host-b", pid=222)
        self._refused_as_unrecorded(
            lambda ref: release_lease(base_dir=self.tools, host_id="host-a", operator_approval_ref=ref),
        )
        with github_operator_acts() as github:
            ref = github.approve("host_lease_release", {"host": "host-b"})
            self.assertEqual(
                release_lease(base_dir=self.tools, host_id="host-a", operator_approval_ref=ref)["status"],
                "released",
            )
            acquire_lease(base_dir=self.tools, host_id="host-b", pid=333)
            self._refused_as_consumed(
                lambda _: release_lease(base_dir=self.tools, host_id="host-a", operator_approval_ref=ref),
                ref,
            )

    def test_kernel_change_request(self) -> None:
        from aria_kernel.self_modification import REQUIRED_KERNEL_VALIDATIONS, request_kernel_change

        files = ["aria-kernel/aria_kernel/example.py"]
        kwargs = {
            "changed_files": files,
            "validation_refs": list(REQUIRED_KERNEL_VALIDATIONS),
            "full_shadow_cycle_ref": "cycle-1",
            "rollback_plan": "git revert",
            "base_dir": self.tools,
        }
        self._refused_as_unrecorded(lambda ref: request_kernel_change(operator_approval_ref=ref, **kwargs))
        import hashlib

        digest = hashlib.sha256("\n".join(sorted(files)).encode("utf-8")).hexdigest()
        with github_operator_acts() as github:
            ref = github.approve("kernel_change_request", {"digest": digest})
            row = request_kernel_change(operator_approval_ref=ref, **kwargs)
            self.assertEqual(row["decision"], "authorized_for_pr_only")
            self._refused_as_consumed(
                lambda _: request_kernel_change(operator_approval_ref=ref, **kwargs),
                ref,
            )


    def test_proposal_approval(self) -> None:
        from aria_kernel.proposal import approve_proposal, record_proposal

        proposal = record_proposal(
            kind="architecture", title="t", problem="p", evidence=["docs/x.md"],
            validation_command="pytest", base_dir=self.tools,
        )
        run = lambda ref: approve_proposal(  # noqa: E731 - test local
            proposal_id=proposal["proposal_id"], operator_approval_ref=ref, base_dir=self.tools,
        )
        self._refused_as_unrecorded(run)
        with github_operator_acts() as github:
            ref = github.approve("proposal_approval", {"proposal": proposal["proposal_id"]})
            self.assertEqual(run(ref)["status"], "approved_for_apply")
            self._refused_as_consumed(run, ref)

    def test_pressure_weight_override(self) -> None:
        from aria_kernel.pressure import record_weight_override, SOURCE_WEIGHTS

        source = sorted(SOURCE_WEIGHTS)[0]
        run = lambda ref: record_weight_override(  # noqa: E731 - test local
            source=source, weight=7, reason="rebalance after review", operator_approval_ref=ref,
            base_dir=self.tools,
        )
        self._refused_as_unrecorded(run)
        with github_operator_acts() as github:
            ref = github.approve("pressure_weight_override", {"source": source, "weight": "7"})
            self.assertEqual(run(ref)["weight"], 7)
            self._refused_as_consumed(run, ref)

    def test_ack_key_init_and_rotate(self) -> None:
        from aria_kernel.ack_ledger import init_ack_ledger, rotate_key

        init_run = lambda ref: init_ack_ledger(  # noqa: E731 - test local
            base_dir=self.tools, reason="bootstrap", operator_approval_ref=ref,
        )
        self._refused_as_unrecorded(init_run)
        with github_operator_acts() as github:
            ref = github.approve("ack_key_operation", {"operation": "init"})
            self.assertEqual(init_run(ref)["status"], "ok")
        rotate_run = lambda ref: rotate_key(  # noqa: E731 - test local
            base_dir=self.tools, reason="scheduled", operator_approval_ref=ref,
        )
        self._refused_as_unrecorded(rotate_run)
        with github_operator_acts() as github:
            ref = github.approve("ack_key_operation", {"operation": "rotate"})
            self.assertEqual(rotate_run(ref)["status"], "ok")
            self._refused_as_consumed(rotate_run, ref)

    def test_tool_update_gated_fields(self) -> None:
        from aria_kernel.tool_registry import update_tool

        updates = {"allowed_read_globs": ["docs/**"]}
        run = lambda ref: update_tool(  # noqa: E731 - test local
            "tool-no-such", updates, base_dir=self.tools,
            operator_approval_ref=ref, reason="widen reads",
        )
        self._refused_as_unrecorded(run)
        with github_operator_acts() as github:
            ref = github.approve("tool_update", {"tool": "tool-no-such", "fields": "allowed_read_globs"})
            # The act is proven, so the call now proceeds to the honest
            # refusal: the tool itself does not exist.
            with self.assertRaisesRegex(GovernanceError, "tool not found"):
                run(ref)

    def test_instinct_promotion(self) -> None:
        from aria_kernel.instinct_candidate import promote_candidate, record_candidate

        candidate = record_candidate(
            trigger_signal="repeat-banned-phrase-violation",
            action_observation="9 of last 12 PRs caught by L1 gate",
            evidence_refs=["aria-tools/governance.jsonl:42"],
            confidence_0_to_1=0.85,
            observation_count=9,
            base_dir=self.tools,
        )
        run = lambda ref: promote_candidate(  # noqa: E731 - test local
            candidate_id=candidate["candidate_id"], operator_approval_ref=ref,
            promotion_pr_url="https://github.com/o/r/pull/7", promoted_to="skill",
            base_dir=self.tools,
        )
        self._refused_as_unrecorded(run)
        with github_operator_acts() as github:
            ref = github.approve("instinct_promotion", {"candidate": candidate["candidate_id"]})
            self.assertEqual(run(ref)["status"], "PROMOTED")
            self._refused_as_consumed(run, ref)


    def test_genesis_widening_transition(self) -> None:
        from aria_kernel.genesis_lifecycle import record_transition

        run = lambda ref: record_transition(  # noqa: E731 - test local
            entity_id="aria-238-probe", entity_kind="agent", to_state="REAL_SANDBOX",
            evidence={"eval_harness_id": "h", "fixture_run_id": "f", "transcript_hash": "sha256:" + "0" * 64,
                      "operator_provenance_ref": "gh:x/y#1/comment/1"},
            operator_approval_ref=ref, base_dir=self.tools,
        )
        self._refused_as_unrecorded(run)
        with github_operator_acts() as github:
            ref = github.approve(
                "genesis_transition", {"entity": "aria-238-probe", "state": "REAL_SANDBOX"},
            )
            # The act is proven and consumed; the transition then refuses on
            # its own honest lifecycle rule (an entity must be born PRESSURE
            # first). The full accept path is test_shadow_eval_bridge's.
            with self.assertRaisesRegex(GovernanceError, "genesis_lifecycle_transition_rejected"):
                run(ref)
            self._refused_as_consumed(run, ref)

    def test_genesis_narrowing_transition_takes_a_reason(self) -> None:
        from aria_kernel.genesis_lifecycle import record_transition

        with github_operator_acts() as github:
            record_transition(
                entity_id="aria-238-narrow", entity_kind="agent", to_state="PRESSURE",
                evidence={"gap_id": "g"}, base_dir=self.tools,
            )
            record_transition(
                entity_id="aria-238-narrow", entity_kind="agent", to_state="CANDIDATE_PROPOSED",
                evidence={"source_types": ["coverage_gap", "shadow_summary"], "valid_cycles": 0},
                base_dir=self.tools,
            )
            row = record_transition(
                entity_id="aria-238-narrow", entity_kind="agent", to_state="REJECTED",
                evidence={}, operator_approval_ref="incident: wrong candidate",
                base_dir=self.tools,
            )
            self.assertEqual(row["to_state"], "REJECTED")
            self.assertEqual(github.reads, [])


class RaisingSurfacesRefuseRecordedReferences(unittest.TestCase):
    """Each RAISING entry point refuses a ref that ARIA itself could author."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-callers-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")
        event = append_tools_governance(self.tools, "operator_action", {"action": "approve"})
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1\n", encoding="utf-8")
        os.environ["ARIA_TEST_ACK_216"] = "yes"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK_216", None)
        self.refs = (f"gov:{event['event_id']}", f"review:{doc}#OP-1", "ack-env:ARIA_TEST_ACK_216")

    def _assert_refused(self, action) -> None:
        for ref in self.refs:
            with self.subTest(ref=ref), self.assertRaisesRegex(GovernanceError, "gh:<owner>/<repo>#<number>"):
                action(ref)

    def test_profile_raise(self) -> None:
        from aria_kernel.runtime_profile import set_profile

        self._assert_refused(lambda ref: set_profile("strict", operator_approval_ref=ref, base_dir=self.tools))
        self._assert_refused(lambda ref: set_profile(
            "standard", operator_approval_ref=ref, base_dir=self.tools, scheduler_ceiling="strict",
        ))

    def test_merge_lane_grant(self) -> None:
        from aria_kernel.runtime_profile import set_merge_lane_grant

        expires = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._assert_refused(lambda ref: set_merge_lane_grant(
            lane="L1", expires_at=expires, operator_approval_ref=ref, base_dir=self.tools,
        ))

    def test_self_merge_unfreeze(self) -> None:
        from aria_kernel.self_merge_freeze import freeze_self_merge, unfreeze_self_merge

        row = freeze_self_merge(merge_sha="a" * 40, pr_number=1, trigger="test", evidence={}, base_dir=self.tools)
        self._assert_refused(lambda ref: unfreeze_self_merge(
            freeze_id=row["freeze_id"], operator_approval_ref=ref, base_dir=self.tools,
        ))

    def test_tool_promotion_and_unquarantine(self) -> None:
        from aria_kernel.tool_registry import resolve_transition_approval

        self._assert_refused(lambda ref: resolve_transition_approval(
            ref, tool_id="adapter-x", current_status="SHADOW", target_status="ACTIVE", base_dir=self.tools,
        ))
        self._assert_refused(lambda ref: resolve_transition_approval(
            ref, tool_id="adapter-x", current_status="QUARANTINED", target_status="CALIBRATE", base_dir=self.tools,
        ))

    def test_l3_policy_approval(self) -> None:
        from aria_kernel.policy_approval import record_policy_approval

        self._assert_refused(lambda ref: record_policy_approval({
            "approval_id": "a-1", "stage": "risk_owner", "pr_number": 5, "head_sha": "b" * 40,
            "policy_hash": "sha256:" + "c" * 64, "expires_at": "2099-01-01T00:00:00Z",
            "operator_approval_ref": ref,
        }, base_dir=self.tools))


class LoweringSurfacesTakeAReason(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-lower-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")

    def test_lowering_needs_no_github_act(self) -> None:
        from aria_kernel.runtime_profile import (
            get_profile,
            get_scheduler_profile_ceiling,
            revoke_merge_lane_grant,
            set_profile,
        )
        from aria_kernel.self_merge_freeze import active_freeze, freeze_self_merge

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        with github_operator_acts() as github:
            set_profile("frozen", operator_approval_ref="incident: stop everything", base_dir=self.tools)
            set_profile("observe", operator_approval_ref="incident: watch only", base_dir=self.tools)
            set_profile(
                "observe", operator_approval_ref="incident: lower the grant",
                base_dir=self.tools, scheduler_ceiling="standard",
            )
            revoke_merge_lane_grant(operator_approval_ref="incident: no merges", base_dir=self.tools)
            freeze_self_merge(merge_sha="d" * 40, pr_number=3, trigger="test", evidence={}, base_dir=self.tools)
            self.assertEqual(github.reads, [])
        self.assertEqual(get_profile(base_dir=self.tools), "observe")
        self.assertEqual(get_scheduler_profile_ceiling(base_dir=self.tools), "standard")
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_a_lane_inside_the_recorded_ceiling_needs_no_github_act(self) -> None:
        from aria_kernel.runtime_profile import get_profile, set_profile

        operator_set_profile("standard", base_dir=self.tools, scheduler_ceiling="strict")
        set_profile("frozen", operator_approval_ref="incident", base_dir=self.tools)
        with github_operator_acts() as github:
            set_profile("strict", operator_approval_ref="cli-flag:nightly", base_dir=self.tools, set_by="autonomy-cli")
            self.assertEqual(github.reads, [])
        self.assertEqual(get_profile(base_dir=self.tools), "strict")


if __name__ == "__main__":
    unittest.main()
