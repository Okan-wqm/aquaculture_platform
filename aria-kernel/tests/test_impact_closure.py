"""SE-4 — one impact closure over typed edges (service-expertise PLAN §1.1 step 3, §2 'Service impact
closure', §4.2, §8 SE-4).

WHY this suite exists: the kernel answers "which services does this change reach" in three
places, and each answers it differently. ``plan_downstream_impact`` and
``cycle_service_examination`` each walk ``_reverse_closure`` over import edges only
(``local_import_scan_v1``), so an ``apps/``-only diff has an empty downstream set: a change to what
auth-service puts in a token never reaches gateway-api, which composes auth-service's subgraph,
and a change to an event interface ranks its producers and consumers no higher than every project
that merely imports the contracts library. The plan-coverage witness computes a third closure of
its own (``tools/gates/plan-coverage-witness.ts``: nx reverse dependents at depth 1 plus
``event-consumer:`` nodes from ACL grants and code subscriptions).

SE-4 makes it one function in ``impact_graph`` over typed edges — ``import`` (the cached project
graph), ``event`` (code producer x code subscription, from SE-3's facts) and ``gateway_subgraph``
(``infrastructure/apollo-router/subgraphs.json`` at base) — that backs both entry points; the
witness consumes its node set. When the code facts are unavailable the change is held by name
(``contract_edges_unavailable``), never routed on an import-only or empty closure.

The function is ``impact_graph.impact_closure`` (the name is the test writer's; the spec names the
owner module and its role, not the function). It and the new ``service_facts`` parameter of the
two entry points are looked up with ``getattr`` / ``inspect.signature`` so every case is red on an
assertion before they exist, never on an import or a TypeError. Pinned contract:

  - ``impact_closure(*, changed_files, workspace_root, base_dir, service_facts, depth=None,
    changed_hunks=None)``; ``service_facts`` is ``plan_coverage.compute_service_facts``'s result;
    ``changed_hunks`` maps a repo path to its changed base-side line ranges ``(start, end)``,
    inclusive; ``depth`` bounds the walk (None = the whole closure);
  - computed: ``{"touched": [...], "impacted": [{"project", "reason", "evidence"}, ...]}``;
    ``impacted`` is the closure minus touched (§4.2), contract edges ranked before import-only
    ones; a contract reason is ``contract:gateway_subgraph`` or ``contract:event:<T>`` and its
    ``evidence`` is the edge's ``path:line``;
  - facts not computed: ``{"hold": "contract_edges_unavailable:<named reason>"}`` and no
    ``impacted`` at all; both entry points carry the same hold and no impacted list;
  - ``plan_downstream_impact`` and ``cycle_service_examination`` take ``service_facts`` and
    report the closure's impacted set; neither (nor any other function in the module) walks
    ``_reverse_closure`` itself;
  - plan coverage passes the closure's node set at depth 1 to the witness as ``closure_nodes``
    (``project:<name>``) and holds by name, without running the witness, when the facts entries
    cannot run.
"""
from __future__ import annotations

import ast
import inspect
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

import aria_kernel.impact_graph as ig
from aria_kernel import plan_coverage
from tests._helpers.git_fixtures import make_repo_with_initial_commit

CONTRACT_FILE = "libs/event-contracts/src/fixture-events.ts"
SUBGRAPHS = "infrastructure/apollo-router/subgraphs.json"
EVENT_ENTRY = plan_coverage.EVENT_FACTS_RELPATH
MODULE_ENTRY = plan_coverage.MODULE_FACTS_RELPATH
WITNESS_ENTRY = plan_coverage.WITNESS_RELPATH

# --- The fixture tree ---------------------------------------------------------------------------
#
#   libs/shared  <-import-  libs/token (token-lib)  <-import-  apps/auth-service
#   apps/auth-service  -gateway_subgraph->  apps/gateway-api   (subgraphs.json nxProject)
#   libs/event-contracts  <-import-  a-service (produces FixtureShipped), b-service (consumes it),
#                                    c-service (imports only), d-service (FixtureArchived both ways)
#   apps/tool-service: no subgraph, imported by nothing.

_SUBGRAPHS_TEXT = "\n".join(
    [
        "{",
        '  "metadata": { "note": "fixture" },',
        '  "subgraphs": [',
        "    {",
        '      "name": "auth",',
        '      "nxProject": "auth-service",',
        '      "routingUrl": "http://auth-service:3000/graphql"',
        "    }",
        "  ],",
        '  "excludedFederatedServices": []',
        "}",
        "",
    ]
)

_CONTRACT_TEXT = "\n".join(
    [
        "import type { BaseEvent } from './base-event';",
        "",
        "export interface FixtureShippedEvent extends BaseEvent {",
        "  readonly eventType: 'FixtureShipped';",
        "  readonly shipmentId: string;",
        "}",
        "",
        "export interface FixtureArchivedEvent extends BaseEvent {",
        "  readonly eventType: 'FixtureArchived';",
        "}",
        "",
    ]
)

_CONTRACTS_IMPORT = "import type { BaseEvent } from '@platform/event-contracts';\n"


def _project(name: str) -> str:
    return json.dumps({"name": name}) + "\n"


FIXTURE_FILES: dict[str, str] = {
    "tsconfig.base.json": json.dumps(
        {
            "compilerOptions": {
                "paths": {
                    "@platform/event-contracts": ["libs/event-contracts/src/index.ts"],
                    "@platform/shared": ["libs/shared/src/index.ts"],
                    "@platform/token": ["libs/token/src/index.ts"],
                }
            }
        }
    )
    + "\n",
    SUBGRAPHS: _SUBGRAPHS_TEXT,
    "libs/event-contracts/project.json": _project("event-contracts"),
    "libs/event-contracts/src/base-event.ts": "export interface BaseEvent { readonly eventType: string; }\n",
    "libs/event-contracts/src/index.ts": "export * from './base-event';\nexport * from './fixture-events';\n",
    CONTRACT_FILE: _CONTRACT_TEXT,
    "libs/shared/project.json": _project("shared"),
    "libs/shared/src/index.ts": "export const shared = 1;\n",
    "libs/token/project.json": _project("token-lib"),
    "libs/token/src/index.ts": "import { shared } from '@platform/shared';\nexport const token = shared;\n",
    "apps/auth-service/project.json": _project("auth-service"),
    "apps/auth-service/src/main.ts": "import { token } from '@platform/token';\nexport const claims = token;\n",
    "apps/gateway-api/project.json": _project("gateway-api"),
    "apps/gateway-api/src/main.ts": "export const gateway = 1;\n",
    "apps/tool-service/project.json": _project("tool-service"),
    "apps/tool-service/src/main.ts": "export const tool = 1;\n",
    "apps/a-service/project.json": _project("a-service"),
    "apps/a-service/src/main.ts": _CONTRACTS_IMPORT + "export function ship(): void {}\n",
    "apps/b-service/project.json": _project("b-service"),
    "apps/b-service/src/main.ts": _CONTRACTS_IMPORT + "export function onShipped(): void {}\n",
    "apps/c-service/project.json": _project("c-service"),
    "apps/c-service/src/main.ts": _CONTRACTS_IMPORT + "export const c = 1;\n",
    "apps/d-service/project.json": _project("d-service"),
    "apps/d-service/src/main.ts": _CONTRACTS_IMPORT + "export function archive(): void {}\n",
}

A_PRODUCES = "apps/a-service/src/main.ts:2"
B_CONSUMES = "apps/b-service/src/main.ts:2"
D_PRODUCES = "apps/d-service/src/main.ts:2"
D_CONSUMES = "apps/d-service/src/main.ts:2"

_AVAILABLE = {
    section: "available"
    for section in (
        "events_produced",
        "events_consumed",
        "subjects_consumed",
        "edges",
        "acl_grants",
        "nats_identity",
    )
}


def _service(
    name: str,
    *,
    produced: list[dict[str, str]] | None = None,
    consumed: list[dict[str, str]] | None = None,
    edges: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    return {
        "service": name,
        "events_produced": produced or [],
        "events_consumed": consumed or [],
        "subjects_consumed": [],
        "edges": edges or [],
        "acl_grants": [],
        "nats_identity": None,
        "state": dict(_AVAILABLE),
    }


# The SE-3 event facts of the fixture tree (``event-consumer-index.ts --facts``'s shape).
EVENT_FACTS: dict[str, Any] = {
    "schema": "aria/event_facts/v1",
    "services": [
        _service(
            "a-service",
            produced=[{"event_type": "FixtureShipped", "site": A_PRODUCES}],
            edges=[
                {
                    "kind": "event",
                    "to": "b-service",
                    "subject": "events.*.FixtureShipped",
                    "ref": A_PRODUCES,
                    "to_ref": B_CONSUMES,
                }
            ],
        ),
        _service("auth-service"),
        _service("b-service", consumed=[{"event_type": "FixtureShipped", "site": B_CONSUMES}]),
        _service("c-service"),
        _service(
            "d-service",
            produced=[{"event_type": "FixtureArchived", "site": D_PRODUCES}],
            consumed=[{"event_type": "FixtureArchived", "site": D_CONSUMES}],
        ),
        _service("gateway-api"),
        _service("tool-service"),
    ],
    "event_definitions": [
        {"event_type": "FixtureArchived", "site": f"{CONTRACT_FILE}:9", "declaration": "FixtureArchivedEvent"},
        {"event_type": "FixtureShipped", "site": f"{CONTRACT_FILE}:4", "declaration": "FixtureShippedEvent"},
    ],
    "unresolved": {"produced": [], "consumed": []},
    "unattributed": {"produced": [], "consumed": []},
    "nats_identities_without_application": [],
}
MODULE_FACTS: dict[str, Any] = {"services": []}

UNAVAILABLE_FACTS: dict[str, Any] = {
    "verdict": "environment_unable",
    "base_sha": "b" * 40,
    "witness": {"tool": EVENT_ENTRY, "error": "toolchain_missing: ts-node not installed"},
}


def _computed_facts(base_sha: str) -> dict[str, Any]:
    return {
        "verdict": "computed",
        "facts_sha": base_sha,
        "event_facts": EVENT_FACTS,
        "module_facts": MODULE_FACTS,
        "witness": {},
    }


def _subgraph_line(project: str) -> int:
    for number, line in enumerate(_SUBGRAPHS_TEXT.splitlines(), start=1):
        if f'"nxProject": "{project}"' in line:
            return number
    raise AssertionError(f"fixture subgraphs.json names no {project}")


class _ClosureFixture(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.repo = make_repo_with_initial_commit(tmp, FIXTURE_FILES)
        self.head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, check=True, capture_output=True, text=True
        ).stdout.strip()
        self.tools = tmp / "aria-tools"
        self.facts = _computed_facts(self.head)

    def closure_fn(self) -> Callable[..., dict[str, Any]]:
        fn = getattr(ig, "impact_closure", None)
        self.assertTrue(
            callable(fn),
            "impact_graph.impact_closure (SE-4: the one closure over import, event and "
            "gateway_subgraph edges) does not exist",
        )
        return fn  # type: ignore[return-value]

    def assert_takes_facts(self, fn: Callable[..., Any]) -> None:
        self.assertIn(
            "service_facts",
            inspect.signature(fn).parameters,
            f"{fn.__name__} does not take the SE-3 code facts its contract edges come from (SE-4)",
        )

    def closure(self, changed_files: list[str], **kwargs: Any) -> dict[str, Any]:
        fn = self.closure_fn()
        return fn(
            changed_files=changed_files,
            workspace_root=self.repo,
            base_dir=self.tools,
            service_facts=kwargs.pop("service_facts", self.facts),
            **kwargs,
        )

    def entry(self, project: str, closure: dict[str, Any]) -> dict[str, Any]:
        found = [item for item in closure["impacted"] if item["project"] == project]
        self.assertEqual(len(found), 1, f"{project} is not impacted exactly once: {closure['impacted']}")
        return found[0]


class SameClosureFromBothEntryPointsTests(_ClosureFixture):
    """(i) the same changed files give the same impacted set from both entry points."""

    CHANGED = ["apps/auth-service/src/main.ts", "libs/shared/src/index.ts"]

    def test_both_entry_points_report_the_one_closures_impacted_set(self) -> None:
        real = self.closure_fn()
        self.assert_takes_facts(ig.plan_downstream_impact)
        self.assert_takes_facts(ig.cycle_service_examination)
        results: list[dict[str, Any]] = []

        def spy(**kwargs: Any) -> dict[str, Any]:
            result = real(**kwargs)
            results.append(result)
            return result

        with patch.object(ig, "impact_closure", side_effect=spy):
            row = ig.plan_downstream_impact(
                changed_files=self.CHANGED,
                workspace_root=self.repo,
                base_dir=self.tools,
                service_facts=self.facts,
            )
            self.assertEqual(len(results), 1, "plan_downstream_impact did not compute through impact_closure")
            examination = ig.cycle_service_examination(
                workspace_root=self.repo,
                changed_files=self.CHANGED,
                base_dir=self.tools,
                service_facts=self.facts,
            )
            self.assertEqual(len(results), 2, "cycle_service_examination did not compute through impact_closure")

        closure_set = {item["project"] for item in results[0]["impacted"]}
        self.assertEqual(closure_set, {item["project"] for item in results[1]["impacted"]})
        # Not a vacuous agreement: the import edge (shared -> token-lib) and the contract edge
        # (auth-service -> gateway-api) are both in it.
        self.assertEqual(closure_set, {"token-lib", "gateway-api"})
        self.assertEqual(set(row["downstream_projects"]), closure_set)
        self.assertEqual(set(examination["impacted_projects"]) - set(examination["changed_projects"]), closure_set)

    def test_no_function_but_the_one_closure_walks_reverse_edges(self) -> None:
        tree = ast.parse(Path(ig.__file__).read_text(encoding="utf-8"))
        walkers = sorted(
            node.name
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name != "impact_closure"
            and any(
                isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name)
                and call.func.id == "_reverse_closure"
                for call in ast.walk(node)
            )
        )
        self.assertEqual(walkers, [], f"second closure computations in impact_graph: {walkers}")


class GatewaySubgraphEdgeTests(_ClosureFixture):
    """(ii) an auth-only diff -> impacted contains gateway-api with reason contract:gateway_subgraph."""

    def test_an_auth_only_diff_reaches_gateway_api_through_its_subgraph(self) -> None:
        closure = self.closure(["apps/auth-service/src/main.ts"])
        self.assertEqual(closure["touched"], ["auth-service"])
        gateway = self.entry("gateway-api", closure)
        self.assertEqual(gateway["reason"], "contract:gateway_subgraph")
        self.assertEqual(gateway["evidence"], f"{SUBGRAPHS}:{_subgraph_line('auth-service')}")

    def test_the_examination_order_names_the_gateway_edge(self) -> None:
        self.assert_takes_facts(ig.cycle_service_examination)
        examination = ig.cycle_service_examination(
            workspace_root=self.repo,
            changed_files=["apps/auth-service/src/main.ts"],
            base_dir=self.tools,
            service_facts=self.facts,
        )
        reasons = {item["project"]: item["reason"] for item in examination["examination_order"]}
        self.assertEqual(reasons.get("gateway-api"), "contract:gateway_subgraph", examination["examination_order"])

    def test_a_service_that_is_no_subgraph_does_not_reach_the_gateway(self) -> None:
        closure = self.closure(["apps/tool-service/src/main.ts"])
        self.assertNotIn("gateway-api", [item["project"] for item in closure["impacted"]])


class EventInterfaceHunkTests(_ClosureFixture):
    """(iii) an event-interface hunk -> the producers and consumers of the changed T ranked first."""

    def test_producers_and_consumers_of_the_changed_type_rank_before_import_only_projects(self) -> None:
        closure = self.closure(
            [CONTRACT_FILE],
            changed_hunks={CONTRACT_FILE: [(4, 5)]},  # FixtureShipped's eventType member is line 4
        )
        self.assertEqual(closure["touched"], ["event-contracts"])
        ranked = [item["project"] for item in closure["impacted"]]
        self.assertEqual(set(ranked), {"a-service", "b-service", "c-service", "d-service"}, closure["impacted"])
        self.assertEqual(set(ranked[:2]), {"a-service", "b-service"}, closure["impacted"])
        producer = self.entry("a-service", closure)
        consumer = self.entry("b-service", closure)
        self.assertEqual(producer["reason"], "contract:event:FixtureShipped")
        self.assertEqual(consumer["reason"], "contract:event:FixtureShipped")
        self.assertEqual(producer["evidence"], A_PRODUCES)
        self.assertEqual(consumer["evidence"], B_CONSUMES)
        # FixtureArchived's definition lies outside the hunk: d-service is an import-only dependent.
        for project in ("c-service", "d-service"):
            self.assertFalse(self.entry(project, closure)["reason"].startswith("contract:"), closure["impacted"])


class DepthParameterTests(_ClosureFixture):
    """Depth is a parameter of the one function (plan-time policy value 1)."""

    def test_depth_bounds_the_walk(self) -> None:
        one = self.closure(["libs/shared/src/index.ts"], depth=1)
        two = self.closure(["libs/shared/src/index.ts"], depth=2)
        self.assertEqual([item["project"] for item in one["impacted"]], ["token-lib"])
        self.assertEqual({item["project"] for item in two["impacted"]}, {"token-lib", "auth-service"})


class ContractEdgesUnavailableTests(_ClosureFixture):
    """(v) facts unavailable -> the named hold contract_edges_unavailable, never an empty closure."""

    def test_the_closure_holds_by_name_and_reports_no_impacted_set(self) -> None:
        closure = self.closure(["apps/auth-service/src/main.ts"], service_facts=UNAVAILABLE_FACTS)
        self.assertTrue(closure.get("hold", "").startswith("contract_edges_unavailable"), closure)
        self.assertIn("toolchain_missing", closure["hold"])
        self.assertNotIn("impacted", closure)

    def test_both_entry_points_carry_the_hold_and_no_impacted_list(self) -> None:
        self.closure_fn()
        self.assert_takes_facts(ig.plan_downstream_impact)
        self.assert_takes_facts(ig.cycle_service_examination)
        row = ig.plan_downstream_impact(
            changed_files=["apps/auth-service/src/main.ts"],
            workspace_root=self.repo,
            base_dir=self.tools,
            service_facts=UNAVAILABLE_FACTS,
        )
        examination = ig.cycle_service_examination(
            workspace_root=self.repo,
            changed_files=["apps/auth-service/src/main.ts"],
            base_dir=self.tools,
            service_facts=UNAVAILABLE_FACTS,
        )
        for result in (row, examination):
            self.assertTrue(result.get("hold", "").startswith("contract_edges_unavailable"), result)
        self.assertNotIn("downstream_projects", row)
        self.assertNotIn("impacted_projects", examination)
        self.assertNotIn("examination_order", examination)


def _completed(stdout: str, returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr="")


class _CoverageRunner:
    """plan_coverage's runner shape: the facts entries answer the fixture facts (or raise), the
    witness entry records the input it was handed and answers an empty gaps-free report."""

    def __init__(self, *, facts_error: BaseException | None = None) -> None:
        self.facts_error = facts_error
        self.witness_inputs: list[dict[str, Any]] = []
        self.tools_run: list[str] = []

    def __call__(self, cmd: list[str], cwd: str, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        tool = cmd[3]
        self.tools_run.append(tool)
        if tool in (EVENT_ENTRY, MODULE_ENTRY):
            if self.facts_error is not None:
                raise self.facts_error
            return _completed(json.dumps(EVENT_FACTS if tool == EVENT_ENTRY else MODULE_FACTS))
        if tool == WITNESS_ENTRY:
            input_path = Path(cmd[cmd.index("--input") + 1])
            self.witness_inputs.append(json.loads(input_path.read_text(encoding="utf-8")))
            report = {
                "schema_version": 1,
                "verdict": "covered",
                "closure": {"projects": [], "event_consumers": [], "migration_couplings": []},
                "uncovered": [],
                "waived": [],
                "unmapped_paths": [],
                "inputs_hash": "x",
            }
            return _completed(json.dumps(report))
        raise AssertionError(f"plan coverage ran an unexpected entry: {cmd}")


class PlanCoveragePassesTheNodeSetTests(_ClosureFixture):
    """(iv), kernel half: plan_coverage hands the witness the closure's node set at depth 1."""

    def compute(self, runner: _CoverageRunner, paths: list[str]) -> dict[str, Any]:
        return plan_coverage.compute_plan_coverage(
            plan_content={"affected_surfaces": [{"paths": paths}], "coverage": {"waivers": []}},
            plan_id="plan-se4",
            round_number=1,
            target_revision_id="rev-0",
            target_plan_content_hash="sha256:" + "0" * 64,
            workspace_root=self.repo,
            base_dir=self.tools,
            runner=runner,
        )

    def closure_node_ids(self, runner: _CoverageRunner) -> set[str]:
        self.assertEqual(len(runner.witness_inputs), 1, runner.tools_run)
        nodes = runner.witness_inputs[0].get("closure_nodes")
        self.assertIsInstance(nodes, list, "the witness was not handed the closure's node set (closure_nodes)")
        return {node["node_id"] for node in nodes}

    def test_the_witness_gets_the_gateway_node_of_an_auth_only_plan(self) -> None:
        runner = _CoverageRunner()
        self.compute(runner, ["apps/auth-service/src/main.ts"])
        self.assertEqual(self.closure_node_ids(runner), {"project:gateway-api"})

    def test_plan_time_closure_is_depth_one(self) -> None:
        runner = _CoverageRunner()
        self.compute(runner, ["libs/shared/src/index.ts"])
        self.assertEqual(self.closure_node_ids(runner), {"project:token-lib"})

    def test_facts_that_cannot_run_hold_the_plan_by_name_without_running_the_witness(self) -> None:
        runner = _CoverageRunner(facts_error=FileNotFoundError("ts-node"))
        payload = self.compute(runner, ["apps/auth-service/src/main.ts"])
        self.assertEqual(payload["verdict"], "environment_unable", payload)
        self.assertTrue(
            str(payload["witness"].get("error", "")).startswith("contract_edges_unavailable"), payload["witness"]
        )
        self.assertNotIn(WITNESS_ENTRY, runner.tools_run)


if __name__ == "__main__":
    unittest.main()
