"""A tools store bound to a git workspace, with the production writers of an expiry (ARIA-HIGH-360).

The judge fan-out mints the requests, ``record_raw_findings_for_run``
reports the finding, ``_record_anchor_stale`` expires a request, and the lease
sweep disposes. Shared by ``test_anchor_stale_disposition`` and
``test_anchor_stale_migration``.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_invocations import _record_anchor_stale, list_agent_invocation_requests
from aria_kernel.anchor_stale import ANCHOR_STALE_KIND
from aria_kernel.feedback_store import finding_fingerprint, record_raw_findings_for_run
from aria_kernel.human_required import record_human_required, sweep_lease_lifecycle_for_human_required
from aria_kernel.judge_fanout import dispatch_judges_for_sample
from aria_kernel.ledger import append_segment_rows
from aria_kernel.tool_registry import ensure_tools_dir
from unittest.mock import patch

from .git_fixtures import make_local_git_repo
from .rule_contracts import register_contracted_tool

EVIDENCE_JUDGE = "aria-evidence-judge"


def finding(i: int, *, rule: str = "rule-a") -> dict:
    return {"id": f"F{i}", "rule": rule, "severity": "medium", "path": f"src/f{i}.py:1",
            "message": "suspicious", "evidence": [f"src/f{i}.py:1"]}


def item(i: int) -> dict:
    return {
        "tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "finding_id": f"F{i}",
        "rule": "rule-a", "severity": "medium", "path": f"src/f{i}.py:1",
        "message": "suspicious", "evidence": [f"src/f{i}.py:1"],
        "finding_fingerprint": finding_fingerprint("tool-x", finding(i)),
    }


class AnchorStaleStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-360-")
        self.repo = make_local_git_repo(Path(self._tmp.name))
        # The store sits in the workspace it is bound to, as `aria-tools` does
        # in production, so the sweep reads the workspace HEAD.
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(self.tools, "tool-x")
        self.first_sha = self.head()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def head(self) -> str:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, text=True, capture_output=True, check=True,
        ).stdout.strip()

    def commit(self) -> str:
        subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "fixture: move HEAD"],
                       cwd=self.repo, check=True, capture_output=True)
        return self.head()

    def requests(self) -> list[dict]:
        return list_agent_invocation_requests(base_dir=self.tools)

    def row(self, request_id: str) -> dict:
        return next(r for r in self.requests() if r["request_id"] == request_id)

    def report(self, i: int, *, rule: str = "rule-a") -> None:
        """A tool run reports finding ``i`` now (the sampler's raw-findings writer)."""
        record_raw_findings_for_run(
            {"tool_id": "tool-x", "run_id": f"r-report-{i}", "cycle_id": "c1", "status": "ok"},
            [finding(i, rule=rule)], base_dir=self.tools,
        )

    def mint_judges(self, i: int, *, reported: bool = True) -> dict[str, str]:
        """The fan-out's two envelopes for finding ``i``, by target agent."""
        if reported:
            self.report(i)
        result = dispatch_judges_for_sample(
            sample={"cycle_id": "c1", "items": [item(i)]}, base_dir=self.tools, target_sha=self.first_sha,
        )
        return {m["target_agent"]: m["request_id"] for m in result["minted"]}

    def expire(self, request_id: str, reason: str = "anchor_expired") -> None:
        """The selection boundary's terminal event (production writer)."""
        _record_anchor_stale(self.tools, self.row(request_id), reason, now=datetime.now(timezone.utc))

    def seed_row(self, request_id: str, *, role: str, target_agent: str, prompt: str = "expired work",
                 expire: bool = True, **fields: Any) -> None:
        row = {
            "$schema": "aria/agent-invocation-request/v1", "schema_version": 1,
            "request_id": request_id, "role": role, "target_agent": target_agent,
            "suggested_prompt": prompt,
            "must_satisfy": [{"id": "S1", "description": "satisfy S1"}],
            "evidence_refs": [], "allowed_scope": ["aria-kernel/**"],
            "expected_output_path": str(self.tools / f"out-{request_id}.json"),
            "state": "pending", "created_at": datetime.now(timezone.utc).isoformat(), **fields,
        }
        # The request ledger is segmented once the fan-out has minted; the
        # segment writer appends where a producer would.
        append_segment_rows(self.tools, [row], expected_surface="agent_invocation_requests",
                            bypass_profile_gate=True)
        if expire:
            self.expire(request_id)

    def record_path(self, request_id: str) -> Path:
        return self.tools / "human-required" / f"{request_id}.json"

    def record(self, request_id: str) -> dict:
        return json.loads(self.record_path(request_id).read_text(encoding="utf-8"))

    def disposition(self, request_id: str) -> dict:
        return self.record(request_id)["kernel_disposition"]

    def successors(self, request_id: str) -> list[dict]:
        return [r for r in self.requests() if r.get("remint_of") == request_id]

    def adjudication_requests(self) -> list[dict]:
        return [r for r in self.requests() if r.get("role") == hra.ADJUDICATION_ROLE]

    def governance(self, kind: str) -> list[dict]:
        path = self.tools / "governance.jsonl"
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if row.get("kind") == kind]

    def sweep(self, **kwargs: object) -> dict:
        return sweep_lease_lifecycle_for_human_required(base_dir=self.tools, **kwargs)["anchor_stale"]

    def open_record_with_panel(self, request_id: str, kind: str = ANCHOR_STALE_KIND) -> list[str]:
        """A record and panel exactly as the pre-ARIA-HIGH-360 sweep wrote them."""
        row = self.row(request_id)
        context = {"kind": kind, "request_id": request_id, "role": row["role"], "target_agent": row["target_agent"]}
        record_human_required(
            request_id=request_id, context=context, base_dir=self.tools,
            reason=f"request {request_id!r} died ANCHOR_STALE unclaimed; panel disposition required",
        )
        with patch.object(hra, "ADJUDICABLE_CONTEXT_KINDS", hra.ADJUDICABLE_CONTEXT_KINDS | {kind}):
            panel = hra.open_adjudication(escalation_request_id=request_id, record={"context": context},
                                          base_dir=self.tools)
        return [str(r) for r in panel["request_ids"]]
