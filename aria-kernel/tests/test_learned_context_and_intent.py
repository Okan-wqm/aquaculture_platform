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

        self.assertNotIn("established_knowledge", row)

    def test_an_empty_workspace_attaches_no_section(self) -> None:
        # None, not an empty scaffold — "ARIA knows nothing here" is a claim
        # a request must not make by default.
        with TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)

            row = _mint(tools, evidence_refs=["apps/farm-service/src/feed.service.ts:30"])
            prompt = ai.render_invocation_prompt(row)

        self.assertNotIn("established_knowledge", row)
        self.assertNotIn("## Established knowledge", prompt)


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

            rank.assert_called_once_with(workspace_root=Path(tmp))
        self.assertEqual(result["source_effectiveness"], [self._ROW])

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
