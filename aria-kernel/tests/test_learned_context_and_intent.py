"""The learning loop's read side — and the intent layer (FAZ 4).

ARIA recorded a convention on every converged cycle and a belief on every
verified claim, and never once handed either to the agent about to edit the
same files: `record_convention`'s ledger had zero production readers and
`latest_beliefs` fed only the pressure ranking. Every dispatch rediscovered
the repository from zero. `rank_pressure_sources` had zero callers of any
kind.

The enrichment happens at MINT time inside `create_agent_invocation_request`
because the prompt hash is sealed over the rendered text and the claim path
re-renders from the stored envelope (`fuse_prompt_envelope`): knowledge and
intent must be envelope DATA. The content-pin tests below exist because the
binding alone cannot detect the feature's removal — a mint that silently
stops attaching the sections still produces a self-consistent hash.
"""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import agent_invocations as ai
from aria_kernel.tool_registry import ensure_tools_dir

SIGNER = "SHA256:learned-context-test"


def _record_convention(workspace: Path, *, pattern_id: str, confidence: float, ref: str) -> None:
    from aria_kernel.knowledge_graph import Pattern, record_convention

    record_convention(
        Pattern(
            pattern_id=pattern_id,
            pattern_type="convention",
            confidence=confidence,
            evidence_refs=(ref,),
            discovered_by_cycle_id="cyc-know",
            observed_at="2026-08-10T00:00:00+00:00",
        ),
        workspace_root=workspace,
        signer_key_fp=SIGNER,
    )


def _record_belief(tools: Path, *, belief_id: str, claim: str, ref: str, status: str = "supported") -> None:
    from aria_kernel.memory import append_jsonl

    append_jsonl(
        tools / "memory" / "beliefs.jsonl",
        {
            "belief_id": belief_id,
            "claim": claim,
            "status": status,
            "confidence": 0.9,
            "support_count": 3,
            "evidence_refs": [ref],
            "cycle_id": "cyc-know",
        },
    )


def _mint(tools: Path, *, evidence_refs: list[str], repo_root: Path | None = None) -> dict:
    return ai.create_agent_invocation_request(
        target_agent="aria-primary-planner",
        role="primary_plan",
        suggested_prompt="harden the feed write path",
        must_satisfy=[{"id": "K1", "criterion": "root cause fixed"}],
        allowed_scope=["apps/farm-service/**"],
        evidence_refs=evidence_refs,
        convergence_id="conv-know",
        base_dir=tools,
        context_repo_root=repo_root,
    )


class ConventionsForPathsTest(unittest.TestCase):
    def test_only_related_confident_conventions_surface(self) -> None:
        from aria_kernel.knowledge_graph import conventions_for_paths

        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            _record_convention(
                workspace, pattern_id="conv-related", confidence=0.9,
                ref="apps/farm-service/src/feed.service.ts:12",
            )
            _record_convention(
                workspace, pattern_id="conv-unrelated", confidence=0.9,
                ref="web/shell/src/App.tsx:5",
            )
            _record_convention(
                workspace, pattern_id="conv-weak", confidence=0.2,
                ref="apps/farm-service/src/feed.service.ts:40",
            )

            rows = conventions_for_paths(
                workspace_root=workspace,
                paths=["apps/farm-service/src/feed.service.ts"],
            )

        self.assertEqual([r["pattern_id"] for r in rows], ["conv-related"])

    def test_a_scope_prefix_is_a_path_claim_at_directory_boundaries(self) -> None:
        # apps/farm-service must match, apps/farm-service-v2 must not — the
        # near-miss the boundary check exists for.
        from aria_kernel.knowledge_graph import _paths_related

        self.assertTrue(_paths_related("apps/farm-service/src/x.ts", "apps/farm-service"))
        self.assertFalse(_paths_related("apps/farm-service-v2/src/x.ts", "apps/farm-service"))


class EstablishedKnowledgeAtMintTest(unittest.TestCase):
    def test_explicit_tools_root_excludes_checkout_shadow_knowledge(self) -> None:
        from aria_kernel import knowledge_graph as kg
        from aria_kernel.tool_registry import append_tools_governance

        with TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "checkout"
            tools = ensure_tools_dir(Path(tmp) / "store/tools")
            legacy = ensure_tools_dir(workspace / "aria-tools")
            shadow_paths = []
            for root, prefix, roots in (
                (tools, "canonical", {"base_dir": tools}),
                (legacy, "shadow", {"workspace_root": workspace}),
            ):
                pattern = kg.Pattern(
                    pattern_id=f"{prefix}-convention", pattern_type="convention", confidence=0.9,
                    evidence_refs=("apps/farm-service/src/feed.service.ts:12",),
                    discovered_by_cycle_id="root-selection", observed_at="2026-09-10T00:00:00Z",
                    outcome_status="verified",
                )
                convention_path = kg.record_convention(pattern, signer_key_fp=SIGNER, **roots)
                append_tools_governance(root, "operator_action", {"event_id": f"{prefix}-approval", "action": "approve"})
                anti_path = kg.record_anti_pattern(
                    kg.Pattern(
                        pattern_id=f"{prefix}-anti", pattern_type="anti_pattern", confidence=1.0,
                        evidence_refs=pattern.evidence_refs, discovered_by_cycle_id="root-selection",
                        observed_at=pattern.observed_at,
                    ), reason_class="architecture_class", operator_signature=f"gov:{prefix}-approval", **roots,
                )
                if prefix == "shadow":
                    shadow_paths = [convention_path, anti_path]
            before = {path: path.read_bytes() for path in shadow_paths}
            minted = _mint(tools, repo_root=workspace, evidence_refs=["apps/farm-service/src/feed.service.ts:12"])
            knowledge = minted["established_knowledge"]
            self.assertEqual([r["pattern_id"] for r in knowledge["conventions"]], ["canonical-convention"])
            self.assertEqual([r["pattern_id"] for r in knowledge["anti_patterns"]], ["canonical-anti"])
            prompt = ai.render_invocation_prompt(minted)
            self.assertIn("canonical-convention", prompt)
            self.assertIn("canonical-anti", prompt)
            self.assertNotIn("shadow-convention", prompt)
            self.assertNotIn("shadow-anti", prompt)
            self.assertEqual({path: path.read_bytes() for path in shadow_paths}, before)
            self.assertFalse((tools.parent / "aria-tools").exists())

    def test_beliefs_and_conventions_land_in_the_envelope_and_the_prompt(self) -> None:
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            tools = workspace / "aria-tools"
            ensure_tools_dir(tools)
            _record_belief(
                tools, belief_id="belief-feed-ssot",
                claim="FeedingProtocolRateService is the feed-rate SSoT",
                ref="apps/farm-service/src/feed.service.ts:30",
            )
            _record_convention(
                workspace, pattern_id="conv-feed-scoped-repo", confidence=0.85,
                ref="apps/farm-service/src/feed.service.ts:8",
            )

            row = _mint(tools, evidence_refs=["apps/farm-service/src/feed.service.ts:30"])
            prompt = ai.render_invocation_prompt(row)

        knowledge = row["established_knowledge"]
        self.assertEqual(knowledge["beliefs"][0]["belief_id"], "belief-feed-ssot")
        self.assertEqual(
            knowledge["conventions"][0]["pattern_id"], "conv-feed-scoped-repo"
        )
        # Content-pin: the binding cannot detect a mint that stops attaching
        # the section, so the rendered text itself is pinned here.
        self.assertIn("## Established knowledge", prompt)
        self.assertIn("FeedingProtocolRateService is the feed-rate SSoT", prompt)
        self.assertIn("**not evidence**", prompt)

    def test_a_withdrawn_belief_and_a_foreign_area_stay_out(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            _record_belief(
                tools, belief_id="belief-dead",
                claim="old claim", ref="apps/farm-service/src/feed.service.ts:1",
                status="withdrawn",
            )
            _record_belief(
                tools, belief_id="belief-elsewhere",
                claim="unrelated area claim", ref="web/shell/src/App.tsx:1",
            )

            row = _mint(tools, evidence_refs=["apps/farm-service/src/feed.service.ts:30"])

        knowledge = row["established_knowledge"]
        self.assertEqual(knowledge["beliefs"], [])
        self.assertEqual(knowledge["conventions"], [])
        self.assertEqual(knowledge["anti_patterns"], [])
        self.assertEqual(knowledge["past_failed_attempts"], [])
        self.assertEqual(knowledge["past_failed_attempts_state"]["status"], "missing")

    def test_an_empty_workspace_attaches_no_section(self) -> None:
        # V4 records optional history absence, not "ARIA knows nothing here".
        # The absence of positive knowledge remains explicit. Immutable v1-v3
        # section behavior is covered by complete captured prompt bytes.
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)

            row = _mint(tools, evidence_refs=["apps/farm-service/src/feed.service.ts:30"])
            prompt = ai.render_invocation_prompt(row)

        knowledge = row["established_knowledge"]
        self.assertEqual(knowledge["beliefs"], [])
        self.assertEqual(knowledge["conventions"], [])
        self.assertEqual(knowledge["anti_patterns"], [])
        self.assertEqual(knowledge["past_failed_attempts"], [])
        state = knowledge["past_failed_attempts_state"]
        self.assertEqual((state["status"], state["reason"]), ("missing", "results_absent"))
        self.assertIsNone(state["matching_count"])
        self.assertNotIn("already verified about this area", prompt)


class RejectedHistoryAtMintTest(unittest.TestCase):
    def test_native_rejected_submission_reaches_later_related_minted_prompt(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.declared_fixtures import sha256_file
        from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = make_repo_with_initial_commit(root, {"src/feed.py": "rate = 1\n"})
            tools = ensure_tools_binding(root / "store/tools", workspace_root=repo)
            target_sha = _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()

            def mint(cycle: str) -> dict:
                return ai.create_agent_invocation_request(
                    target_agent="aria-evidence-judge", role="evidence_judgment",
                    suggested_prompt="Check the feed rate using repository evidence.",
                    must_satisfy=[{"id": "feed-evidence", "criterion": "cite the feed rate source"}],
                    allowed_scope=["src/**"], evidence_refs=["src/feed.py:1"],
                    convergence_id=cycle, cycle_id=cycle, target_sha=target_sha,
                    context_repo_root=repo, base_dir=tools,
                )

            original = mint("history-first")
            claim = ai.claim_request(
                request_id=original["request_id"], agent_id="judge-worker-history", base_dir=tools,
            )
            response = {
                "$schema": "aria/agent-response/v1", "request_id": original["request_id"],
                "claim_id": claim["claim_id"], "agent_id": claim["agent_id"],
                "role": "evidence_judgment", "status": "submitted",
                "declared_route": "Inspect the feed rate source and cite its defining line.",
                "satisfaction_matrix": [{"id": "feed-evidence", "verdict": "satisfied",
                                         "evidence_refs": ["src/missing.py:1"]}],
                "evidence_refs": ["src/missing.py:1"],
                "details": {"verdict": "true_positive", "confidence": 0.8},
            }
            output = Path(original["expected_output_path"])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(response), encoding="utf-8")
            transcript = output.with_suffix(".transcript.txt")
            transcript.write_text("Ordinary first attempt: cited a source file that is absent.\n", encoding="utf-8")
            submitted = ai.submit_claim_result(
                claim_id=claim["claim_id"], agent_id=claim["agent_id"], lease_token=claim["lease_token"],
                output_path=output, workspace_root=repo, base_dir=tools,
                context_hash=original["context_hash"], prompt_hash=original["prompt_hash"],
                transcript_hash=sha256_file(transcript), transcript_artifact_ref=transcript.as_posix(),
            )
            self.assertEqual(submitted["status"], "rejected")
            self.assertTrue(submitted["reasons"])
            self.assertTrue(any("agent_evidence_path_missing" in reason for reason in submitted["reasons"]))
            self.assertTrue(all(reason.startswith("evidence: ") and "src/missing.py" in reason
                                and ("agent_evidence_path_missing" in reason
                                     or "evidence_ref_not_repo_verified:src/missing.py:missing" in reason)
                                for reason in submitted["reasons"]), submitted["reasons"])
            results_path = tools / "agent-invocations/results.jsonl"
            rows = load_declared_jsonl(results_path, expected_surface="agent_invocation_results")
            self.assertEqual(len(rows), 1)
            result = rows[0]
            self.assertEqual(result, submitted["row"])
            self.assertEqual(result["request_id"], original["request_id"])
            self.assertEqual(result["claim_id"], claim["claim_id"])
            self.assertEqual(result["agent_id"], claim["agent_id"])
            self.assertNotEqual(result["agent_id"], original["target_agent"])
            self.assertEqual(result["rejection_reasons"], submitted["reasons"])
            before = results_path.read_bytes()

            later = mint("history-later")
            self.assertNotEqual(later["request_id"], original["request_id"])
            self.assertEqual(results_path.read_bytes(), before)
            for name in ("conventions.jsonl", "anti-patterns.jsonl"):
                self.assertFalse((repo / "aria-tools/knowledge-graph" / name).exists())
                self.assertFalse((tools / "knowledge-graph" / name).exists())
            history = later.get("established_knowledge", {}).get("past_failed_attempts", [])
            self.assertEqual(len(history), 1, "Native rejection must survive a history-only related mint")
            self.assertEqual(history[0]["result_row_id"], result["row_id"])
            self.assertEqual(history[0]["result_ledger_hash"], result["ledger_hash"])
            self.assertEqual(history[0]["request_id"], original["request_id"])
            self.assertEqual(history[0]["claim_id"], claim["claim_id"])
            self.assertEqual(history[0]["rejection_reasons"][0], result["rejection_reasons"][0])
            prompt = ai.render_invocation_prompt(later)
            self.assertIn(result["row_id"], prompt)
            self.assertIn("agent_evidence_path_missing", prompt)
            self.assertEqual(prompt, ai.render_invocation_prompt(ai.fuse_prompt_envelope(later)))


class _NativeHistoryFixture:
    """Normal request/claim/submission owners; no hand-written ledger rows."""

    def __init__(self, root: Path) -> None:
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit

        self.repo = make_repo_with_initial_commit(root, {
            "src/feed.py": "rate = 1\n", "src-v2/feed.py": "rate = 2\n",
            "other/a.py": "a = 1\n", "other/b.py": "b = 1\n", "other/c.py": "c = 1\n",
        })
        self.tools = ensure_tools_binding(root / "store/tools", workspace_root=self.repo)
        self.target_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.submissions: dict[str, dict] = {}

    def mint(self, cycle: str, *, refs: list[str] | None = None,
             scope: list[str] | None = None, tools: Path | None = None) -> dict:
        return ai.create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="Check the feed rate using repository evidence.",
            must_satisfy=[{"id": "feed-evidence", "criterion": "cite the feed rate source"}],
            allowed_scope=["src/**"] if scope is None else scope,
            evidence_refs=["src/feed.py:1"] if refs is None else refs,
            convergence_id=cycle, cycle_id=cycle, target_sha=self.target_sha,
            context_repo_root=self.repo, base_dir=tools or self.tools,
        )

    def reject(self, request: dict, *, tools: Path | None = None) -> tuple[dict, dict]:
        return self._submit(request, evidence_ref="src/missing.py:1", tools=tools)

    def accept(self, request: dict) -> tuple[dict, dict]:
        return self._submit(request, evidence_ref="src/feed.py:1")

    def _submit(self, request: dict, *, evidence_ref: str, tools: Path | None = None) -> tuple[dict, dict]:
        from tests._helpers.declared_fixtures import sha256_file

        root = tools or self.tools
        claim = ai.claim_request(request_id=request["request_id"], agent_id="judge-history-worker", base_dir=root)
        envelope = {
            "$schema": "aria/agent-response/v1", "request_id": request["request_id"],
            "claim_id": claim["claim_id"], "agent_id": claim["agent_id"],
            "role": "evidence_judgment", "status": "submitted",
            "declared_route": "Inspect the feed rate source and cite its defining line.",
            "satisfaction_matrix": [{"id": "feed-evidence", "verdict": "satisfied",
                                     "evidence_refs": [evidence_ref]}],
            "evidence_refs": [evidence_ref],
            "details": {"verdict": "true_positive", "confidence": 0.8},
        }
        output = Path(request["expected_output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(envelope), encoding="utf-8")
        transcript = output.with_suffix(".transcript.txt")
        transcript.write_text("Ordinary first response submitted for native validation.\n", encoding="utf-8")
        kwargs = dict(
            claim_id=claim["claim_id"], agent_id=claim["agent_id"], lease_token=claim["lease_token"],
            output_path=output, workspace_root=self.repo, base_dir=root,
            context_hash=request["context_hash"], prompt_hash=request["prompt_hash"],
            transcript_hash=sha256_file(transcript), transcript_artifact_ref=transcript.as_posix(),
        )
        result = ai.submit_claim_result(**kwargs)
        if evidence_ref == "src/missing.py:1":
            assert result["status"] == "rejected", result
            assert result["reasons"] and all(reason.startswith("evidence: ") and "src/missing.py" in reason
                                             for reason in result["reasons"]), result["reasons"]
        else:
            assert result["status"] == "accepted", result
            assert result["reasons"] == [], result
        self.submissions[claim["claim_id"]] = kwargs
        return claim, result["row"]


class RejectedHistoryContractsTest(unittest.TestCase):
    def setUp(self) -> None:
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.fixture = _NativeHistoryFixture(Path(scratch.name))

    def test_accepted_native_result_reports_available_without_rejections(self) -> None:
        f = self.fixture
        _, accepted = f.accept(f.mint("accepted-source"))
        knowledge = f.mint("accepted-consumer")["established_knowledge"]
        self.assertEqual(knowledge["past_failed_attempts"], [])
        state = knowledge["past_failed_attempts_state"]
        self.assertEqual((state["status"], state["reason"], state["matching_count"]),
                         ("available", "no_rejections", 0))
        self.assertEqual(state["source_snapshot"]["agent_invocation_results"]["tail_ledger_hash"],
                         accepted["ledger_hash"])

    def test_long_canonical_request_paths_are_omitted_after_full_matching(self) -> None:
        from tests._helpers.git_fixtures import _git

        f = self.fixture
        relative = "/".join(["long", "a" * 180, "b" * 180, "c" * 180, "feed.py"])
        path = f.repo / relative
        path.parent.mkdir(parents=True)
        path.write_text("rate = 3\n", encoding="utf-8")
        _git(["add", relative], cwd=f.repo)
        _git(["commit", "-q", "-m", "fixture: long ordinary source path"], cwd=f.repo)
        f.target_sha = _git(["rev-parse", "HEAD"], cwd=f.repo).stdout.strip()
        scope = ["src/**", relative.rsplit("/", 1)[0] + "/**"]
        request = f.mint("long-path-source", refs=[relative + ":1"], scope=scope)
        _, result = f.reject(request)
        later = f.mint("long-path-consumer", refs=[relative + ":1"], scope=["**"])
        episode = later["established_knowledge"]["past_failed_attempts"][0]
        self.assertEqual(episode["result_row_id"], result["row_id"])
        self.assertEqual(episode["request_id"], request["request_id"])
        self.assertEqual(episode["request_evidence_refs"], [])
        self.assertEqual(episode["request_allowed_scope"], ["src/**"])
        for field, length in (("request_evidence_refs", len(relative + ":1")),
                              ("request_allowed_scope", len(scope[1]))):
            omission = episode["display_omissions"][field]
            self.assertEqual(omission["omitted_count"], 1)
            self.assertEqual(omission["omitted_items"][0]["reason"], "display_length_exceeded")
            self.assertEqual(omission["omitted_items"][0]["original_characters"], length)

    def test_native_reason_prefixes_and_explicit_omissions(self) -> None:
        f = self.fixture
        request = f.mint("prefix-source")
        _, result = f.reject(request)
        native = result["rejection_reasons"]
        before = (f.tools / "agent-invocations/results.jsonl").read_bytes()
        later = f.mint("prefix-consumer")
        episode = later["established_knowledge"]["past_failed_attempts"][0]
        expected = [reason if len(reason) <= 120 else reason[:120] + "… [truncated]" for reason in native[:3]]
        self.assertEqual(episode["rejection_reasons"], expected)
        omissions = episode["display_omissions"]["rejection_reasons"]
        self.assertEqual(omissions["original_count"], len(native))
        self.assertEqual(omissions["omitted_count"], len(native) - 3)
        self.assertEqual(omissions["truncated_items"], [
            {"index": i, "original_characters": len(reason), "retained_characters": 120}
            for i, reason in enumerate(native[:3]) if len(reason) > 120
        ])
        self.assertTrue(omissions["truncated_items"])
        self.assertEqual((f.tools / "agent-invocations/results.jsonl").read_bytes(), before)
        prompt = ai.render_invocation_prompt(later)
        self.assertIn("… [truncated]", prompt)
        self.assertIn('"omitted_count": 1', prompt)

    def test_full_request_refs_match_before_display_cap_and_use_original_claim(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        f = self.fixture
        request = f.mint("full-refs", scope=["**"],
                         refs=["other/a.py:1", "other/b.py:1", "other/c.py:1", "src/feed.py:1"])
        claim, result = f.reject(request)
        later = f.mint("full-refs-consumer")
        knowledge = later["established_knowledge"]
        episode = knowledge["past_failed_attempts"][0]
        self.assertEqual(episode["request_evidence_refs"], request["evidence_refs"][:3])
        self.assertEqual(episode["display_omissions"]["request_evidence_refs"]["omitted_count"], 1)
        self.assertEqual(episode["result_ledger_hash"], result["ledger_hash"])
        self.assertEqual(episode["request_ledger_hash"], request["ledger_hash"])
        claims = load_declared_jsonl(f.tools / "agent-invocations/claims.jsonl",
                                     expected_surface="agent_invocation_claims")
        original = next(row for row in claims if row.get("event") == "claimed" and row["claim_id"] == claim["claim_id"])
        self.assertEqual(episode["claim_ledger_hash"], original["ledger_hash"])
        self.assertEqual(episode["agent_id"], claim["agent_id"])
        self.assertEqual(episode["target_agent"], request["target_agent"])
        self.assertNotEqual(episode["agent_id"], episode["target_agent"])
        snapshot = knowledge["past_failed_attempts_state"]["source_snapshot"]
        self.assertEqual(snapshot["agent_invocation_results"]["tail_ledger_hash"], result["ledger_hash"])
        self.assertEqual(snapshot["agent_invocation_results"]["row_count"], 1)
        self.assertEqual(snapshot["agent_invocation_requests"]["tail_ledger_hash"], request["ledger_hash"])
        for private in ("lease_token", "lease_token_hash", "transcript_artifact_ref"):
            self.assertNotIn(private, json.dumps(episode))

    def test_unrelated_directory_is_excluded_with_complete_search_status(self) -> None:
        f = self.fixture
        f.reject(f.mint("related-source"))
        later = f.mint("unrelated-consumer", refs=["src-v2/feed.py:1"], scope=["src-v2/**"])
        knowledge = later["established_knowledge"]
        self.assertEqual(knowledge["past_failed_attempts"], [])
        state = knowledge["past_failed_attempts_state"]
        self.assertEqual((state["status"], state["reason"], state["matching_count"]),
                         ("available", "no_related_attempts", 0))
        self.assertFalse(state["truncated"])

    def test_missing_history_and_read_error_are_distinct_and_belief_survives(self) -> None:
        from aria_kernel.ledger import StateTransaction

        f = self.fixture
        missing = f.mint("missing-history")["established_knowledge"]["past_failed_attempts_state"]
        self.assertEqual((missing["status"], missing["reason"]), ("missing", "results_absent"))
        self.assertIsNone(missing["matching_count"])
        f.reject(f.mint("io-source"))
        _record_belief(f.tools, belief_id="healthy-belief", claim="The feed rate has a source.", ref="src/feed.py:1")
        original = StateTransaction.load_declared_jsonl
        failed = []

        def read(transaction, path, *, expected_surface, **kwargs):
            if expected_surface == "agent_invocation_results" and not failed:
                failed.append(path)
                raise OSError("ordinary-history-read-sentinel")
            return original(transaction, path, expected_surface=expected_surface, **kwargs)

        with patch.object(StateTransaction, "load_declared_jsonl", read):
            later = f.mint("io-consumer")
        self.assertEqual(len(failed), 1)
        knowledge = later["established_knowledge"]
        self.assertEqual(knowledge["beliefs"][0]["belief_id"], "healthy-belief")
        self.assertEqual(knowledge["past_failed_attempts"], [])
        state = knowledge["past_failed_attempts_state"]
        self.assertEqual((state["status"], state["reason"]), ("unavailable", "read_error"))
        self.assertIsNone(state["matching_count"])
        self.assertIsNone(state["truncated"])
        self.assertEqual(state["source_snapshot"], {})
        self.assertNotIn("ordinary-history-read-sentinel", ai.render_invocation_prompt(later))

    def test_history_survives_independent_belief_and_kg_read_errors(self) -> None:
        f = self.fixture
        _, result = f.reject(f.mint("independent-source"))
        with patch("aria_kernel.memory.latest_beliefs", side_effect=OSError("belief unavailable")), \
             patch("aria_kernel.knowledge_graph.conventions_for_paths", side_effect=OSError("conventions unavailable")), \
             patch("aria_kernel.knowledge_graph.anti_patterns_for_paths", side_effect=OSError("anti patterns unavailable")):
            later = f.mint("independent-consumer")
        knowledge = later["established_knowledge"]
        self.assertEqual(knowledge["past_failed_attempts"][0]["result_row_id"], result["row_id"])
        self.assertEqual(knowledge["beliefs"], [])
        self.assertEqual(knowledge["conventions"], [])
        self.assertEqual(knowledge["anti_patterns"], [])

    def test_kg_owner_wrapped_read_error_preserves_history_without_changing_ledger(self) -> None:
        from aria_kernel import knowledge_graph as kg, ledger

        f = self.fixture
        _, result = f.reject(f.mint("wrapped-io-source"))
        path = kg.record_convention(kg.Pattern(
            pattern_id="ordinary-observation", pattern_type="convention", confidence=0.5,
            evidence_refs=("src/feed.py:1",), discovered_by_cycle_id="ordinary-fixture",
            observed_at="2026-09-10T00:00:00Z", outcome_status="hypothesis",
        ), base_dir=f.tools, signer_key_fp=SIGNER)
        before = path.read_bytes()
        original = ledger.read_jsonl
        reads = []

        def read(target, *args, **kwargs):
            if Path(target) == path:
                reads.append(target)
                if len(reads) == 2:
                    raise OSError("ordinary-post-verification-read")
            return original(target, *args, **kwargs)

        with patch.object(ledger, "read_jsonl", read):
            later = f.mint("wrapped-io-consumer")
        self.assertEqual(len(reads), 2)
        self.assertEqual(later["established_knowledge"]["past_failed_attempts"][0]["result_row_id"], result["row_id"])
        self.assertEqual(later["established_knowledge"]["conventions"], [])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(path.parent.glob("*.quarantined.*")), [])

    def test_history_lock_timeout_is_visible_at_real_mint(self) -> None:
        f = self.fixture
        f.reject(f.mint("timeout-source"))
        original = ai.state_transaction
        calls = []

        def transaction(paths, **kwargs):
            if {Path(path).name for path in paths} == {"requests.jsonl", "claims.jsonl", "results.jsonl"}:
                calls.append(paths)
                raise TimeoutError("ordinary-lock-timeout-sentinel")
            return original(paths, **kwargs)

        with patch.object(ai, "state_transaction", transaction):
            later = f.mint("timeout-consumer")
        self.assertEqual(len(calls), 1)
        state = later["established_knowledge"]["past_failed_attempts_state"]
        self.assertEqual((state["status"], state["reason"]), ("unavailable", "lock_timeout"))
        self.assertIsNone(state["matching_count"])
        self.assertNotIn("ordinary-lock-timeout-sentinel", ai.render_invocation_prompt(later))

    def test_later_native_result_leaves_sealed_prompt_and_claim_bytes_unchanged(self) -> None:
        f = self.fixture
        f.reject(f.mint("replay-first-source"))
        sealed = f.mint("sealed-consumer")
        before = ai.render_invocation_prompt(sealed).encode("utf-8")
        _, newest = f.reject(f.mint("replay-second-source"))
        returned = f.mint("sealed-consumer")
        self.assertEqual(returned, sealed)
        self.assertEqual(ai.render_invocation_prompt(returned).encode("utf-8"), before)
        claim = ai.claim_request(request_id=sealed["request_id"], agent_id="sealed-history-worker", base_dir=f.tools)
        self.assertEqual(ai.render_invocation_prompt(claim).encode("utf-8"), before)
        self.assertEqual(ai._sha256_text(before.decode("utf-8")), sealed["prompt_hash"])
        fresh = f.mint("fresh-consumer")
        self.assertEqual(fresh["established_knowledge"]["past_failed_attempts"][0]["result_row_id"], newest["row_id"])
        self.assertNotEqual(ai.render_invocation_prompt(fresh).encode("utf-8"), before)

    def test_exact_native_submission_replay_serves_one_episode(self) -> None:
        f = self.fixture
        claim, result = f.reject(f.mint("idempotent-source"))
        path = f.tools / "agent-invocations/results.jsonl"
        before = path.read_bytes()
        replay = ai.submit_claim_result(**f.submissions[claim["claim_id"]])
        self.assertTrue(replay["idempotent"])
        self.assertEqual(path.read_bytes(), before)
        knowledge = f.mint("idempotent-consumer")["established_knowledge"]
        self.assertEqual([item["result_row_id"] for item in knowledge["past_failed_attempts"]], [result["row_id"]])
        self.assertEqual(knowledge["past_failed_attempts_state"]["matching_count"], 1)

    def test_five_episode_cap_reports_complete_count_in_append_order(self) -> None:
        f = self.fixture
        result_ids = []
        for number in range(6):
            _, result = f.reject(f.mint(f"count-source-{number}"))
            result_ids.append(result["row_id"])
        knowledge = f.mint("count-consumer")["established_knowledge"]
        self.assertEqual([item["result_row_id"] for item in knowledge["past_failed_attempts"]], list(reversed(result_ids))[:5])
        state = knowledge["past_failed_attempts_state"]
        self.assertEqual((state["matching_count"], state["returned_count"], state["truncated"]), (6, 5, True))
        self.assertEqual(state["source_snapshot"]["agent_invocation_results"]["row_count"], 6)

    def test_no_path_query_does_not_search_global_history(self) -> None:
        f = self.fixture
        f.reject(f.mint("no-query-source"))
        with patch.object(ai, "_past_failed_attempts_for_paths", wraps=ai._past_failed_attempts_for_paths) as read:
            request = f.mint("no-query-consumer", refs=[], scope=["**"])
        read.assert_not_called()
        self.assertNotIn("established_knowledge", request)

    def test_explicit_canonical_root_excludes_legitimate_shadow_history(self) -> None:
        from aria_kernel.tool_registry import ensure_tools_binding

        f = self.fixture
        _, canonical = f.reject(f.mint("canonical-source"))
        shadow = ensure_tools_binding(f.repo / "aria-tools", workspace_root=f.repo)
        _, foreign = f.reject(f.mint("shadow-source", tools=shadow), tools=shadow)
        shadow_path = shadow / "agent-invocations/results.jsonl"
        before = shadow_path.read_bytes()
        later = f.mint("canonical-consumer")
        self.assertEqual([row["result_row_id"] for row in later["established_knowledge"]["past_failed_attempts"]],
                         [canonical["row_id"]])
        self.assertNotIn(foreign["row_id"], ai.render_invocation_prompt(later))
        self.assertEqual(shadow_path.read_bytes(), before)


class RecentIntentAtMintTest(unittest.TestCase):
    def _git_repo_with_history(self, workspace: Path) -> None:
        def git(*args: str) -> None:
            subprocess.run(
                ["git", "-C", str(workspace), *args],
                check=True, capture_output=True, text=True,
            )

        subprocess.run(
            ["git", "init", "-q", str(workspace)],
            check=True, capture_output=True, text=True,
        )
        git("config", "user.email", "test@test")
        git("config", "user.name", "test")
        target = workspace / "apps" / "farm-service" / "src" / "feed.service.ts"
        target.parent.mkdir(parents=True)
        target.write_text("export class FeedService {}\n", encoding="utf-8")
        git("add", "apps/farm-service/src/feed.service.ts")
        git(
            "commit", "-q", "-m",
            "fix(farm): route feed rate through the protocol SSoT (ADR-011)\n\n"
            "Hand-copied rates drifted from the protocol table; deriving from\n"
            "the SSoT makes the drift impossible.\n\n"
            "Closes: docs/reviews/farm/2026-08-01-feed.md#FARM-HIGH-083",
        )

    def test_commit_intent_lands_in_the_envelope_and_the_prompt(self) -> None:
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            self._git_repo_with_history(workspace)
            tools = workspace / "aria-tools"
            ensure_tools_dir(tools)

            row = _mint(
                tools,
                evidence_refs=["apps/farm-service/src/feed.service.ts:1"],
                repo_root=workspace,
            )
            prompt = ai.render_invocation_prompt(row)

        intent = row["recent_intent"]
        self.assertEqual(intent["files"][0]["file"], "apps/farm-service/src/feed.service.ts")
        commit = intent["files"][0]["commits"][0]
        self.assertIn("protocol SSoT", commit["subject"])
        self.assertIn("drifted", commit["why"])
        self.assertIn("ADR-011", commit["refs"])
        # The Closes: doc path wins over the bare finding id — one ref, both
        # the document and the finding it closes.
        self.assertTrue(any("FARM-HIGH-083" in ref for ref in commit["refs"]))
        self.assertIn("## Recent intent", prompt)
        self.assertIn("why: Hand-copied rates drifted", prompt)

    def test_no_repo_root_means_no_intent_and_no_failure(self) -> None:
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)

            row = _mint(tools, evidence_refs=["apps/farm-service/src/feed.service.ts:1"])

        self.assertNotIn("recent_intent", row)


class BindingCarriesTheKnowledgeTest(unittest.TestCase):
    def _enriched_row(self, tmp: str) -> dict:
        workspace = Path(tmp)
        tools = workspace / "aria-tools"
        ensure_tools_dir(tools)
        _record_belief(
            tools, belief_id="belief-b1", claim="scoped repos only",
            ref="apps/farm-service/src/feed.service.ts:2",
        )
        return _mint(tools, evidence_refs=["apps/farm-service/src/feed.service.ts:2"])

    def test_the_fused_projection_reproduces_the_minted_hash(self) -> None:
        with TemporaryDirectory() as tmp:
            row = self._enriched_row(tmp)

            fused = ai.fuse_prompt_envelope(row)

            self.assertIn("established_knowledge", fused)
            self.assertEqual(
                ai._sha256_text(ai.render_invocation_prompt(fused)),
                row["prompt_hash"],
            )

    def test_dropping_the_knowledge_breaks_the_binding(self) -> None:
        # The deliberate break: a claim path that lost the section cannot
        # reproduce the hash — the fusion set addition is load-bearing.
        with TemporaryDirectory() as tmp:
            row = self._enriched_row(tmp)

            fused = ai.fuse_prompt_envelope(row)
            fused.pop("established_knowledge")

            self.assertNotEqual(
                ai._sha256_text(ai.render_invocation_prompt(fused)),
                row["prompt_hash"],
            )


class RankPressureSourcesIsWiredTest(unittest.TestCase):
    _ROW = {
        "source_type": "failing_ci",
        "cycles_minted": 4,
        "cycles_converged": 2,
        "cycles_merged": 1,
        "cycles_rejected": 1,
        "avg_cost_usd": 0.5,
    }

    def test_the_calibration_phase_attaches_the_ranking(self) -> None:
        from aria_kernel import cycle as cycle_mod

        with TemporaryDirectory() as tmp:
            ctx = cycle_mod.build_phase_context(
                cycle_id="cyc-rank",
                workspace_root=Path(tmp),
                base_dir=Path(tmp) / "aria-tools",
            )
            with patch.object(cycle_mod, "recommend_calibration", return_value={}), \
                 patch(
                     "aria_kernel.knowledge_graph.rank_pressure_sources",
                     return_value=[self._ROW],
                 ) as rank:
                result = cycle_mod._phase_calibration_recommendation(ctx)

            # The ledger is a tools-root surface: the phase names the tools
            # root it already holds, not a workspace to derive one from
            # (B4, 2026-09-12 — on the lane the two are different trees).
            rank.assert_called_once_with(base_dir=ctx.base_dir)
        self.assertEqual(result["source_effectiveness"], [self._ROW])

    def _context(self, tmp: str):
        from aria_kernel import cycle as cycle_mod
        from aria_kernel.tool_registry import ensure_tools_dir

        tools = ensure_tools_dir(Path(tmp) / "aria-tools")
        return cycle_mod.build_phase_context(
            cycle_id="cyc-guard", workspace_root=Path(tmp), base_dir=tools,
        )

    @staticmethod
    def _unreadable_rows(tools: Path) -> list[dict]:
        from aria_kernel.ledger import load_jsonl

        path = tools / "governance.jsonl"
        rows = load_jsonl(path) if path.exists() else []
        return [row for row in rows if row.get("kind") == "pressure_source_effectiveness_unreadable"]

    def test_a_ledger_fault_is_disclosed_and_the_recommendation_survives(self) -> None:
        """B1 (2026-09-12) — the guard was (OSError, ValueError, KeyError,
        TypeError): programming errors were swallowed into an empty ranking
        while a tampered ledger (KnowledgeGraphTamper) crashed the phase.
        A fault of the ledger is a governance row and an empty ranking."""
        from aria_kernel import cycle as cycle_mod
        from aria_kernel.knowledge_graph import KnowledgeGraphTamper

        with TemporaryDirectory() as tmp:
            ctx = self._context(tmp)
            with patch.object(cycle_mod, "recommend_calibration", return_value={}), \
                 patch("aria_kernel.knowledge_graph.rank_pressure_sources",
                       side_effect=KnowledgeGraphTamper("chain mismatch mid-read")):
                result = cycle_mod._phase_calibration_recommendation(ctx)
            rows = self._unreadable_rows(Path(ctx.base_dir))
        self.assertEqual(result["source_effectiveness"], [])
        self.assertEqual(
            [(row["details"]["reader"], row["details"]["error_class"], row["details"]["cycle_id"]) for row in rows],
            [("calibration_recommendation", "KnowledgeGraphTamper", "cyc-guard")],
        )

    def test_a_tampered_ledger_on_disk_is_quarantined_not_a_crash(self) -> None:
        from aria_kernel import cycle as cycle_mod

        with TemporaryDirectory() as tmp:
            ctx = self._context(tmp)
            ledger = Path(ctx.base_dir) / "knowledge-graph" / "pressure-source-effectiveness.jsonl"
            ledger.parent.mkdir(parents=True, exist_ok=True)
            ledger.write_text("{not json\n", encoding="utf-8")
            with patch.object(cycle_mod, "recommend_calibration", return_value={}):
                result = cycle_mod._phase_calibration_recommendation(ctx)
            quarantined = list(ledger.parent.glob("pressure-source-effectiveness.jsonl.quarantined.*"))
            self.assertFalse(ledger.exists())
        self.assertEqual(result["source_effectiveness"], [])
        self.assertEqual(len(quarantined), 1)

    def test_a_programming_error_in_the_reader_propagates(self) -> None:
        from aria_kernel import cycle as cycle_mod

        with TemporaryDirectory() as tmp:
            ctx = self._context(tmp)
            with patch.object(cycle_mod, "recommend_calibration", return_value={}), \
                 patch("aria_kernel.knowledge_graph.rank_pressure_sources",
                       side_effect=TypeError("unexpected keyword argument")):
                with self.assertRaises(TypeError):
                    cycle_mod._phase_calibration_recommendation(ctx)
            self.assertEqual(self._unreadable_rows(Path(ctx.base_dir)), [])

    def test_the_report_renders_the_ranking(self) -> None:
        from aria_kernel.reflection import _render_calibration_recommendation_section

        lines = "\n".join(
            _render_calibration_recommendation_section(
                {"calibration_recommendation": {"source_effectiveness": [self._ROW]}}
            )
        )

        self.assertIn("Pressure-source effectiveness", lines)
        self.assertIn("failing_ci: 50%", lines)


if __name__ == "__main__":
    unittest.main()
