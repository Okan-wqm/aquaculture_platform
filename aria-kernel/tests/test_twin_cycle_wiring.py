"""Twin-lite gets a keeper and a reader in the same change.

PLAN Wave 3. Twin-lite shipped as a CLI: `twin build`, `twin refresh`,
`twin status`, `twin context`. Nothing in the cycle kept the map current and
nothing in the cycle read it, so the map ARIA was meant to consult was only
ever as fresh as the last time a human ran a command.

Wiring only the refresh would have been worse than leaving it alone: a phase
that pays git-log and parse cost every cycle to produce a map no consumer
reads is the same defect this programme keeps closing, inverted — not
"written but never called" but "called and never read". So the producer
(`twin_refresh`) and its first reader (the agent envelope's repository-map
slice) land together, and this suite pins both halves plus the boundary
between them.

THE BOUNDARY IS THE LOAD-BEARING PART. The invocation prompt already
separates "Evidence refs (file:line entries; the ONLY admissible evidence)"
from "Impact graph refs" — one is citable, the other is orientation. The twin
map is DERIVED data recomputable from the repo at `indexed_sha`; it is
orientation, never evidence. It therefore renders in its own section and must
never reach `evidence_refs`, or a model could cite a projection as proof.
"""

from __future__ import annotations

import ast
import subprocess
import hashlib
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from aria_kernel.agent_contract import validate_request
from aria_kernel.agent_invocations import render_invocation_prompt
from aria_kernel.cycle import CYCLE_PHASES, _phase_twin_refresh, build_phase_context
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.twin import read_twin_map
from tests._helpers.policy_fixtures import AMPLE_QUALIFICATION_DEADLINE_SECONDS, write_source_qualification_override


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    ).stdout


class TwinRefreshPhaseTests(unittest.TestCase):
    """The map is kept current BY THE CYCLE, not by remembering to run a CLI."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name) / "repo"
        (self.repo / "apps" / "svc" / "src").mkdir(parents=True)
        (self.repo / "apps" / "svc" / "project.json").write_text('{"name":"svc"}', encoding="utf-8")
        (self.repo / "apps" / "svc" / "src" / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.email", "t@t")
        _git(self.repo, "config", "user.name", "t")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "first")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def _run(self, cycle_id: str) -> dict:
        return _phase_twin_refresh(
            build_phase_context(cycle_id=cycle_id, workspace_root=self.repo, base_dir=self.tools)
        )

    def _commit(self, rel: str, body: str) -> str:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", f"add {rel}")
        return _git(self.repo, "rev-parse", "HEAD").strip()

    def test_the_phase_is_on_the_pipeline_and_in_the_discovery_stage(self) -> None:
        # CYCLE_PHASES is the SSoT — a phase that is not a row does not run,
        # which is how the four extended phases were dead without anyone noticing.
        row = next((p for p in CYCLE_PHASES if p.name == "twin_refresh"), None)
        self.assertIsNotNone(row, "twin_refresh is not on the pipeline")
        self.assertEqual(row.stage, "discovery")

    def test_the_observe_lane_keeps_the_map_too(self) -> None:
        # The map is a declared OBSERVATION surface, and the observe lane's
        # output is the acceptance evidence the ladder counts. A burn-in cycle
        # reading a map frozen at some past commit would be judging the wrong
        # repository.
        row = next(p for p in CYCLE_PHASES if p.name == "twin_refresh")
        self.assertIn("burn_in", row.modes)
        self.assertIn("standard", row.modes)

    def test_a_stale_map_must_not_fail_the_cycle_but_must_be_recorded(self) -> None:
        # A map that failed to refresh is a degraded read, not a broken cycle.
        row = next(p for p in CYCLE_PHASES if p.name == "twin_refresh")
        self.assertEqual(row.on_error, "record_and_continue")
        self.assertEqual(row.state_key, "twin_refresh")

    def test_the_first_cycle_builds_the_map(self) -> None:
        result = self._run("cyc-1")
        self.assertEqual(result["refresh"]["mode"], "full")
        self.assertEqual(read_twin_map(base_dir=self.tools)["indexed_sha"], result["indexed_sha"])

    def test_real_discovery_binds_written_twin_to_its_source_view(self) -> None:
        from aria_kernel import cycle
        from aria_kernel import snapshot as snapshot_owner

        sources = {}
        source_bytes = {}
        for module in ("runtime_artifacts", "knowledge_graph"):
            relative = f"aria-kernel/aria_kernel/{module}.py"
            original = Path(__file__).resolve().parents[1] / "aria_kernel" / f"{module}.py"
            body = original.read_bytes()
            source_bytes[relative] = body
            sources[relative] = "sha256:" + hashlib.sha256(body).hexdigest()
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        _git(self.repo, "add", "aria-kernel")
        _git(self.repo, "commit", "-q", "-m", "fixture: actual pilot owners")
        context = build_phase_context(
            cycle_id="cyc-pilot-discovery", workspace_root=self.repo,
            base_dir=self.tools, snapshot_mode="committed",
        )
        with patch.object(cycle, "run_discovery", wraps=cycle.run_discovery) as discovery_calls:
            discovered = cycle._phase_discovery(context)
            context.results["discovery"] = discovered
            # Ordinary work after discovery must not supply the AST for the
            # committed view whose hashes the feature projection records.
            changed_owner = self.repo / "aria-kernel/aria_kernel/runtime_artifacts.py"
            changed_owner.write_text("def unrelated_working_function():\n    return None\n", encoding="utf-8")
            self.assertNotEqual("sha256:" + hashlib.sha256(changed_owner.read_bytes()).hexdigest(),
                                sources["aria-kernel/aria_kernel/runtime_artifacts.py"])
            with patch.object(ast, "parse", wraps=ast.parse) as parsed, patch.object(snapshot_owner, "_file_fate", side_effect=AssertionError(
                "Twin must consume existing discovery without another full fate pass"
            )) as fate_scan:
                result = cycle._phase_twin_refresh(context)
                fate_scan.assert_not_called()
        self.assertEqual(discovery_calls.call_count, 1)
        artifact_dir = Path(discovered["artifact_dir"])
        snapshot = json.loads((artifact_dir / "SNAPSHOT.json").read_bytes())
        proof = json.loads((artifact_dir / "COMPLETION_PROOF.json").read_bytes())
        fates = {row["path"]: row for row in discovered["fates"]}
        self.assertEqual(snapshot, discovered["snapshot"])
        self.assertEqual(proof, discovered["completion_proof"])
        self.assertEqual(json.loads((artifact_dir / "FATES.json").read_bytes())["files"], discovered["fates"])
        self.assertTrue(proof["complete"])
        for relative, expected_hash in sources.items():
            self.assertEqual(fates[relative]["content_hash"], expected_hash)
        stored = read_twin_map(base_dir=self.tools)
        self.assertEqual(stored, result)
        self.assertIn("self_features", stored,
                      "Actual discovery must reach the persisted pilot projection")
        parsed_sources = {call.kwargs.get("filename"): call.args[0] for call in parsed.call_args_list}
        for relative, body in source_bytes.items():
            self.assertEqual(parsed_sources[relative], body)
        inventory = stored["self_features"]
        self.assertEqual(inventory["discovery"]["cycle_id"], context.cycle_id)
        for field in ("snapshot_mode", "base_commit_sha", "snapshot_hash", "repo_state_id"):
            self.assertEqual(inventory["input_binding"][field], snapshot[field])
            self.assertEqual(inventory["input_binding"][field], proof[field])
        self.assertEqual(set(inventory["features"]), {
            "runtime_artifacts.autonomy_output_summary", "knowledge_graph.conventions_for_paths",
        })
        for key, feature in inventory["features"].items():
            module, symbol = key.split(".")
            relative = f"aria-kernel/aria_kernel/{module}.py"
            self.assertEqual(feature["owner"]["path"], relative)
            self.assertEqual(feature["owner"]["symbol"], symbol)
            self.assertEqual(feature["owner"]["content_hash"], sources[relative])
            self.assertEqual(feature["implemented"]["status"], "available")
            for dimension in ("reachable", "configured"):
                self.assertIn(feature[dimension]["status"], {"available", "unknown"})
            self.assertEqual(feature["demonstrated"]["status"], "unknown")
            self.assertEqual(feature["runtime"]["status"], "unknown")

    def test_a_commit_is_on_the_map_by_the_next_cycle(self) -> None:
        # PLAN Wave 3 completion evidence: "a user commit is in the graph on
        # the next cycle" — the property the CLI-only twin could not have.
        self._run("cyc-1")
        head = self._commit("apps/svc/src/b.ts", "export const b = 2;\n")
        self._run("cyc-2")
        self.assertEqual(read_twin_map(base_dir=self.tools)["indexed_sha"], head)

    def _discover_annotated_pilot(self) -> dict:
        from aria_kernel.discovery import run_discovery
        path = self.repo / "aria-kernel/aria_kernel/runtime_artifacts.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('def autonomy_output_summary(payload: dict) -> dict:\n'
                        '    """Summarize supplied receipts."""\n    return payload\n', encoding="utf-8")
        _git(self.repo, "add", "aria-kernel")
        _git(self.repo, "commit", "-q", "-m", "fixture: annotated pilot")
        return run_discovery(workspace_root=self.repo, cycle_id="cyc-display", base_dir=self.tools)

    def _discover_named_pilot_scope(self, *, mode="working_tree",
                                    deadline_seconds=AMPLE_QUALIFICATION_DEADLINE_SECONDS) -> dict:
        from aria_kernel.cycle import _phase_discovery
        kernel = Path(__file__).resolve().parents[1]
        modules = (
            "runtime_artifacts", "knowledge_graph", "cycle_phases/memory", "cli", "autonomy_orchestrator",
            "reflection_inputs", "reflection", "report", "snapshot", "discovery", "twin", "convergence_drainer",
            "convergent_planning_bridge", "cross_review_bridge", "plan_convergence", "runtime_profile",
            "agent_surface", "agent_network", "capability_gap", "state_manifest", "tool_registry", "agent_invocations",
        )
        tests = ("test_runtime_artifacts", "test_autonomy_orchestrator", "test_learned_context_and_intent",
                 "test_twin_map", "test_phase2_fates_snapshot", "test_prompt_render_versioning", "test_convergence_resumable_step")
        paths = [f"aria_kernel/{name}.py" for name in modules] + [f"tests/{name}.py" for name in tests] + ["pyproject.toml"]
        for relative in paths:
            destination = self.repo / "aria-kernel" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((kernel / relative).read_bytes())
        (self.repo / ".gitignore").write_text("aria-kernel/tests/test_ignored_*.py\n", encoding="utf-8")
        # ARIA-MEDIUM-082 — the named scope is ~30 bounded Git reads at
        # refresh and again at every mint; "available" must be a property
        # of the source view, not of host load, so the allowance is widened
        # through the policy seam the runtime reads.
        write_source_qualification_override(self.repo, deadline_seconds=deadline_seconds)
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: actual named pilot inputs")
        context = build_phase_context(cycle_id="cyc-freshness", workspace_root=self.repo,
                                      base_dir=self.tools, snapshot_mode=mode)
        context.results["discovery"] = _phase_discovery(context)
        return _phase_twin_refresh(context)

    def _mint_named_pilot(self, *, marker: str, root: Path | None = None, cycle_id="cyc-freshness", **budget_options) -> dict:
        from aria_kernel import agent_invocations as ai
        request = ai.create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="Inspect existing scoped convention retrieval: " + marker,
            must_satisfy=[{"id": "MS1", "description": "Use existing native knowledge owners"}],
            allowed_scope=["aria-kernel/**"],
            evidence_refs=["aria-kernel/aria_kernel/knowledge_graph.py:1"],
            base_dir=self.tools, context_repo_root=root or self.repo, cycle_id=cycle_id,
            target_sha=_git(root or self.repo, "rev-parse", "HEAD").strip(),
            **budget_options,
        )
        native = ai.verify_invocation_context_binding(
            request_id=request["request_id"], context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], base_dir=self.tools,
        )
        self.assertEqual(ai.render_invocation_prompt(request), native["prompt"]["prompt_text"])
        self.assertEqual(ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)), native["prompt"]["prompt_text"])
        self.assertEqual("sha256:" + hashlib.sha256(native["prompt"]["prompt_text"].encode("utf-8")).hexdigest(), request["prompt_hash"])
        self.assertEqual(request["context_ledger_hash"], native["context"]["ledger_hash"])
        self.assertEqual(request["prompt_ledger_hash"], native["prompt"]["ledger_hash"])
        self.assertEqual(native["context"]["repo_root"], str((root or self.repo).resolve()))
        self.assertEqual(native["context"]["budget_audit_hash"], request["budget_audit_hash"])
        from aria_kernel.ledger import load_declared_jsonl
        stored = next(row for row in load_declared_jsonl(
            self.tools / "agent-invocations/requests.jsonl", expected_surface="agent_invocation_requests",
        ) if row["request_id"] == request["request_id"])
        self.assertEqual(json.dumps(stored, sort_keys=True), json.dumps(request, sort_keys=True))
        self.assertEqual(stored["cycle_id"], cycle_id)
        return request

    def _native_prompt_prefixes(self) -> dict:
        return {name: (self.tools / f"agent-invocations/{name}.jsonl").read_bytes()
                for name in ("requests", "contexts", "prompts")}

    def _assert_native_prompt_prefixes(self, prefixes: dict) -> None:
        for name, payload in prefixes.items():
            self.assertTrue((self.tools / f"agent-invocations/{name}.jsonl").read_bytes().startswith(payload), name)

    def test_named_scope_reaches_native_mint_with_independent_dimensions(self) -> None:
        from aria_kernel import snapshot, discovery, twin
        mapped = self._discover_named_pilot_scope()
        from aria_kernel import cycle
        with patch.object(cycle, "run_discovery", side_effect=AssertionError("No cycle discovery at mint")) as cycle_discover, \
                patch.object(discovery, "build_repo_snapshot", side_effect=AssertionError("No discovery snapshot at mint")) as discovery_scan, \
                patch.object(snapshot, "build_repo_snapshot", side_effect=AssertionError("No snapshot at mint")) as scan, \
                patch.object(discovery, "run_discovery", side_effect=AssertionError("No discovery at mint")) as discover:
            request = self._mint_named_pilot(marker="normal named scope")
        scan.assert_not_called()
        discover.assert_not_called()
        cycle_discover.assert_not_called()
        discovery_scan.assert_not_called()
        self.assertIn("self_features", request["repository_map"], "Actual mint must carry qualified owner knowledge")
        view = request["repository_map"]["self_features"]
        self.assertEqual(view["qualification"]["status"], "available")
        self.assertEqual(view["input_binding"], mapped["self_features"]["input_binding"])
        self.assertEqual(set(view["features"]), {"runtime_artifacts.autonomy_output_summary", "knowledge_graph.conventions_for_paths"})
        feature = view["features"]["knowledge_graph.conventions_for_paths"]
        self.assertEqual(feature["implemented"]["status"], "available")
        self.assertEqual(feature["reachable"]["status"], "available")
        self.assertEqual(feature["reachable"]["reason"], "static_call_observed")
        self.assertIn("aria-kernel/aria_kernel/agent_invocations.py", {entry["path"] for entry in feature["callers"]})
        self.assertEqual(feature["configured"]["status"], "unknown")
        self.assertEqual(feature["demonstrated"]["status"], "unknown")
        self.assertEqual(feature["runtime"]["status"], "unknown")
        self.assertEqual(feature["tests"]["method"], "named_behavioral_test_scope_not_execution")
        self.assertTrue(view["input_binding"]["test_content_digest"])
        self.assertTrue(view["input_binding"]["config_digest"])
        self.assertTrue(view["input_binding"]["dependency_digest"])
        self.assertEqual(view["input_binding"]["availability"]["dependency"]["status"], "unknown")
        self.assertIn("Existing ARIA capabilities", render_invocation_prompt(request))
        self.assertGreaterEqual(request["prompt_render_version"], 5)

    def test_working_source_edit_invalidates_new_mint_without_rewriting_old_prompt(self) -> None:
        from aria_kernel import agent_invocations as ai
        self._discover_named_pilot_scope()
        old = self._mint_named_pilot(marker="before ordinary edit")
        old_prompt = ai.render_invocation_prompt(old)
        prefixes = self._native_prompt_prefixes()
        path = self.repo / "aria-kernel/aria_kernel/knowledge_graph.py"
        path.write_bytes(path.read_bytes() + b"\n# ordinary source revision\n")
        new = self._mint_named_pilot(marker="after ordinary edit")
        self.assertIn("self_features", new["repository_map"])
        self.assertEqual(new["repository_map"]["self_features"]["qualification"], {
            "status": "unknown", "reason": "scoped_content_changed_or_unavailable",
        })
        self.assertEqual(ai.render_invocation_prompt(old), old_prompt)
        self.assertEqual(ai.render_invocation_prompt(ai.fuse_prompt_envelope(old)), old_prompt)
        self._assert_native_prompt_prefixes(prefixes)

    def test_named_test_edit_invalidates_the_stored_test_observation(self) -> None:
        self._discover_named_pilot_scope()
        path = self.repo / "aria-kernel/tests/test_learned_context_and_intent.py"
        path.write_bytes(path.read_bytes() + b"\n# ordinary additional test review\n")
        request = self._mint_named_pilot(marker="changed test")
        self.assertIn("self_features", request["repository_map"])
        self.assertEqual(request["repository_map"]["self_features"]["qualification"]["status"], "unknown")
        self.assertIn(path.relative_to(self.repo).as_posix(), request["repository_map"]["self_features"]["changed_paths"])

    def test_named_config_and_dependency_edits_refresh_only_the_new_observation(self) -> None:
        from aria_kernel.discovery import run_discovery
        from aria_kernel.twin import refresh_twin_map
        original = self._discover_named_pilot_scope()
        original_binding = original["self_features"]["input_binding"]
        old = self._mint_named_pilot(marker="initial config observation")
        prefixes = self._native_prompt_prefixes()
        path = self.repo / "aria-kernel/pyproject.toml"
        path.write_text(path.read_text().replace('"pytest>=8.0"', '"pytest>=8.1"') + '\n# config observation changed\n', encoding="utf-8")
        pending = self._mint_named_pilot(marker="changed declared dependency and config")
        self.assertIn("self_features", pending["repository_map"])
        self.assertEqual(pending["repository_map"]["self_features"]["qualification"]["status"], "unknown")
        discovered = run_discovery(workspace_root=self.repo, cycle_id="cyc-refreshed", base_dir=self.tools, snapshot_mode="working_tree")
        refreshed = refresh_twin_map(workspace_root=self.repo, base_dir=self.tools, discovery=discovered)
        self.assertEqual(refreshed["indexed_sha"], original["indexed_sha"])
        for field in ("config_digest", "dependency_digest"):
            self.assertNotEqual(refreshed["self_features"]["input_binding"][field], original_binding[field])
        fresh = self._mint_named_pilot(marker="after normal discovery refresh", cycle_id="cyc-refreshed")
        self.assertEqual(fresh["repository_map"]["self_features"]["qualification"]["status"], "available")
        self.assertEqual(fresh["repository_map"]["self_features"]["discovery"]["cycle_id"], "cyc-refreshed")
        self.assertEqual(fresh["repository_map"]["self_features"]["input_binding"]["availability"]["dependency"]["status"], "unknown")
        self._assert_native_prompt_prefixes(prefixes)
        self.assertEqual(old["cycle_id"], "cyc-freshness")

    def test_new_nonignored_test_membership_invalidates_without_a_full_mint_scan(self) -> None:
        self._discover_named_pilot_scope()
        ignored = self.repo / "aria-kernel/tests/test_ignored_scratch.py"
        ignored.write_text("value = 1\n", encoding="utf-8")
        ignored_request = self._mint_named_pilot(marker="ignored scratch")
        self.assertIn("self_features", ignored_request["repository_map"])
        self.assertEqual(ignored_request["repository_map"]["self_features"]["qualification"]["status"], "available")
        new = self.repo / "aria-kernel/tests/test_new_related.py"
        new.write_text("from aria_kernel.knowledge_graph import conventions_for_paths\n", encoding="utf-8")
        request = self._mint_named_pilot(marker="new relevant membership")
        self.assertEqual(request["repository_map"]["self_features"]["qualification"], {
            "status": "unknown", "reason": "scoped_membership_changed_or_unavailable",
        })

    def test_missing_named_working_input_keeps_native_absence_diagnostic(self) -> None:
        self._discover_named_pilot_scope()
        old = self._mint_named_pilot(marker="before ordinary deletion")
        prefixes = self._native_prompt_prefixes()
        old_prompt = render_invocation_prompt(old)
        relative = "aria-kernel/tests/test_learned_context_and_intent.py"
        (self.repo / relative).unlink()
        self.assertIn(relative, _git(self.repo, "ls-files").splitlines())
        current = self._mint_named_pilot(marker="after ordinary unstaged deletion")
        view = current["repository_map"]["self_features"]
        self.assertEqual(view["qualification"], {"status": "unknown", "reason": "scoped_content_changed_or_unavailable"})
        self.assertEqual(view["features"], {})
        self.assertIn(relative, view["changed_paths"])
        self.assertEqual(view["qualification_details"]["unavailable_sources"],
                         [{"path": relative, "status": "unknown", "reason": "input_missing"}])
        self.assertIn("input_missing", render_invocation_prompt(current))
        self._assert_native_prompt_prefixes(prefixes)
        self.assertEqual(render_invocation_prompt(old), old_prompt)

    def test_committed_mint_uses_selected_bytes_then_rejects_a_new_target(self) -> None:
        mapped = self._discover_named_pilot_scope(mode="committed")
        old = self._mint_named_pilot(marker="selected commit A")
        prefixes = self._native_prompt_prefixes()
        old_prompt = render_invocation_prompt(old)
        owner = self.repo / "aria-kernel/aria_kernel/knowledge_graph.py"
        original_owner_hash = "sha256:" + hashlib.sha256(owner.read_bytes()).hexdigest()
        owner.write_bytes(owner.read_bytes() + b"\n# ordinary working edit beyond selected commit A\n")
        (self.repo / "aria-kernel/tests/test_new_related.py").write_text("value = 1\n", encoding="utf-8")
        still_a = self._mint_named_pilot(marker="selected A with different working files")
        view = still_a["repository_map"]["self_features"]
        self.assertEqual(view["qualification"]["status"], "available")
        self.assertEqual(view["input_binding"], mapped["self_features"]["input_binding"])
        self.assertEqual(view["features"]["knowledge_graph.conventions_for_paths"]["owner"]["content_hash"], original_owner_hash)
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: ordinary next committed source")
        new = self._mint_named_pilot(marker="new commit B without refresh")
        view_b = new["repository_map"]["self_features"]
        self.assertEqual(view_b["qualification"], {"status": "unknown", "reason": "target_revision_changed_or_unavailable"})
        self.assertEqual(view_b["features"], {})
        self.assertEqual(read_twin_map(base_dir=self.tools)["indexed_sha"], mapped["indexed_sha"])
        self._assert_native_prompt_prefixes(prefixes)
        self.assertEqual(render_invocation_prompt(old), old_prompt)

    def test_membership_limit_reason_reaches_native_mint_with_one_spare_control(self) -> None:
        from aria_kernel import twin, snapshot
        mapped = self._discover_named_pilot_scope()
        count = len(mapped["self_features"]["membership"]["paths"])
        self.assertGreater(count, 0)
        real_budget = snapshot._ScopedSourceBudget
        # The membership cap is what is narrowed; the deadline the mint
        # resolved from policy passes through untouched.
        with patch.object(twin, "_ScopedSourceBudget",
                          side_effect=lambda **deadline: real_budget(membership_limit=count, **deadline)):
            exact = self._mint_named_pilot(marker="exact consumed record boundary")
        view = exact["repository_map"]["self_features"]
        self.assertEqual(view["qualification"]["status"], "unknown")
        self.assertEqual(view["features"], {})
        self.assertEqual(view["work"]["paths_attempted"], 0)
        self.assertEqual(view["work"]["remaining_membership_record_allowance"], 0)
        self.assertEqual(view["qualification_details"]["membership"],
                         {"status": "unknown", "reason": "scoped_membership_limit"})
        self.assertIn("scoped_membership_limit", render_invocation_prompt(exact))
        with patch.object(twin, "_ScopedSourceBudget",
                          side_effect=lambda **deadline: real_budget(membership_limit=count + 1, **deadline)):
            spare = self._mint_named_pilot(marker="one record of EOF headroom")
        self.assertEqual(spare["repository_map"]["self_features"]["qualification"]["status"], "available")
        self.assertEqual(spare["repository_map"]["self_features"]["work"]["known_emitted_membership_records"], count)

    def test_source_role_digest_matches_existing_v1_file_observation_encoding(self) -> None:
        mapped = self._discover_named_pilot_scope()
        binding = mapped["self_features"]["input_binding"]
        rows = []
        for path in sorted(p for p in binding["scope_paths"] if p.startswith("aria-kernel/aria_kernel/")):
            body = (self.repo / path).read_bytes()
            rows.append({"path": path, "status": "available", "reason": "explicit_file_observed",
                         "size_bytes": len(body), "content_hash": "sha256:" + hashlib.sha256(body).hexdigest()})
        expected_bytes = json.dumps({"schema_version": 1, "files": rows}, sort_keys=True,
                                    separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        self.assertEqual(binding["source_digest"], "sha256:" + hashlib.sha256(expected_bytes).hexdigest())

    def test_full_render_audit_binds_actual_feature_test_and_status(self) -> None:
        from aria_kernel import context_budget_gate as gate
        self._discover_named_pilot_scope()
        agent = self.repo / ".claude/agents/aria-evidence-judge.md"
        agent.parent.mkdir(parents=True)
        agent.write_text("---\nname: aria-evidence-judge\n---\n@docs/aria/pilot.md\nRead named evidence.\n", encoding="utf-8")
        bookmark = self.repo / "docs/aria/pilot.md"
        bookmark.parent.mkdir(parents=True)
        bookmark.write_text("Keep source observations separate from actual execution.\n", encoding="utf-8")
        with patch.object(gate, "_read_agent_md", wraps=gate._read_agent_md) as read_agent, \
                patch.object(gate, "_read_knowledge", wraps=gate._read_knowledge) as read_knowledge:
            request = self._mint_named_pilot(marker="full rendered accounting")
        self.assertEqual(read_agent.call_count, 1)
        self.assertEqual(read_knowledge.call_count, 1)
        feature = request["repository_map"]["self_features"]["features"]["knowledge_graph.conventions_for_paths"]
        expected_id = "tests/test_learned_context_and_intent.py::ConventionsForPathsTest::test_only_related_confident_conventions_surface"
        test_ref = next(item for item in feature["tests"]["refs"] if item["test_id"] == expected_id)
        test_path = "aria-kernel/tests/test_learned_context_and_intent.py"
        self.assertEqual(test_ref["path"], test_path)
        self.assertEqual(test_ref["content_hash"], "sha256:" + hashlib.sha256((self.repo / test_path).read_bytes()).hexdigest())
        prompt = render_invocation_prompt(request)
        feature_section = prompt[prompt.index("## Existing ARIA capabilities"):].split("</derived_context>", 1)[0]
        self.assertLessEqual(gate.estimate_tokens(feature_section), 1200)
        rendered = next(json.loads(line) for line in prompt.splitlines()
                        if line.startswith('{"callers":') and '"feature":"knowledge_graph.conventions_for_paths"' in line)
        self.assertEqual(rendered["owner"], feature["owner"])
        self.assertIn(expected_id, rendered["tests_are_not_execution"])
        self.assertEqual(rendered["statuses"]["implemented"]["status"], "available")
        self.assertEqual(rendered["statuses"]["reachable"], {"status": "available", "reason": "static_call_observed"})
        for dimension in ("configured", "demonstrated", "runtime"):
            self.assertEqual(rendered["statuses"][dimension]["status"], "unknown")
        audit = next(row for row in gate.list_context_audits(base_dir=self.tools)
                     if row["ledger_hash"] == request["budget_audit_hash"])
        self.assertEqual(audit["request_token_estimate"], gate.estimate_tokens(prompt))
        self.assertEqual(audit["evidence_excerpts_token_estimate"], 0, "The full render already contains the excerpts")
        self.assertEqual(audit["agent_token_estimate"], gate.estimate_tokens(agent.read_text()))
        self.assertEqual(audit["knowledge_token_estimate"], gate.estimate_tokens(bookmark.read_text()))
        self.assertEqual(audit["total_estimate"], gate.estimate_tokens(prompt) + gate.estimate_tokens(agent.read_text())
                         + gate.estimate_tokens(bookmark.read_text()))

    def test_existing_native_request_returns_without_requalification_or_new_audit(self) -> None:
        from aria_kernel import agent_invocations as ai
        self._discover_named_pilot_scope()
        old = self._mint_named_pilot(marker="same issued request")
        prefixes = self._native_prompt_prefixes()
        audit_bytes = (self.tools / "context-audits.jsonl").read_bytes()
        source = self.repo / "aria-kernel/aria_kernel/knowledge_graph.py"
        source.write_bytes(source.read_bytes() + b"\n# normal later edit\n")
        with ExitStack() as stack:
            lookups = [stack.enter_context(patch.object(ai, name, side_effect=AssertionError("Sealed request must not reacquire " + name)))
                       for name in ("_repository_map_for_refs", "_established_knowledge_for_refs", "_past_failed_attempts_for_paths",
                                    "_recent_intent_for_refs", "_decision_memory_for_request", "_evidence_excerpts_for_refs")]
            replay = self._mint_named_pilot(marker="same issued request", enforce_context_budget=True,
                                           context_window_tokens_override=1)
        for lookup in lookups:
            lookup.assert_not_called()
        self.assertEqual(json.dumps(replay, sort_keys=True), json.dumps(old, sort_keys=True))
        self.assertEqual(self._native_prompt_prefixes(), prefixes)
        self.assertEqual((self.tools / "context-audits.jsonl").read_bytes(), audit_bytes)

    def test_omitted_and_none_hints_preserve_legacy_identity_and_native_bytes(self) -> None:
        self._discover_named_pilot_scope()
        original = self._mint_named_pilot(marker="omitted hint identity")
        before = self._native_prompt_prefixes()
        explicit_none = self._mint_named_pilot(marker="omitted hint identity", context_source_paths=None)
        self.assertEqual(original["request_id"], explicit_none["request_id"])
        self.assertNotIn("context_source_paths", original)
        self.assertEqual(self._native_prompt_prefixes(), before)

    def test_normalized_hints_replay_but_changed_hints_mint_a_new_identity(self) -> None:
        self._discover_named_pilot_scope()
        path = "aria-kernel/aria_kernel/knowledge_graph.py"
        original = self._mint_named_pilot(marker="normalized hint identity", context_source_paths=["./" + path, path])
        self.assertEqual(original["context_source_paths"], [path])
        before = self._native_prompt_prefixes()
        normalized = self._mint_named_pilot(marker="normalized hint identity", context_source_paths=[path])
        self.assertEqual(original["request_id"], normalized["request_id"])
        self.assertEqual(self._native_prompt_prefixes(), before)
        changed = self._mint_named_pilot(marker="normalized hint identity",
                                         context_source_paths=["aria-kernel/aria_kernel/runtime_artifacts.py"])
        self.assertNotEqual(original["request_id"], changed["request_id"])
        self.assertEqual(changed["evidence_refs"], original["evidence_refs"])
        self.assertEqual(changed["allowed_scope"], original["allowed_scope"])
        self._assert_native_prompt_prefixes(before)

    def test_same_supported_hints_keep_partial_status_in_sealed_identity(self) -> None:
        self._discover_named_pilot_scope()
        path = "aria-kernel/aria_kernel/knowledge_graph.py"
        original = self._mint_named_pilot(marker="hint status identity", context_source_paths=["./" + path])
        self.assertNotIn("context_source_paths_status", original)
        before = self._native_prompt_prefixes()
        partial = self._mint_named_pilot(marker="hint status identity", context_source_paths=[path, "aria-kernel/**"])
        self.assertEqual(partial["context_source_paths"], original["context_source_paths"])
        self.assertEqual(partial["context_source_paths_status"]["status"], "partial")
        self.assertNotEqual(partial["request_id"], original["request_id"])
        self.assertNotEqual(partial["context_hash"], original["context_hash"])
        self.assertNotEqual(partial["prompt_hash"], original["prompt_hash"])
        self.assertEqual(partial["evidence_refs"], original["evidence_refs"])
        self.assertEqual(partial["allowed_scope"], original["allowed_scope"])
        self.assertIn("unsupported_literal_hints", render_invocation_prompt(partial))
        self._assert_native_prompt_prefixes(before)
        after = self._native_prompt_prefixes()
        replay = self._mint_named_pilot(marker="hint status identity", context_source_paths=[path, "aria-kernel/**"])
        self.assertEqual(replay["request_id"], partial["request_id"])
        self.assertEqual(self._native_prompt_prefixes(), after)

    def test_full_prompt_cap_omits_optional_features_before_native_seal(self) -> None:
        from aria_kernel import context_budget_gate as gate
        self._discover_named_pilot_scope()
        agent_text = "---\nname: aria-evidence-judge\n---\n@docs/aria/packing.md\nInspect owner evidence.\n"
        bookmark_text = "Retain current source identities and distinguish observed execution.\n"
        agent = self.repo / ".claude/agents/aria-evidence-judge.md"
        agent.parent.mkdir(parents=True)
        agent.write_text(agent_text, encoding="utf-8")
        bookmark = self.repo / "docs/aria/packing.md"
        bookmark.parent.mkdir(parents=True)
        bookmark.write_text(bookmark_text, encoding="utf-8")
        initial = self._mint_named_pilot(marker="optional packing initial")
        baseline = json.loads(json.dumps(initial))
        baseline["repository_map"].pop("self_features")
        baseline_tokens = gate.estimate_tokens(render_invocation_prompt(baseline))
        self.assertGreater(gate.estimate_tokens(render_invocation_prompt(initial)) - baseline_tokens, 200)
        captured_preamble_cost = gate.estimate_tokens(agent_text) + gate.estimate_tokens(bookmark_text)
        window = baseline_tokens + captured_preamble_cost + 100
        limited = self._mint_named_pilot(marker="optional packing limited", enforce_context_budget=True,
                                         context_window_tokens_override=window, role_cap_override={"evidence_judgment": 1.0})
        prompt = render_invocation_prompt(limited)
        self.assertLessEqual(gate.estimate_tokens(prompt) + captured_preamble_cost, window,
                             "Full native prompt plus captured preamble must fit the selected role cap")
        view = limited["repository_map"]["self_features"]
        self.assertEqual(view["features"], {})
        self.assertEqual(view["selection"]["omitted_count"], 2)
        self.assertEqual(view["selection"]["reason"], "full_context_budget")
        audit = next(row for row in gate.list_context_audits(base_dir=self.tools)
                     if row["ledger_hash"] == limited["budget_audit_hash"])
        self.assertEqual(audit["request_token_estimate"], gate.estimate_tokens(prompt))
        self.assertEqual(audit["total_estimate"], gate.estimate_tokens(prompt) + captured_preamble_cost)
        self.assertFalse(audit["cap_breached"])
        self.assertIn("optional packing limited", prompt)
        self.assertIn("aria-kernel/**", prompt)

    def test_oversized_baseline_keeps_explicit_audit_only_or_enforced_choice(self) -> None:
        from aria_kernel import context_budget_gate as gate
        self._discover_named_pilot_scope()
        request = self._mint_named_pilot(marker="audit only baseline", context_window_tokens_override=64,
                                         role_cap_override={"evidence_judgment": 1.0})
        audit = next(row for row in gate.list_context_audits(base_dir=self.tools)
                     if row["ledger_hash"] == request["budget_audit_hash"])
        self.assertTrue(audit["cap_breached"])
        self.assertGreater(audit["total_estimate"], 64)
        self.assertEqual(request["repository_map"]["self_features"]["features"], {})
        native_before = self._native_prompt_prefixes()
        with self.assertRaisesRegex(GovernanceError, "context_budget_exceeded"):
            self._mint_named_pilot(marker="enforced oversized baseline", enforce_context_budget=True,
                                   context_window_tokens_override=64, role_cap_override={"evidence_judgment": 1.0})
        self.assertEqual(self._native_prompt_prefixes(), native_before)
        audits = gate.list_context_audits(base_dir=self.tools)
        self.assertEqual(len(audits), 2)
        self.assertTrue(audits[-1]["cap_breached"])

    def test_final_audit_keeps_captured_bookmark_cost_after_ordinary_edit(self) -> None:
        from aria_kernel import context_budget_gate as gate
        self._discover_named_pilot_scope()
        agent = self.repo / ".claude/agents/aria-evidence-judge.md"
        agent.parent.mkdir(parents=True)
        agent.write_text("@docs/aria/captured.md\nRead the native source.\n", encoding="utf-8")
        bookmark = self.repo / "docs/aria/captured.md"
        bookmark.parent.mkdir(parents=True)
        original = "This is the original captured observation.\n"
        bookmark.write_text(original, encoding="utf-8")
        real_read = gate._read_knowledge

        def read_then_edit(refs, root):
            result = real_read(refs, root)
            bookmark.write_text("Ordinary later document content.\n" * 1000, encoding="utf-8")
            return result

        with patch.object(gate, "_read_knowledge", side_effect=read_then_edit) as read:
            request = self._mint_named_pilot(marker="captured preamble observation")
        self.assertEqual(read.call_count, 1)
        self.assertNotEqual(bookmark.read_text(), original)
        audits = gate.list_context_audits(base_dir=self.tools)
        self.assertEqual(len(audits), 1)
        audit = audits[0]
        self.assertEqual(audit["ledger_hash"], request["budget_audit_hash"])
        self.assertEqual(audit["knowledge_token_estimate"], gate.estimate_tokens(original))
        self.assertEqual(audit["total_estimate"], gate.estimate_tokens(render_invocation_prompt(request))
                         + gate.estimate_tokens(agent.read_text()) + gate.estimate_tokens(original))

    def test_two_native_mints_keep_one_winning_audit_and_sealed_binding(self) -> None:
        import threading
        from concurrent.futures import ThreadPoolExecutor
        from aria_kernel import agent_invocations as ai, context_budget_gate as gate
        from aria_kernel.ledger import load_declared_jsonl
        self._discover_named_pilot_scope()
        arrivals = threading.Barrier(2)
        winner_done = threading.Event()
        caller = threading.local()
        real_find = ai._find_request_by_id
        misses = []

        def observe_actual_miss(root, request_id):
            result = real_find(root, request_id)
            self.assertIsNone(result)
            misses.append(caller.name)
            arrivals.wait(timeout=30)
            if caller.name == "later":
                self.assertTrue(winner_done.wait(timeout=30))
            return result

        def mint(name):
            caller.name = name
            try:
                return self._mint_named_pilot(marker="same concurrent request", enforce_context_budget=True,
                                               context_window_tokens_override=1 if name == "later" else 200_000)
            finally:
                if name == "first":
                    winner_done.set()

        with patch.object(ai, "_find_request_by_id", side_effect=observe_actual_miss), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(mint, "first")
            later = pool.submit(mint, "later")
            results = [first.result(timeout=45), later.result(timeout=45)]
        self.assertEqual(sorted(misses), ["first", "later"])
        self.assertEqual(json.dumps(results[0], sort_keys=True), json.dumps(results[1], sort_keys=True))
        for name, surface in (("requests", "agent_invocation_requests"), ("contexts", "agent_invocation_contexts"),
                              ("prompts", "agent_invocation_prompts")):
            self.assertEqual(len(load_declared_jsonl(self.tools / f"agent-invocations/{name}.jsonl", expected_surface=surface)), 1)
        audits = gate.list_context_audits(base_dir=self.tools)
        self.assertEqual(len(audits), 1, "No speculative trial or losing-candidate audit may be persisted")
        self.assertEqual(results[0]["budget_audit_hash"], audits[0]["ledger_hash"])
        self.assertFalse(audits[0]["cap_breached"])
        events = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual(sum(row["kind"] == "context_budget_audited" for row in events), 1)
        self.assertFalse(any(row["kind"] == "context_budget_exceeded" for row in events))

    def test_optional_annotation_error_preserves_definition_status(self) -> None:
        from aria_kernel import twin
        discovered = self._discover_annotated_pilot()
        with patch.object(ast, "unparse", side_effect=RecursionError("ordinary display recursion")):
            inventory = twin._self_feature_projection(self.repo, discovered, qualification_deadline_seconds=120.0)
        feature = inventory["features"]["runtime_artifacts.autonomy_output_summary"]
        self.assertEqual(feature["implemented"], {
            "status": "available", "reason": "selected_source_definition",
            "evidence_refs": ["aria-kernel/aria_kernel/runtime_artifacts.py:1"],
        })
        self.assertEqual(feature["output"], {
            "kind": "source_annotation", "status": "unknown", "reason": "source_display_unavailable", "text": None,
        })
        self.assertEqual(feature["inputs"], ["payload"])
        self.assertEqual(feature["demonstrated"]["status"], "unknown")

    def test_deadline_after_formatting_does_not_leave_available_definition(self) -> None:
        from aria_kernel import twin, snapshot
        discovered = self._discover_annotated_pilot()
        clock = [0.0]
        real_unparse = ast.unparse
        calls = []

        def complete_after_deadline(node):
            result = real_unparse(node)
            calls.append(result)
            clock[0] = 3.0
            return result

        # Allowance 2 on a clock that jumps 0 -> 3 across the formatting call.
        with patch.object(snapshot._time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(ast, "unparse", side_effect=complete_after_deadline):
            inventory = twin._self_feature_projection(self.repo, discovered, qualification_deadline_seconds=2.0)
        self.assertEqual(calls, ["dict"])
        self.assertEqual(inventory["features"]["runtime_artifacts.autonomy_output_summary"]["implemented"], {
            "status": "unknown", "reason": "qualification_deadline",
        })

    def test_later_named_read_expiry_prevents_starting_owner_ast(self) -> None:
        from aria_kernel import twin, snapshot
        config = self.repo / "aria-kernel/pyproject.toml"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('[project]\nname = "ordinary-pilot"\n', encoding="utf-8")
        discovered = self._discover_annotated_pilot()
        clock = [0.0]
        reads = []
        real_read = twin._read_scoped_source_bytes

        def expire_during_later_read(root, fate, **kwargs):
            observation, data = real_read(root, fate, **kwargs)
            if data is not None:
                reads.append(fate["path"])
            if fate["path"] == "aria-kernel/pyproject.toml":
                self.assertIsNotNone(data)
                clock[0] = 3.0
            return observation, data

        # Allowance 2 on a clock that jumps 0 -> 3 during the later read.
        with patch.object(snapshot._time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(twin, "_read_scoped_source_bytes", side_effect=expire_during_later_read), \
                patch.object(ast, "parse", wraps=ast.parse) as parsed:
            inventory = twin._self_feature_projection(self.repo, discovered, qualification_deadline_seconds=2.0)
        self.assertEqual(reads, ["aria-kernel/aria_kernel/runtime_artifacts.py", "aria-kernel/pyproject.toml"])
        self.assertEqual(clock[0], 3.0)
        self.assertEqual(parsed.call_count, 0, "A retained owner body must not start parsing after a later read exhausts the deadline")
        self.assertEqual(inventory["features"]["runtime_artifacts.autonomy_output_summary"]["implemented"], {
            "status": "unknown", "reason": "qualification_deadline",
        })

    def test_qualification_allowance_is_read_from_policy_at_refresh_and_at_mint(self) -> None:
        """ARIA-MEDIUM-082 — the allowance is the operator's number, and disclosed.

        Both qualification sites resolve ``source_qualification.deadline_seconds``
        against the workspace's policy override and record the allowance they
        ran under, so a reader of "qualification_deadline" sees the budget,
        not just the verdict.
        """
        from aria_kernel import twin
        mapped = self._discover_named_pilot_scope(deadline_seconds=42.5)
        inventory = mapped["self_features"]
        self.assertEqual(inventory["work"]["qualification_deadline_seconds"], 42.5)
        self.assertEqual(inventory["features"]["knowledge_graph.conventions_for_paths"]["implemented"]["status"],
                         "available")
        request = self._mint_named_pilot(marker="policy-bounded qualification")
        view = request["repository_map"]["self_features"]
        self.assertEqual(view["work"]["qualification_deadline_seconds"], 42.5)
        self.assertEqual(view["qualification"]["status"], "available")
        # No workspace bound at mint: the shipped default, not a literal here.
        unbound = twin._qualified_twin_context(
            base_dir=self.tools, files=["aria-kernel/aria_kernel/knowledge_graph.py"], workspace_root=None,
            cycle_id="cyc-freshness", target_sha=None,
        )
        self.assertNotIn("self_features", unbound)
        self.assertEqual(twin._qualification_deadline_seconds(None), 2.0)

    def test_an_exhausted_policy_allowance_is_an_honest_qualification_deadline(self) -> None:
        """ARIA-MEDIUM-082 — no clock is patched: a zero allowance really expires.

        The projection and the mint-time re-observation both answer
        ``qualification_deadline`` — an honest unknown — rather than
        pretending to a source view they were not allowed to read.
        """
        from aria_kernel import twin
        discovered = self._discover_annotated_pilot()
        write_source_qualification_override(self.repo, deadline_seconds=0)
        refreshed = twin.refresh_twin_map(workspace_root=self.repo, base_dir=self.tools, discovery=discovered)
        inventory = refreshed["self_features"]
        self.assertEqual(inventory["work"]["qualification_deadline_seconds"], 0.0)
        self.assertEqual(inventory["work"]["known_source_bytes"], 0)
        self.assertEqual(set(inventory["features"]), {
            "runtime_artifacts.autonomy_output_summary", "knowledge_graph.conventions_for_paths",
        })
        for feature in inventory["features"].values():
            for dimension in ("implemented", "reachable"):
                self.assertEqual(feature[dimension], {"status": "unknown", "reason": "qualification_deadline"})
        self.assertEqual(inventory["input_binding"]["availability"]["source"]["status"], "unknown")
        view = twin._qualified_twin_context(
            base_dir=self.tools, files=["aria-kernel/aria_kernel/runtime_artifacts.py"], workspace_root=self.repo,
            cycle_id="cyc-display", target_sha=discovered["snapshot"]["base_commit_sha"],
        )["self_features"]
        self.assertEqual(view["qualification"], {"status": "unknown", "reason": "qualification_deadline"})
        self.assertEqual(view["features"], {})
        self.assertEqual(view["work"]["qualification_deadline_seconds"], 0.0)

    def test_the_second_cycle_refreshes_rather_than_rebuilds(self) -> None:
        # The other half of the completion evidence: a normal cycle does not
        # do a full scan. `mode` is the discriminator, and it is derived from
        # whether a prior map's anchor commit is known — not from a flag.
        self._run("cyc-1")
        self._commit("apps/svc/src/c.ts", "export const c = 3;\n")
        result = self._run("cyc-2")
        self.assertEqual(result["refresh"]["mode"], "incremental")
        self.assertEqual(result["refresh"]["changed_files"], 1)

    def test_a_cycle_with_no_new_commit_does_no_work(self) -> None:
        self._run("cyc-1")
        result = self._run("cyc-2")
        self.assertEqual(result["refresh"]["mode"], "noop")

    def test_the_refreshed_map_reaches_a_minted_request(self) -> None:
        """THE LOOP. Refresh produces, minting consumes — in one tools root.

        Tested end to end rather than in halves, because the failure this
        guards against is precisely the two halves being individually correct
        and never meeting: a phase that refreshes a map nothing reads, or a
        renderer for a field nothing sets.
        """
        from aria_kernel.agent_invocations import create_agent_invocation_request

        self._run("cyc-1")
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="judge it",
            must_satisfy=[{"id": "M1", "description": "s"}],
            allowed_scope=["apps/svc/**"],
            evidence_refs=["apps/svc/src/a.ts:1"],
            base_dir=self.tools,
            cycle_id="cyc-1",
        )
        self.assertIn("repository_map", request)
        self.assertEqual(
            [entry["file"] for entry in request["repository_map"]["files"]],
            ["apps/svc/src/a.ts"],
        )
        self.assertEqual(request["repository_map"]["files"][0]["project"], "svc")

    def test_a_request_minted_without_a_map_simply_has_no_map(self) -> None:
        # No twin build has run in this tools root. The mint must not fail,
        # and must not invent an empty projection.
        from aria_kernel.agent_invocations import create_agent_invocation_request

        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="judge it",
            must_satisfy=[{"id": "M1", "description": "s"}],
            allowed_scope=["apps/svc/**"],
            evidence_refs=["apps/svc/src/a.ts:1"],
            base_dir=ensure_tools_dir(Path(self._tmp.name) / "aria-tools-empty"),
            cycle_id="cyc-1",
        )
        self.assertNotIn("repository_map", request)


class RepositoryMapIsOrientationNotEvidenceTests(unittest.TestCase):
    """The reader — and the trust boundary it must not cross."""

    def _request(self, **extra) -> dict:
        request = {
            "$schema": "aria/agent-request/v1",
            "request_id": "AIR-test-0001",
            "cycle_id": "cyc-1",
            "role": "evidence_judgment",
            "target_agent": "aria-evidence-judge",
            "evidence_refs": ["apps/svc/src/a.ts:1"],
            "allowed_scope": ["apps/svc/**"],
            "forbidden_scope": [],
            "must_satisfy": [{"id": "M1", "description": "the claim holds"}],
            "validation_commands": ["npm run aria:test:unit"],
            "expected_output_path": "out.json",
            "suggested_prompt": "do the thing",
        }
        request.update(extra)
        return request

    _MAP = {
        "indexed_sha": "a" * 40,
        "files": [
            {
                "file": "apps/svc/src/a.ts",
                "project": "svc",
                "tests": ["apps/svc/src/a.spec.ts"],
                "churn_commits": 7,
                "co_changes_with": [{"file": "apps/svc/src/b.ts", "count": 4}],
            }
        ],
        "impacted_projects": [["svc", {"layer": 0, "depends_on": [], "dependents": ["web-shell"]}]],
    }

    def test_the_map_reaches_the_model(self) -> None:
        prompt = render_invocation_prompt(self._request(repository_map=self._MAP))
        self.assertIn("## Repository map", prompt)
        self.assertIn("apps/svc/src/a.ts", prompt)
        self.assertIn("apps/svc/src/a.spec.ts", prompt)

    def test_the_map_is_labelled_derived_and_not_citable(self) -> None:
        # THE BOUNDARY. A model told to cite only evidence_refs, and handed a
        # map in the same prompt, must be told which is which.
        prompt = render_invocation_prompt(self._request(repository_map=self._MAP))
        map_section = prompt.split("## Repository map", 1)[1].split("\n##", 1)[0]
        self.assertIn("derived", map_section.lower())
        self.assertIn("not evidence", map_section.lower())

    def test_the_map_never_enters_the_evidence_section(self) -> None:
        prompt = render_invocation_prompt(self._request(repository_map=self._MAP))
        evidence_section = prompt.split("## Evidence refs", 1)[1].split("\n##", 1)[0]
        # The evidence block lists exactly the evidence_refs it was given.
        self.assertIn("apps/svc/src/a.ts:1", evidence_section)
        self.assertNotIn("churn", evidence_section.lower())
        self.assertNotIn("co_changes", evidence_section.lower())
        self.assertNotIn("a.spec.ts", evidence_section)

    def test_no_map_means_no_section_rather_than_an_empty_one(self) -> None:
        # Empty scaffolding reads as "the map says nothing about these files",
        # which is a different claim from "there is no map".
        self.assertNotIn("## Repository map", render_invocation_prompt(self._request()))

    def test_a_map_with_no_files_also_renders_nothing(self) -> None:
        # The absent case above is caught by the isinstance guard, so it does
        # NOT pin this one: a mutation dropping the empty-files check left the
        # suite green until this test existed. A projection that resolved no
        # files is the same silence as no projection — printing a heading over
        # nothing turns "I have no map for these paths" into "the map has
        # nothing to say about these paths".
        for empty in ({"indexed_sha": "a" * 40, "files": []}, {"indexed_sha": "a" * 40}):
            with self.subTest(payload=empty):
                prompt = render_invocation_prompt(self._request(repository_map=empty))
                self.assertNotIn("## Repository map", prompt)

    def test_a_prompt_is_a_pure_function_of_its_request(self) -> None:
        # render_invocation_prompt is the SSoT for the prompt whose hash is
        # persisted; if it read the map from disk the hash would depend on
        # when it ran, not on what was asked.
        request = self._request(repository_map=self._MAP)
        self.assertEqual(render_invocation_prompt(request), render_invocation_prompt(request))

    def test_the_contract_type_checks_the_new_field(self) -> None:
        validate_request(self._request(repository_map=self._MAP))
        with self.assertRaises(GovernanceError):
            validate_request(self._request(repository_map=["not", "an", "object"]))

    def test_contract_validates_optional_literal_context_hints(self) -> None:
        validate_request(self._request())
        validate_request(self._request(context_source_paths=["aria-kernel/aria_kernel/twin.py"]))
        for value in ("aria-kernel/aria_kernel/twin.py", ["./aria-kernel/aria_kernel/twin.py"], ["aria-kernel/**"], ["x" * 513]):
            with self.subTest(value_kind=type(value).__name__, sample_length=len(value[0]) if isinstance(value, list) else len(value)):
                with self.assertRaisesRegex(GovernanceError, "context_source_paths"):
                    validate_request(self._request(context_source_paths=value))

    def test_partial_hint_status_requires_its_literal_list(self) -> None:
        status = {"status": "partial", "reason": "unsupported_literal_hints", "supplied_count": 1,
                  "accepted_count": 0, "omitted_count": 1}
        validate_request(self._request(context_source_paths=[], context_source_paths_status=status))
        with self.assertRaisesRegex(GovernanceError, "context_source_paths"):
            validate_request(self._request(context_source_paths_status=status))


if __name__ == "__main__":
    unittest.main()
