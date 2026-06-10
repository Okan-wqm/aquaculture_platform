from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import plan_convergence
from aria_kernel.agent_invocations import (
    build_repo_context_pack_v1,
    claim_request,
    mint_implementation_request_transaction,
    submit_claim_result,
)
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


HASH_1 = "sha256:" + "1" * 64
HASH_2 = "sha256:" + "2" * 64
HASH_3 = "sha256:" + "3" * 64
HASH_4 = "sha256:" + "4" * 64
HASH_5 = "sha256:" + "5" * 64


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {proc.stderr}")
    return proc.stdout.strip()


def _seed_git_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-repo-context-"))
    _git(repo, "init")
    _git(repo, "config", "user.email", "aria@example.invalid")
    _git(repo, "config", "user.name", "ARIA Test")
    (repo / "src.txt").write_text("alpha\n", encoding="utf-8")
    _git(repo, "add", "src.txt")
    _git(repo, "commit", "-m", "initial")
    return repo


def _commit_drift(repo: Path) -> str:
    with (repo / "src.txt").open("a", encoding="utf-8") as handle:
        handle.write("beta\n")
    _git(repo, "add", "src.txt")
    _git(repo, "commit", "-m", "drift")
    return _git(repo, "rev-parse", "HEAD")


def _start_and_converge(tools: Path, plan_id: str) -> None:
    plan_convergence.start_plan(
        plan_id=plan_id,
        plan_content={
            "schema_version": 1,
            "title": "repo context pack test",
            "summary": "exercise implementation request transaction",
            "affected_surfaces": ["src.txt"],
            "key_changes": [{"file": "src.txt", "description": "test"}],
            "validation_commands": [{"cmd": "python -m unittest", "expected_exit": 0}],
            "evidence_refs": ["src.txt:1"],
        },
        initial_revision_id="rev-001",
        base_dir=tools,
    )
    plan_convergence._append_event(
        root=ensure_tools_dir(tools),
        plan_id=plan_id,
        event_type="plan_evaluated",
        payload={
            "round_number": 1,
            "terminal_state": "CONVERGED",
            "risks_rollup_summary": {},
            "gate_decisions": [],
            "reason_codes": ["converged_clean"],
        },
        idempotency_key=plan_convergence._idempotency_key(
            plan_id,
            "evaluate",
            {"round_number": 1},
        ),
    )


class RepoContextPackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_git_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        set_profile("standard", operator_approval_ref="repo-context-test", base_dir=self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _mint(self, plan_id: str = "repo-context-plan") -> dict:
        _start_and_converge(self.tools, plan_id)
        return mint_implementation_request_transaction(
            plan_id=plan_id,
            implementer_agent="aria-implementer",
            suggested_prompt="implement the converged repo-context plan",
            converged_plan_revision_id="rev-001",
            converged_plan_content_hash="sha256:" + "a" * 64,
            workspace_root=self.repo,
            base_dir=self.tools,
            validation_matrix=[{"cmd": "python -m unittest aria-kernel/tests/test_repo_context_pack.py"}],
            must_satisfy=[{"id": "repo-context", "criterion": "target SHA is enforced"}],
            allowed_scope=["**"],
            evidence_refs=["src.txt:1"],
            discovery_hash=HASH_1,
            service_map_hash=HASH_2,
            belief_hash=HASH_3,
            capability_gap_hash=HASH_4,
            agent_network_hash=HASH_5,
        )

    def test_context_pack_binds_target_sha_and_claim_return(self) -> None:
        tx = self._mint()
        request = tx["invocation_request"]
        pack = request["repo_context_pack"]
        head = _git(self.repo, "rev-parse", "HEAD")

        self.assertEqual(request["target_ref"], "HEAD")
        self.assertEqual(request["target_sha"], head)
        self.assertEqual(request["base_branch"], "main")
        self.assertEqual(request["repo_context_pack_hash"], pack["semantic_hash"])
        self.assertEqual(tx["repo_context_pack_hash"], pack["semantic_hash"])

        contexts = load_declared_jsonl(
            self.tools / "agent-invocations" / "contexts.jsonl",
            expected_surface="agent_invocation_contexts",
            verify=True,
        )
        context = next(row for row in contexts if row["request_id"] == request["request_id"])
        self.assertEqual(context["target_sha"], head)
        self.assertEqual(context["repo_context_pack_hash"], pack["semantic_hash"])

        claim = claim_request(
            request_id=request["request_id"],
            agent_id="aria-implementer",
            base_dir=self.tools,
        )
        self.assertEqual(claim["target_sha"], head)
        self.assertEqual(claim["repo_context_pack_hash"], pack["semantic_hash"])

    def test_claim_rejects_after_target_sha_drift(self) -> None:
        tx = self._mint("repo-context-claim-drift")
        request = tx["invocation_request"]
        _commit_drift(self.repo)

        with self.assertRaisesRegex(GovernanceError, "claim_request_target_sha_mismatch"):
            claim_request(
                request_id=request["request_id"],
                agent_id="aria-implementer",
                base_dir=self.tools,
            )

    def test_submit_rejects_after_target_sha_drift(self) -> None:
        tx = self._mint("repo-context-submit-drift")
        request = tx["invocation_request"]
        claim = claim_request(
            request_id=request["request_id"],
            agent_id="aria-implementer",
            base_dir=self.tools,
        )
        _commit_drift(self.repo)

        with self.assertRaisesRegex(GovernanceError, "submit_claim_result_target_sha_mismatch"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="aria-implementer",
                lease_token=claim["lease_token"],
                output_path=Path(request["expected_output_path"]),
                workspace_root=self.repo,
                base_dir=self.tools,
                context_hash=str(request["context_hash"]),
                prompt_hash=str(request["prompt_hash"]),
                transcript_hash="sha256:" + "0" * 64,
                transcript_artifact_ref=str(Path(request["expected_output_path"]).with_suffix(".transcript.jsonl")),
            )

    def test_pack_builder_rejects_target_ref_not_at_head(self) -> None:
        first = _git(self.repo, "rev-parse", "HEAD")
        _commit_drift(self.repo)

        with self.assertRaisesRegex(GovernanceError, "repo_context_pack_target_sha_mismatch"):
            build_repo_context_pack_v1(
                workspace_root=self.repo,
                target_ref=first,
                validation_matrix=[{"cmd": "true"}],
                discovery_hash=HASH_1,
                service_map_hash=HASH_2,
                belief_hash=HASH_3,
                capability_gap_hash=HASH_4,
                agent_network_hash=HASH_5,
            )


if __name__ == "__main__":
    unittest.main()
