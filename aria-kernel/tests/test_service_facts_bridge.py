"""SE-3 — the kernel side of the code-fact bridge (service-expertise PLAN §2, §3.3, §8 SE-3 (iii)).

WHY this suite exists: change review gets its code facts (who produces and consumes which
event, the code x code edges, ACL grants, NATS identity, tenant placement) from two JSON entries
in the TypeScript tools — ``tools/gates/event-consumer-index.ts --facts`` and
``tools/aria-adapters/module-schemas-source.ts --facts`` — computed once per change subject on
the diff's BASE tree. The kernel runs both through plan_coverage's subprocess discipline
(``K/plan_coverage.py:14-19``): an environment failure is a named ``environment_unable``, never
a silent empty result, because a change routed with "no facts" looks exactly like a change
whose services produce and consume nothing. The caller holds such a change by name
(``service_facts_unavailable:<reason>``) instead of routing it with fewer services.

The entry point is ``plan_coverage.compute_service_facts`` (the runner is "factored in place",
PLAN §2 'Kernel -> TS facts bridge'; the name is the test writer's, the spec names the runner,
not the function). It is looked up with ``getattr`` so the cases are red on an assertion
before it exists, not on an import error.

Pinned contract:
  - both entries run through the injected runner, with cwd = the base tree and the default
    timeout ``DEFAULT_TIMEOUT_SECONDS`` (180 s);
  - the facts are those of ``base_sha``: a tree whose HEAD is not ``base_sha`` (or whose HEAD
    cannot be read) is ``environment_unable``;
  - success is ``verdict == "computed"`` with ``facts_sha``, ``event_facts`` and
    ``module_facts`` (each entry's JSON object, unchanged);
  - any failure of either entry (toolchain missing, timeout, environment exit, output that is not
    one JSON object) is ``environment_unable`` with a named ``witness.error`` and NO facts keys:
    there is no partial result;
  - nothing is persisted (PLAN SO-07): the call writes no file.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import plan_coverage

EVENT_ENTRY = "tools/gates/event-consumer-index.ts"
MODULE_ENTRY = "tools/aria-adapters/module-schemas-source.ts"
BASE_SHA = "b" * 40

EVENT_FACTS: dict[str, Any] = {
    "services": [
        {
            "service": "a-service",
            "events_produced": [{"event_type": "FixtureShipped", "site": "apps/a-service/src/shipper.ts:7"}],
            "events_consumed": [],
            "edges": [
                {
                    "kind": "event",
                    "to": "b-service",
                    "subject": "FixtureShipped",
                    "ref": "apps/a-service/src/shipper.ts:7",
                }
            ],
            "acl_grants": [
                {
                    "subject": "events.*.FixtureShipped",
                    "direction": "publish",
                    "ref": "infrastructure/nats/services.yaml:7",
                }
            ],
            "nats_identity": {"name": "a_service", "ref": "infrastructure/nats/services.yaml:3"},
        }
    ],
    "event_definitions": [
        {"event_type": "FixtureShipped", "site": "libs/event-contracts/src/fixture-events.ts:2"}
    ],
}
MODULE_FACTS: dict[str, Any] = {
    "services": [
        {
            "service": "farm-service",
            "schema": "farm",
            "per_tenant_tables": ["ponds"],
            "cross_tenant_tables": ["migrations"],
            "ref": "libs/backend-common/src/database/schema-manager.service.ts:395",
        }
    ]
}


def _completed(stdout: str, returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr=stderr)


class _BridgeRunner:
    """Scripted runner in plan_coverage's shape ``(cmd, cwd, timeout_seconds)``.

    ``git ... rev-parse`` answers the tree's HEAD; each facts entry answers its scripted
    result (a CompletedProcess, or an exception to raise). Any other command is a test failure.
    """

    def __init__(
        self,
        *,
        head: str | BaseException = BASE_SHA,
        event: subprocess.CompletedProcess[str] | BaseException | None = None,
        module: subprocess.CompletedProcess[str] | BaseException | None = None,
    ) -> None:
        self.head = head
        self.event = event if event is not None else _completed(json.dumps(EVENT_FACTS))
        self.module = module if module is not None else _completed(json.dumps(MODULE_FACTS))
        self.calls: list[tuple[list[str], str, int]] = []

    def __call__(self, cmd: list[str], cwd: str, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        self.calls.append((list(cmd), cwd, timeout_seconds))
        if cmd and cmd[0] == "git" and "rev-parse" in cmd:
            if isinstance(self.head, BaseException):
                raise self.head
            return _completed(self.head + "\n")
        if EVENT_ENTRY in cmd:
            result: subprocess.CompletedProcess[str] | BaseException = self.event
        elif MODULE_ENTRY in cmd:
            result = self.module
        else:
            raise AssertionError(f"the bridge ran a command it should not: {cmd}")
        if isinstance(result, BaseException):
            raise result
        return result

    def entry_calls(self, entry: str) -> list[tuple[list[str], str, int]]:
        return [call for call in self.calls if entry in call[0]]


class ServiceFactsBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workspace = self.root / "base-tree"
        self.workspace.mkdir()

    def bridge(self, runner: _BridgeRunner, *, base_sha: str = BASE_SHA) -> dict[str, Any]:
        compute = getattr(plan_coverage, "compute_service_facts", None)
        self.assertTrue(
            callable(compute),
            "plan_coverage.compute_service_facts (SE-3 kernel -> TS facts bridge) does not exist",
        )
        assert compute is not None
        result = compute(workspace_root=self.workspace, base_sha=base_sha, runner=runner)
        self.assertIsInstance(result, dict)
        return result

    def assert_held(self, result: dict[str, Any], error_token: str | None) -> None:
        self.assertEqual(result.get("verdict"), "environment_unable", result)
        for key in ("event_facts", "module_facts"):
            self.assertNotIn(key, result, f"a failed bridge run carries partial facts under {key}")
        error = (result.get("witness") or {}).get("error")
        self.assertIsInstance(error, str, result)
        self.assertTrue(error, result)
        if error_token is not None:
            self.assertIn(error_token, error)

    # ------------------------------------------------------------------ computed

    def test_both_entries_run_through_the_runner_on_the_base_tree(self) -> None:
        runner = _BridgeRunner()
        before = sorted(str(path) for path in self.root.rglob("*"))
        result = self.bridge(runner)
        self.assertEqual(result.get("verdict"), "computed", result)
        self.assertEqual(result.get("facts_sha"), BASE_SHA)
        self.assertEqual(result.get("event_facts"), EVENT_FACTS)
        self.assertEqual(result.get("module_facts"), MODULE_FACTS)
        for entry in (EVENT_ENTRY, MODULE_ENTRY):
            calls = runner.entry_calls(entry)
            self.assertEqual(len(calls), 1, f"{entry} runs once per change subject: {runner.calls}")
            cmd, cwd, timeout_seconds = calls[0]
            self.assertIn("--facts", cmd)
            self.assertEqual(Path(cwd), self.workspace)
            self.assertEqual(timeout_seconds, plan_coverage.DEFAULT_TIMEOUT_SECONDS)
        # PLAN SO-07: facts live only in the request rows; the bridge persists nothing.
        self.assertEqual(sorted(str(path) for path in self.root.rglob("*")), before)

    # ------------------------------------------------------------------ held

    def test_missing_toolchain_is_environment_unable_not_empty_facts(self) -> None:
        result = self.bridge(_BridgeRunner(event=FileNotFoundError("npx not found")))
        self.assert_held(result, "toolchain_missing")

    def test_timeout_is_environment_unable(self) -> None:
        timeout = subprocess.TimeoutExpired(cmd="npx", timeout=plan_coverage.DEFAULT_TIMEOUT_SECONDS)
        result = self.bridge(_BridgeRunner(module=timeout))
        self.assert_held(result, "timeout")

    def test_environment_exit_of_either_entry_is_environment_unable_with_no_partial_facts(self) -> None:
        refused = _completed("", returncode=2, stderr="services.yaml does not match its schema")
        self.assert_held(self.bridge(_BridgeRunner(event=refused)), "exit_2")
        self.assert_held(self.bridge(_BridgeRunner(module=refused)), "exit_2")

    def test_output_that_is_not_one_json_object_is_environment_unable(self) -> None:
        # A base tree whose tool predates the --facts entry loads the module and prints nothing.
        self.assert_held(self.bridge(_BridgeRunner(event=_completed(""))), "unparseable")
        self.assert_held(self.bridge(_BridgeRunner(module=_completed("[]"))), "unparseable")
        self.assert_held(self.bridge(_BridgeRunner(event=_completed("not json"))), "unparseable")

    def test_a_tree_not_at_the_base_sha_is_environment_unable(self) -> None:
        result = self.bridge(_BridgeRunner(head="c" * 40))
        self.assert_held(result, None)

    def test_an_unreadable_head_is_environment_unable(self) -> None:
        result = self.bridge(_BridgeRunner(head=FileNotFoundError("git not found")))
        self.assert_held(result, None)


if __name__ == "__main__":
    unittest.main()
