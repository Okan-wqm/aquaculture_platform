"""System One at the decision points (ARIA-LOW-319) — shadow rows, unchanged decisions, the R4 flag.

The vendor is a scripted stand-in patched over ``system_one._transport``
(never the network). Each point is driven through its REAL kernel function —
the live PR opener, the merge authority, the judge fan-out, the envelope
builders — once with System One off and once on, and the two outcomes are
compared field by field.

The hardened core builds every state value from REFERENCES a public remote
holds: each fixture is a real git repo pushed to a bare origin that stands in
for the pinned public URL (``system_one.PUBLIC_REPOSITORY_URL`` patched, never
the network), with its finding-registry row committed on ``main`` — the
registry as the public remote holds it, never the working-tree file.

One property per test:

* PR open: R5 for the head commit's message against each changed file, then
  one J0 row per (claimed finding × changed code file); the PR the opener
  creates (gh argv, url, number, head) is identical.
* Merge authority: one J0 row per (Closes: trailer × changed code file); the
  merge decision and the merge call are identical.
* Judge fan-out: one J1 row per minted finding of the registered tool, none
  for another tool; the mint is identical.
* R4 off (the seed, and an enabled registry with R4 in shadow): no R4 call,
  and the implementer and planner prompts are byte-identical to origin/main
  (sha256 pinned below, captured from c1d183969).
* R4 on (order): the implementer section and the planner field carry the
  ranked candidates, capped at the registry's top_k.
* Shadow invariance, per point: the outcome is the System-One-off outcome
  whatever Jev does — answers yes, answers no, times out, refuses (HTTP 401),
  has no credential (a hosted lane), raises, or the entry point itself raises —
  and an entry point stops asking once its wall-clock budget is spent.
"""
from __future__ import annotations

import ast
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

from aria_kernel import jev_runtime
from aria_kernel import system_one
from aria_kernel import system_one_points as points
from aria_kernel.jev_runtime import JEV_CREDENTIAL_FILE_ENV, CircuitBreaker, JevReply, post_systemone
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.system_one import CALLS_RELPATH, CALLS_SURFACE
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SEED = json.loads((_REPO_ROOT / "aria-config" / "system-one-questions.json").read_text(encoding="utf-8"))
# The registry as the public remote holds it: committed, never the working-tree file.
REGISTRY_FINDINGS = "docs/reviews/_registry/findings.jsonl"

# origin/main c1d183969 — the builders' output for the fixed inputs below, before System One.
_GOLDEN_IMPLEMENTER = "6369d27c6510d0f787b32b8d5640987617e369449f911497814f872d9a39e57d"
_GOLDEN_PLANNER = {
    "primary_plan": "bb0d456ee599e824ca8738ee971ee2f8e0a3669a8468a3dd97b7b9dbc6c973ff",
    "challenger_plan": "0589672658f8ff45be890a784c96637e741ed4faa75dba4c780645ccee75f6b6",
}
_IMPLEMENTER_ARGS = dict(
    converged_plan_revision_id="rev-1",
    converged_plan_text=json.dumps({"title": "Scope the farm query to the tenant", "summary": "Use getScopedRepository"}),
    cross_review_revision_id="cr-1",
    cross_review_summary_text="looks right",
    implementation_ids={"proposal_id": "p-1", "change_id": "c-1", "branch": "aria/x", "base_sha": "a" * 40},
)
_PLANNER_STATE = {"plan_id": "plan-1", "state": "DRAFT", "current_round": 1,
                  "latest_revision": {"revision_id": "rev-1", "content_hash": "sha256:" + "b" * 64,
                                      "source": "synth", "round": 1}}
_FINDING = {"id": "FARM-HIGH-001", "title": "The farm query is not scoped to the tenant",
            "rule_violated": "Every query is tenant-scoped"}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_registry(workspace: Path, *, enabled: bool = True, r4_mode: str = "shadow", top_k: int = 3) -> None:
    registry = json.loads(json.dumps(_SEED))
    registry["enabled"] = enabled
    for question in registry["questions"]:
        if question["id"] == "R4":
            question["mode"], question["thresholds"] = r4_mode, {"top_k": top_k}
    path = workspace / "aria-config" / "system-one-questions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(registry), encoding="utf-8")


def registry_row(finding_id: str) -> str:
    return json.dumps({"id": finding_id, **{k: v for k, v in _FINDING.items() if k != "id"}})


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def commit_all(repo: Path, message: str, *paths: str) -> str:
    if paths:
        git(repo, "add", "--", *paths)
    else:
        git(repo, "add", "-A")
    git(repo, "-c", "user.email=t@t.invalid", "-c", "user.name=t", "commit", "-qm", message)
    return git(repo, "rev-parse", "HEAD")


@contextlib.contextmanager
def public_origin() -> Iterator[Path]:
    """A bare origin standing in for the pinned public URL — the only remote the asks ever fetch."""
    holder = Path(tempfile.mkdtemp(prefix="aria-points-origin-"))
    origin = holder / "public.git"
    subprocess.run(["git", "init", "-q", "--bare", str(origin)], check=True)
    pinned = patch.object(system_one, "PUBLIC_REPOSITORY_URL", str(origin))
    pinned.start()
    try:
        yield origin
    finally:
        pinned.stop()
        shutil.rmtree(holder, True)


def bind_public(case: unittest.TestCase) -> Path:
    origin_context = public_origin()
    origin = origin_context.__enter__()
    case.addCleanup(origin_context.__exit__, None, None, None)
    return origin


class Vendor:
    """Answers every question; R4 scores a file by how often 'tenant' appears in its path.

    ``noul``/``score`` pin the answer instead: 0.99/2 is a confident yes, 0.01/0 a confident no.
    """

    def __init__(self, *, noul: float = 0.77, score: float | None = None) -> None:
        self.payloads: list[dict[str, Any]] = []
        self.noul, self.score = noul, score

    def __call__(self, payload: dict[str, Any]) -> JevReply:
        self.payloads.append(payload)
        (question_id, spec), = payload["questions"].items()
        if spec["type"] == "score":
            state = json.loads(payload["state"])
            score = min(2.0, state["file"].count("tenant") * 0.7) if self.score is None else self.score
            answer = {"type": "score", "score": score, "confidence": 0.8}
        else:
            answer = {"type": "noul", "noul": self.noul}
        return JevReply(model="jev-1.13.0", answers={question_id: answer}, input_tokens=50)

    def asked(self) -> list[str]:
        return [next(iter(payload["questions"])) for payload in self.payloads]


# Every way Jev can answer or fail, and the ledger outcome each leaves (None: the entry point raised, no row).
JEV_BEHAVIOURS: dict[str, tuple[str, str | None] | None] = {
    "yes": ("answered", None),
    "no": ("answered", None),
    "timeout": ("unavailable", "transport_error:TimeoutError"),
    "refused_http_401": ("unavailable", "auth_rejected_http_401"),
    "no_credential": ("unavailable", "credential_not_configured"),
    "transport_raises": ("unavailable", "transport_raised:RuntimeError"),
    "entry_point_raises": None,
}


@contextlib.contextmanager
def jev(behaviour: str, key_dir: Path) -> Iterator[None]:
    """Jev behaving as ``behaviour``. Failures go through the REAL transport (a scripted opener, a fake key).

    The opener is the seam the transport's own suite injects: it applies the
    refusal mapping the real ``_http_opener`` applies to a socket timeout, so
    the retry, breaker and ledger behaviour under test is the shipped one.
    """
    if behaviour in ("yes", "no"):
        vendor = Vendor(noul=0.99, score=2) if behaviour == "yes" else Vendor(noul=0.01, score=0)
        with patch("aria_kernel.system_one._transport", vendor):
            yield
        return
    if behaviour == "transport_raises":
        with patch("aria_kernel.system_one._transport", side_effect=RuntimeError("vendor sdk blew up")):
            yield
        return
    if behaviour == "entry_point_raises":
        with patch("aria_kernel.system_one_points.ask", side_effect=RuntimeError("system one blew up")):
            yield
        return
    key = key_dir / "jev.fake-key"
    key.write_text("fake-test-credential\n", encoding="utf-8")
    key.chmod(0o600)
    environ = {} if behaviour == "no_credential" else {JEV_CREDENTIAL_FILE_ENV: str(key)}

    def opener(request: object, timeout_seconds: float) -> tuple[int, bytes]:
        if behaviour == "timeout":
            try:
                raise TimeoutError("timed out")
            except OSError as exc:
                raise jev_runtime._Refused(f"transport_error:{type(exc).__name__}", retryable=True) from exc
        return 401, b""

    breaker = CircuitBreaker()

    def transport(payload: dict[str, Any]) -> Any:
        return post_systemone(payload, environ=environ, opener=opener, breaker=breaker, sleep=lambda _s: None)

    with patch("aria_kernel.system_one._transport", transport):
        yield


def assert_rows_for(case: unittest.TestCase, behaviour: str, recorded: list[dict[str, Any]]) -> None:
    expected = JEV_BEHAVIOURS[behaviour]
    if expected is None:
        case.assertEqual(recorded, [])
        return
    case.assertTrue(recorded)
    outcome, reason = expected
    case.assertEqual({r["outcome"] for r in recorded}, {outcome})
    # After three consecutive failures the in-process breaker answers for the vendor.
    case.assertEqual(recorded[0]["reason"], reason)
    case.assertLessEqual({r["reason"] for r in recorded}, {reason, "circuit_open"})


def rows(tools: Path) -> list[dict[str, Any]]:
    path = tools.joinpath(*CALLS_RELPATH)
    return load_declared_jsonl(path, expected_surface=CALLS_SURFACE) if path.exists() else []


class Helpers(unittest.TestCase):
    def test_file_diffs_skip_docs_and_cut_each_file(self) -> None:
        diff = ("diff --git a/docs/x.md b/docs/x.md\n+doc\n"
                "diff --git a/apps/a.ts b/apps/a.ts\n+" + "x" * 20_000 + "\n"
                "diff --git a/apps/b.ts b/apps/b.ts\n+b\n")
        files = points.file_diffs(diff)
        self.assertEqual(list(files), ["apps/a.ts", "apps/b.ts"])
        self.assertEqual(len(files["apps/a.ts"]), points.FILE_DIFF_MAX_CHARS)

    def test_closes_ids_read_the_trailers(self) -> None:
        ids = points.closes_ids(["fix(x): y\n\nCloses: docs/reviews/a.md#FARM-HIGH-001\nRefs: z#ARIA-LOW-252",
                                 "Closes: docs/reviews/b.md#ORPHAN-LOW-002"])
        self.assertEqual(ids, ["FARM-HIGH-001", "ORPHAN-LOW-002"])


class PrOpen(unittest.TestCase):
    """The live opener (`dry_run=False`) with the gh mock the PR-manager suite uses."""

    def setUp(self) -> None:
        from tests._helpers.installation_credential import LANE_CREDENTIAL_ENV
        from tests.test_pr_manager_e2e import FIXTURE_CHANGED_FILE, _seed_tools

        credential = patch.dict("os.environ", LANE_CREDENTIAL_ENV)
        credential.start()
        self.addCleanup(credential.stop)
        self.tools = _seed_tools()
        self.repo = self.tools.parent
        self.addCleanup(shutil.rmtree, self.repo, True)
        (self.repo / FIXTURE_CHANGED_FILE).write_text("export const TENANT_SCOPED = true;\n", encoding="utf-8")
        registry = self.repo / REGISTRY_FINDINGS
        registry.parent.mkdir(parents=True)
        registry.write_text(registry_row("FARM-HIGH-001") + "\n", encoding="utf-8")
        self.head = commit_all(self.repo, "fix(farm): scope it\n\nCloses: docs/reviews/a.md#FARM-HIGH-001",
                               FIXTURE_CHANGED_FILE, REGISTRY_FINDINGS)
        origin = bind_public(self)
        git(self.repo, "push", "-q", str(origin), "HEAD:main")

    def open(self) -> tuple[dict[str, Any], list[list[str]]]:
        from tests._gh_mock import gh_create_success, recorded_calls, reset_recorded
        from tests.test_pr_manager_e2e import _seed_apply_action, _seed_proposal
        from aria_kernel.pr_manager import open_pr_for_action

        reset_recorded()
        proposal = _seed_proposal(tools=self.tools)
        _seed_apply_action(tools=self.tools, proposal_id=proposal["proposal_id"], status="ready_for_pr")
        with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_success):
            result = open_pr_for_action(proposal_id=proposal["proposal_id"], workspace_root=self.repo,
                                        base_dir=self.tools, change_id="ch-test", dry_run=False)
        # The proposal id is minted fresh per seed; the opener's argv is compared without it.
        pid = str(proposal["proposal_id"])
        return result, [[arg.replace(pid, "PROPOSAL") for arg in call.argv]
                        for call in recorded_calls() if call.argv[:2] == ["gh", "pr"]]

    def test_shadow_rows_and_an_identical_pr(self) -> None:
        off_result, off_gh = self.open()
        self.assertEqual(rows(self.tools), [])
        write_registry(self.repo)
        vendor = Vendor()
        with patch("aria_kernel.system_one._transport", vendor):
            on_result, on_gh = self.open()
        self.assertEqual(on_gh, off_gh)
        for key in ("url", "pr_number", "head_sha", "base_branch"):
            self.assertEqual(on_result.get(key), off_result.get(key), key)
        self.assertEqual(sorted(vendor.asked()), ["J0", "R5"])
        recorded = rows(self.tools)
        self.assertEqual(sorted((r["question_id"], r["decision_point"], r["outcome"]) for r in recorded),
                         [("J0", "pre_pr_open", "answered"), ("R5", "pre_pr_open", "answered")])
        j0 = next(r for r in recorded if r["question_id"] == "J0")
        r5 = next(r for r in recorded if r["question_id"] == "R5")
        # The subject names WHAT was asked about, id-shaped: the finding, the head commit.
        self.assertEqual(j0["subject"], "FARM-HIGH-001")
        self.assertEqual(r5["subject"], self.head)
        j0_payload = next(p for p in vendor.payloads if "J0" in p["questions"])
        self.assertEqual(json.loads(j0_payload["state"])["finding"],
                         {"finding": _FINDING["title"], "rule": _FINDING["rule_violated"]})

    def test_the_pr_is_the_same_whatever_jev_does(self) -> None:
        off_result, off_gh = self.open()
        write_registry(self.repo)
        keys = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, keys, True)
        for behaviour in JEV_BEHAVIOURS:
            with self.subTest(behaviour=behaviour):
                before = len(rows(self.tools))
                with jev(behaviour, keys):
                    on_result, on_gh = self.open()
                self.assertEqual(on_gh, off_gh)
                for key in ("url", "pr_number", "head_sha", "base_branch"):
                    self.assertEqual(on_result.get(key), off_result.get(key), key)
                assert_rows_for(self, behaviour, rows(self.tools)[before:])


class Merge(unittest.TestCase):
    def setUp(self) -> None:
        from tests.test_merge_lane_publication import _gates

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@t.invalid")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "apps").mkdir()
        (self.repo / "apps" / "farm.ts").write_text("repo.getRepository(Farm)\n", encoding="utf-8")
        self.base = commit_all(self.repo, "init")
        (self.repo / "apps" / "farm.ts").write_text("repo.getScopedRepository(Farm)\n", encoding="utf-8")
        registry = self.repo / REGISTRY_FINDINGS
        registry.parent.mkdir(parents=True)
        registry.write_text(registry_row("FARM-HIGH-001") + "\n", encoding="utf-8")
        self.head = commit_all(self.repo, "fix(farm): scope it\n\nCloses: docs/reviews/a.md#FARM-HIGH-001")
        origin = bind_public(self)
        git(self.repo, "push", "-q", str(origin), "HEAD:main")
        # The store sits inside the repo so its bound workspace IS the repo the asks fetch in.
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        self.diff = git(self.repo, "diff", f"{self.base}..{self.head}")
        for item in _gates():
            item.start()
            self.addCleanup(item.stop)

    def merge(self) -> tuple[dict[str, Any], list[str]]:
        from aria_kernel.merge_authority import merge_pr_if_ready

        calls: list[str] = []
        repo_base, repo_head, diff = self.base, self.head, self.diff

        class Adapter:
            def get_open_issues(self, *, labels: Any) -> dict:
                return {"readable": True, "issues": []}

            def get_pr(self, number: int) -> dict:
                return {"number": number, "state": "OPEN", "repository": "o/r", "base_branch": "main",
                        "head_ref": "feat/x", "head_sha": repo_head, "base_sha": repo_base, "diff_text": diff}

            def merge_pr(self, number: int, **kwargs: Any) -> dict:
                calls.append("merge")
                return {"merged": True}

        result = merge_pr_if_ready(adapter=Adapter(), pr_number=7, base_dir=self.tools, workspace_root=self.repo,
                                   readiness_claim_id="claim:7:aaaaaaaaaaaa",
                                   intent_publisher=lambda intent: {"published": True})
        return result, calls

    def test_one_j0_row_per_trailer_and_file_and_an_identical_decision(self) -> None:
        off_result, off_calls = self.merge()
        write_registry(self.repo)
        vendor = Vendor()
        with patch("aria_kernel.system_one._transport", vendor):
            on_result, on_calls = self.merge()
        self.assertEqual((on_result["decision"], on_result["eligible"], on_calls),
                         (off_result["decision"], off_result["eligible"], off_calls))
        recorded = rows(self.tools)
        self.assertEqual([(r["question_id"], r["decision_point"], r["subject"]) for r in recorded],
                         [("J0", "merge_authority", "FARM-HIGH-001")])
        self.assertEqual(json.loads(vendor.payloads[0]["state"])["finding"]["rule"], _FINDING["rule_violated"])

    def test_the_merge_decision_is_the_same_whatever_jev_does(self) -> None:
        off_result, off_calls = self.merge()
        write_registry(self.repo)
        keys = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, keys, True)
        for behaviour in JEV_BEHAVIOURS:
            with self.subTest(behaviour=behaviour):
                before = len(rows(self.tools))
                with jev(behaviour, keys):
                    on_result, on_calls = self.merge()
                self.assertEqual((on_result["decision"], on_result["eligible"], on_calls),
                                 (off_result["decision"], off_result["eligible"], off_calls))
                assert_rows_for(self, behaviour, rows(self.tools)[before:])


class JudgeFanout(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def repo_for(self, store: str) -> tuple[Path, Path]:
        """A store's own repo with its own public origin: the finding registry the asks
        resolve sits on that origin's ``main``, so stores cannot share one."""
        repo = self.root / store / "repo"
        (repo / "src").mkdir(parents=True)
        (repo / "src" / "farm.ts").write_text("\n".join(f"line {i}" for i in range(1, 30)) + "\n", encoding="utf-8")
        registry = repo / REGISTRY_FINDINGS
        registry.parent.mkdir(parents=True)
        registry.write_text(registry_row("FARM-HIGH-001") + "\n", encoding="utf-8")
        git(repo, "init", "-q")
        commit_all(repo, "init")
        origin_context = public_origin()
        origin = origin_context.__enter__()
        self.addCleanup(origin_context.__exit__, None, None, None)
        git(repo, "push", "-q", str(origin), "HEAD:main")
        return repo, origin

    def item(self, index: int, tool_id: str) -> dict[str, Any]:
        # The tenant-scoping item carries the REGISTERED finding id J1's rule state resolves to.
        return {"tool_id": tool_id, "run_id": "r", "cycle_id": "c1",
                "finding_id": "FARM-HIGH-001" if tool_id == "tenant-scoping-adapter" else f"F{index}",
                "rule": "missing-tenant-guard", "severity": "high", "path": "src/farm.ts:12",
                "message": "query without tenant scope", "evidence": ["src/farm.ts:12"],
                "finding_fingerprint": f"fp{index}"}

    def fan_out(self, store: str, *, with_registry: bool = False) -> tuple[dict[str, Any], Path]:
        from aria_kernel.judge_fanout import dispatch_judges_for_sample
        from tests._helpers.rule_contracts import DEFAULT_RULE_CONTRACT, register_contracted_tool

        repo, _origin = self.repo_for(store)
        if with_registry:
            write_registry(repo)
        sample = {"cycle_id": "c1", "items": [self.item(1, "tenant-scoping-adapter"), self.item(2, "tool-x")]}
        tools = ensure_tools_dir(repo / "aria-tools")
        # ARIA-HIGH-324 (main): a finding is judged against its rule's contract,
        # read from the tool's registered manifest — the fixture registers it.
        register_contracted_tool(tools, "tenant-scoping-adapter",
                                 rules={"missing-tenant-guard": dict(DEFAULT_RULE_CONTRACT)})
        return dispatch_judges_for_sample(sample=sample, base_dir=tools, repo_root=repo), tools

    def test_one_j1_row_per_minted_tenant_finding_and_an_identical_mint(self) -> None:
        off, _ = self.fan_out("off")
        vendor = Vendor()
        with patch("aria_kernel.system_one._transport", vendor):
            on, tools = self.fan_out("on", with_registry=True)
        self.assertEqual(on["minted_count"], off["minted_count"])
        self.assertEqual([(m["role"], m["judgment_group_id"]) for m in on["minted"]],
                         [(m["role"], m["judgment_group_id"]) for m in off["minted"]])
        recorded = rows(tools)
        self.assertEqual([(r["question_id"], r["subject"]) for r in recorded],
                         [("J1-tenant-scoping", "FARM-HIGH-001")])
        state = json.loads(vendor.payloads[0]["state"])
        self.assertEqual(state["rule"], _FINDING["rule_violated"])
        self.assertEqual(state["file"], "src/farm.ts")
        self.assertIn("12: line 12", state["excerpt"])

    def test_the_mint_is_the_same_whatever_jev_does(self) -> None:
        off, _ = self.fan_out("off")
        for behaviour in JEV_BEHAVIOURS:
            with self.subTest(behaviour=behaviour):
                with jev(behaviour, self.root):
                    on, tools = self.fan_out(behaviour, with_registry=True)
                self.assertEqual(on["minted_count"], off["minted_count"])
                self.assertEqual([(m["role"], m["judgment_group_id"]) for m in on["minted"]],
                                 [(m["role"], m["judgment_group_id"]) for m in off["minted"]])
                assert_rows_for(self, behaviour, rows(tools))


class CandidateFiles(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "apps").mkdir(parents=True)
        for name in ("tenant_tenant_tenant", "tenant_tenant", "tenant", "farm", "other"):
            (self.repo / "apps" / f"{name}.ts").write_text(
                "export function scopeQuery() {}\nconst getScopedRepository = 1\n", encoding="utf-8")
        registry = self.repo / REGISTRY_FINDINGS
        registry.parent.mkdir(parents=True)
        registry.write_text(registry_row("FARM-HIGH-001") + "\n", encoding="utf-8")
        git(self.repo, "init", "-q")
        commit_all(self.repo, "init")
        origin = bind_public(self)
        git(self.repo, "push", "-q", str(origin), "HEAD:main")
        self.tools = ensure_tools_dir(self.repo / "aria-tools")

    def rank(self, vendor: Vendor, *, finding_origin: bool = True) -> list[dict[str, Any]]:
        def plan() -> dict[str, str]:
            self.plan_reads += 1
            content = {"title": "Use `getScopedRepository`", "summary": "in scopeQuery"}
            if finding_origin:
                content["finding_id"] = "FARM-HIGH-001"
            return content

        self.plan_reads = 0
        with patch("aria_kernel.system_one._transport", vendor):
            return points.rank_candidate_files(plan=plan, workspace_root=self.repo, base_dir=self.tools)

    def test_flag_off_asks_nothing_and_the_prompts_match_origin_main(self) -> None:
        from aria_kernel.cross_review_bridge import _implementation_suggested_prompt
        from aria_kernel.plan_round_controller import _prompt_for_role

        for enabled in (False, True):
            write_registry(self.repo, enabled=enabled, r4_mode="shadow")
            vendor = Vendor()
            ranked = self.rank(vendor, finding_origin=True)
            self.assertEqual((ranked, vendor.payloads, rows(self.tools), self.plan_reads), ([], [], [], 0))
            self.assertEqual(_sha(_implementation_suggested_prompt(**_IMPLEMENTER_ARGS, candidate_files=ranked)),
                             _GOLDEN_IMPLEMENTER)
            for role, golden in _GOLDEN_PLANNER.items():
                self.assertEqual(_sha(_prompt_for_role(role, _PLANNER_STATE, candidate_files=ranked)), golden)

    def test_flag_on_ranks_and_caps_the_section(self) -> None:
        from aria_kernel.cross_review_bridge import _implementation_suggested_prompt
        from aria_kernel.plan_round_controller import _prompt_for_role

        write_registry(self.repo, r4_mode="order", top_k=3)
        vendor = Vendor()
        ranked = self.rank(vendor, finding_origin=True)
        self.assertEqual([row["path"] for row in ranked],
                         ["apps/tenant_tenant_tenant.ts", "apps/tenant_tenant.ts", "apps/tenant.ts"])
        self.assertEqual(len(rows(self.tools)), 5)
        state = json.loads(vendor.payloads[0]["state"])
        self.assertEqual(state["problem"], _FINDING["title"])
        prompt = _implementation_suggested_prompt(**_IMPLEMENTER_ARGS, candidate_files=ranked)
        section = prompt.split("Candidate files (System One R4", 1)[1]
        self.assertEqual(section.count("  - apps/"), 3)
        self.assertNotIn("apps/farm.ts", section)
        for role in _GOLDEN_PLANNER:
            payload = json.loads(_prompt_for_role(role, _PLANNER_STATE, candidate_files=ranked))
            self.assertEqual(payload["candidate_files"], ranked)

    def test_a_plan_that_names_no_finding_ranks_nothing(self) -> None:
        # ``problem`` is a reference (a registered finding); a plan with no finding origin names nothing R4 may send.
        write_registry(self.repo, r4_mode="order", top_k=3)
        vendor = Vendor()
        ranked = self.rank(vendor, finding_origin=False)
        self.assertEqual((ranked, vendor.payloads, rows(self.tools)), ([], [], []))


def _candidate_repo(root: Path) -> str:
    """``root`` as a git repo of five files naming the plan's identifiers, registry row committed; returns HEAD."""
    (root / "apps").mkdir(parents=True, exist_ok=True)
    for name in ("tenant_tenant_tenant", "tenant_tenant", "tenant", "farm", "other"):
        # An outline system_one's builder can see (``export function``): the
        # hardened core builds the outline itself, and its symbol vocabulary is the SSoT.
        (root / "apps" / f"{name}.ts").write_text(
            "export function scopeQuery() {}\nconst getScopedRepository = 1\n", encoding="utf-8")
    registry = root / REGISTRY_FINDINGS
    registry.parent.mkdir(parents=True, exist_ok=True)
    registry.write_text(registry_row("ORPHAN-LOW-002") + "\n", encoding="utf-8")
    git(root, "init", "-q")
    git(root, "add", "apps", "docs")
    # Fixed dates: the commit (the implementer's base_sha) is the same in every fixture.
    dates = {"GIT_AUTHOR_DATE": "2026-10-03T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-03T00:00:00Z"}
    subprocess.run(["git", "-c", "user.email=t@t.invalid", "-c", "user.name=t", "commit", "-qm", "init"],
                   cwd=root, check=True, env={**os.environ, **dates})
    return git(root, "rev-parse", "HEAD")


class Envelopes(unittest.TestCase):
    """The REAL envelope builders: off (no registry / R4 shadow) is byte-identical, on adds a capped section."""

    _PLAN = {"title": "Use `getScopedRepository` everywhere", "summary": "Scope the farm query.",
             "finding_id": "ORPHAN-LOW-002"}

    def mint(self, registry: str | None, behaviour: str | None = None) -> tuple[str, str, list[str]]:
        from aria_kernel.cross_review_bridge import issue_implementation_envelope
        from aria_kernel.plan_convergence import start_plan
        from aria_kernel.plan_round_controller import advance_plan_rounds
        from aria_kernel.agent_invocations import list_agent_invocation_requests
        from aria_kernel.request_admission import admit_request
        from tests._helpers.operator_acts import operator_set_profile
        from tests.test_implementation_lifecycle_continuity import (
            converging_plan_content, drive_plan_to_converged, seed_reviewer_agent,
        )

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        base_sha = _candidate_repo(root)
        origin_context = public_origin()
        origin = origin_context.__enter__()
        self.addCleanup(origin_context.__exit__, None, None, None)
        git(root, "push", "-q", str(origin), "HEAD:main")
        if registry is not None:
            write_registry(root, r4_mode=registry, top_k=2)
        tools = root / "aria-tools"
        # The planner ranks (and every ask fetches) in the store's bound workspace: root itself.
        seed_reviewer_agent(root)
        operator_set_profile("strict", base_dir=tools, scheduler_ceiling="strict")
        body = converging_plan_content(
            self._PLAN["title"], summary=self._PLAN["summary"], finding_id=self._PLAN["finding_id"],
            affected_surfaces=[{"paths": ["apps/tenant.ts"]}],
            # Contract v2 (60dee947c): a key change that writes a source file declares
            # `imports` — an empty list, it changes none. Without it the contract gate
            # records plan_contract_incomplete, the plan never leaves CRITIQUED, and the
            # envelope mint refuses `implementation_envelope_forbidden_on_state_CRITIQUED`.
            key_changes=[{"id": "kc-1", "description": "scope it", "paths": ["apps/tenant.ts"],
                          "imports": []}],
        )
        vendor = Vendor()
        answering = (patch("aria_kernel.system_one._transport", vendor) if behaviour is None
                     else jev(behaviour, root))
        with answering:
            drive_plan_to_converged(plan_id="plan-impl", tools=tools, workspace_root=root, plan_content=body)
            implementer = issue_implementation_envelope(
                plan_id="plan-impl", cross_review_revision_id="cr-1", cross_review_summary_text="{}",
                proposal_id="proposal-1", change_id="chg-1", branch="aria-impl-0123456789abcdef",
                base_sha=base_sha, base_dir=tools, cycle_id="cyc-1",
                admission=admit_request("implementer.converged_plan", "implementation", base_dir=tools),
            )["suggested_prompt"]
            start_plan(plan_id="plan-draft", initial_revision_id="rev-0", plan_content=body, base_dir=tools,
                       workspace_root=root)
            advance_plan_rounds(plan_id="plan-draft", base_dir=tools)
        planner = next(row["suggested_prompt"] for row in list_agent_invocation_requests(base_dir=tools)
                       if row.get("role") == "challenger_plan")
        return implementer, planner, vendor.asked()

    def test_off_is_byte_identical_and_on_adds_a_capped_section(self) -> None:
        base_implementer, base_planner, base_asked = self.mint(None)
        shadow_implementer, shadow_planner, shadow_asked = self.mint("shadow")
        self.assertEqual((shadow_implementer, shadow_planner), (base_implementer, base_planner))
        self.assertEqual((base_asked, shadow_asked), ([], []))
        order_implementer, order_planner, order_asked = self.mint("order")
        self.assertEqual(set(order_asked), {"R4"})
        self.assertTrue(order_implementer.startswith(base_implementer))
        section = order_implementer[len(base_implementer):]
        self.assertEqual(section.count("  - apps/"), 2)
        self.assertIn("apps/tenant_tenant_tenant.ts", section)
        candidates = json.loads(order_planner)["candidate_files"]
        self.assertEqual([row["path"] for row in candidates], ["apps/tenant_tenant_tenant.ts", "apps/tenant_tenant.ts"])
        self.assertNotIn("candidate_files", json.loads(base_planner))

    def test_whatever_jev_does_a_shadow_or_failing_r4_leaves_every_envelope_byte_identical(self) -> None:
        base_implementer, base_planner, _ = self.mint(None)
        failing = [b for b in JEV_BEHAVIOURS if b not in ("yes", "no")]
        for registry, behaviours in (("shadow", list(JEV_BEHAVIOURS)), ("order", failing)):
            for behaviour in behaviours:
                with self.subTest(registry=registry, behaviour=behaviour):
                    implementer, planner, _ = self.mint(registry, behaviour)
                    self.assertEqual((implementer, planner), (base_implementer, base_planner))


class Budget(unittest.TestCase):
    """A slow Jev cannot hold a lane: an entry point stops asking once SHADOW_BUDGET_SECONDS is spent."""

    def test_an_entry_point_stops_asking_once_its_budget_is_spent(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo = Path(tmp.name) / "repo"
        (repo / "apps").mkdir(parents=True)
        for index in range(6):
            (repo / "apps" / f"f{index}.ts").write_text(f"x{index}\n", encoding="utf-8")
        registry = repo / REGISTRY_FINDINGS
        registry.parent.mkdir(parents=True)
        registry.write_text(registry_row("FARM-HIGH-001") + "\n", encoding="utf-8")
        git(repo, "init", "-q")
        head = commit_all(repo, "fix(x): y\n\nCloses: docs/reviews/a.md#FARM-HIGH-001")
        origin = bind_public(self)
        git(repo, "push", "-q", str(origin), "HEAD:main")
        tools = ensure_tools_dir(repo / "aria-tools")
        write_registry(repo)
        diff = "".join(f"diff --git a/apps/f{i}.ts b/apps/f{i}.ts\n+x{i}\n" for i in range(6))
        clock, vendor = [0.0], Vendor()

        def slow(payload: dict[str, Any]) -> JevReply:
            clock[0] += 6.0  # every answer takes 6 s of the 10 s budget
            return vendor(payload)

        with patch.object(points, "_clock", lambda: clock[0]), patch.object(points, "SHADOW_BUDGET_SECONDS", 10.0), \
                patch("aria_kernel.system_one._transport", slow):
            points.shadow_pr_open(base_dir=tools, workspace_root=repo, diff_text=diff, head_sha=head,
                                  commits=[{"subject": "fix(x): y", "body": "Closes: docs/reviews/a.md#FARM-HIGH-001"}])
        # R5 first (one call), then J0 per file until the budget is gone: two of seven calls.
        self.assertEqual(vendor.asked(), ["R5", "J0"])
        self.assertEqual(len(rows(tools)), 2)


def _environment_uses(path: Path) -> list[tuple[str, str, str]]:
    """Every environment touch in ``path`` as (attribute, enclosing function, how used)."""

    class Visitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: list[str] = []
            self.uses: list[tuple[str, str, str]] = []

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_Attribute(self, node: ast.Attribute) -> None:
            if node.attr in ("environ", "environb", "getenv"):
                parent = self.parent_of(id(node))
                usage = parent.attr if isinstance(parent, ast.Attribute) else (
                    "subscript" if isinstance(parent, ast.Subscript) else "read")
                self.uses.append((node.attr, self.stack[-1] if self.stack else "<module>", usage))
            self.generic_visit(node)

        def parent_of(self, node_id: int) -> ast.AST:
            return self.parents.get(node_id, ast.Module())  # type: ignore[call-overload]

        parents: dict[int, ast.AST]

    tree = ast.parse(path.read_text(encoding="utf-8"))
    visitor = Visitor()
    visitor.parents = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            visitor.parents[id(child)] = parent
    visitor.visit(tree)
    return visitor.uses


class Switch(unittest.TestCase):
    def test_only_the_committed_registry_turns_system_one_on(self) -> None:
        # No process-environment flag a run could flip: neither module READS the environment to
        # decide anything. system_one's one deliberate touch is building the HERMETIC git
        # environment (caller GIT_* stripped) inside `_git` (ed92805d8); points never names it.
        from aria_kernel import system_one

        self.assertEqual(_environment_uses(Path(str(system_one.__file__))),
                         [("environ", "_git", "items")])
        self.assertEqual(_environment_uses(Path(str(points.__file__))), [])

    def test_no_workflow_carries_the_jev_credential(self) -> None:
        # ADR-0027 §5: the self-hosted lanes inherit ARIA_JEV_API_KEY_FILE (a 0600 file's path) from the
        # runner's .env; no GitHub secret holds the key and no workflow sets, overrides or prints the path.
        carried = re.compile(r"(?i)secrets\.\w*jev|ARIA_JEV_API_KEY(?!_FILE)|ARIA_JEV_API_KEY_FILE\s*[:=]|jev_api_key")
        for workflow in sorted((_REPO_ROOT / ".github" / "workflows").glob("*.y*ml")):
            self.assertIsNone(carried.search(workflow.read_text(encoding="utf-8")), workflow.name)


if __name__ == "__main__":
    unittest.main()
