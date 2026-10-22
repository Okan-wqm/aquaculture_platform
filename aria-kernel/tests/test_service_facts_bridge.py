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
import os
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import plan_coverage
from tests._helpers.git_fixtures import make_repo_with_initial_commit
from tests._helpers.node_modules import installed_node_modules
from tests._helpers.witness_sources import REPO_ROOT, tool_closure_paths

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

    ``git ... rev-parse`` answers the tree's HEAD, ``git ... status`` answers a clean tree; each
    facts entry answers its scripted result (a CompletedProcess, or an exception to raise). Any
    other command is a test failure.
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
        if cmd and cmd[0] == "git" and "status" in cmd:
            # SE-3-R2: a scripted base tree is clean (no tracked change, no untracked file).
            return _completed("")
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


# ---------------------------------------------------------------------------------------------
# SE-3 review round 1 blockers (build/SE-3/review-r1-blockers.md), pinned before round 2.
#
# - npx escape (security B2): the runner ran ``npx ts-node`` in the base tree. With no
#   ``node_modules`` there, npx 10 does not raise FileNotFoundError: it fetches an unpinned
#   ts-node from the registry and runs it with the kernel's environment. The entry is the base
#   tree's own ``node_modules/.bin/ts-node``; without it the run is ``toolchain_missing``.
# - dirty-tree facts (security B3 = architecture B1): HEAD == base_sha was the only provenance
#   check, while both entries read the working tree. A tracked change or an untracked file, before
#   or during the runs, would become a fact stamped ``facts_sha = base_sha``: ``tree_not_clean``.
# - pipe truncation (security B1): both entries ``process.exit`` right after writing stdout, so a
#   pipe reader gets the first 64 KiB of the ~541 KB live event facts and every change is held.
#   The native case runs both real entries through the real runner on outputs above 64 KiB.
# ---------------------------------------------------------------------------------------------

PIPE_BUFFER_BYTES = 64 * 1024
NATS_SCHEMA = "infrastructure/nats/services.schema.json"


def _git_out(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _hermetic_node_environment(scratch: Path, registry: str) -> dict[str, str]:
    """The process environment for a native entry run: no ARIA/NX/npm settings of the host, an
    empty npm cache, and a registry the test owns, so no case can reach a public registry."""
    values = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith(("ARIA_", "NX_", "npm_config_", "NPM_CONFIG_"))
        and name != "NODE_OPTIONS"
    }
    (scratch / "npm-cache").mkdir(parents=True, exist_ok=True)
    (scratch / "tmp").mkdir(parents=True, exist_ok=True)
    values.update(
        {
            "npm_config_cache": str(scratch / "npm-cache"),
            "npm_config_registry": registry,
            "npm_config_fetch_retries": "0",
            "npm_config_fetch_timeout": "3000",
            "npm_config_update_notifier": "false",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
            "TMPDIR": str(scratch / "tmp"),
        }
    )
    return values


class _RecordingRegistry:
    """A TCP listener on 127.0.0.1 that records every connection and closes it at once.

    Pointed to as the npm registry, it shows whether a run tried to fetch a package: the
    bridge has no registry fallback, so it must record nothing.
    """

    def __init__(self) -> None:
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(16)
        self.server.settimeout(0.2)
        self.connections = 0
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.getsockname()[1]}/"

    def _serve(self) -> None:
        while not self.stopped.is_set():
            try:
                connection, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.connections += 1
            connection.close()

    def close(self) -> None:
        self.stopped.set()
        self.thread.join(timeout=2)
        self.server.close()


class _TreeRunner(_BridgeRunner):
    """Git runs for real in the fixture checkout; the two entries stay scripted.

    ``during_event`` runs while the event entry "runs", to change the tree between the
    bridge's checks (an implementer writing into the worktree, a checkout moving HEAD).
    """

    def __init__(self, *, during_event: Any = None) -> None:
        super().__init__()
        self.during_event = during_event

    def __call__(self, cmd: list[str], cwd: str, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        if cmd and cmd[0] == "git":
            self.calls.append((list(cmd), cwd, timeout_seconds))
            return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout_seconds)
        if EVENT_ENTRY in cmd and self.during_event is not None:
            self.during_event()
        return super().__call__(cmd, cwd, timeout_seconds)


class ServiceFactsReviewRoundOneTests(unittest.TestCase):
    """The behaviour defects of the SE-3 round-1 review, red at the round-1 head by assertion."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-se3-r2-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def compute(self, workspace: Path, base_sha: str, **kwargs: Any) -> dict[str, Any]:
        result = plan_coverage.compute_service_facts(workspace_root=workspace, base_sha=base_sha, **kwargs)
        self.assertIsInstance(result, dict)
        return result

    def assert_held(self, result: dict[str, Any], error_token: str | None) -> None:
        self.assertEqual(result.get("verdict"), "environment_unable", result)
        for key in ("event_facts", "module_facts", "facts_sha"):
            self.assertNotIn(key, result, f"a held bridge run carries {key}")
        error = (result.get("witness") or {}).get("error")
        self.assertIsInstance(error, str, result)
        if error_token is not None:
            self.assertIn(error_token, error)

    def checkout(self) -> tuple[Path, str]:
        """A clean checkout at its base commit; ``node_modules`` is ignored, as on every base tree."""
        repo = make_repo_with_initial_commit(
            self.root / "trees",
            {
                ".gitignore": "/node_modules\n",
                "apps/a-service/project.json": json.dumps({"name": "a-service"}),
                "apps/a-service/src/shipper.ts": "export const shipped = 'FixtureShipped';\n",
            },
        )
        (repo / "node_modules" / ".bin").mkdir(parents=True)
        return repo, _git_out(repo, "rev-parse", "HEAD")

    # ------------------------------------------------------------- npx escape (security B2)

    def test_each_entry_runs_the_base_tree_own_ts_node_never_npx(self) -> None:
        workspace = self.root / "base-tree"
        workspace.mkdir()
        runner = _BridgeRunner()
        result = self.compute(workspace, BASE_SHA, runner=runner)
        self.assertEqual(result.get("verdict"), "computed", result)
        for entry in (EVENT_ENTRY, MODULE_ENTRY):
            calls = runner.entry_calls(entry)
            self.assertEqual(len(calls), 1, runner.calls)
            cmd, cwd, _ = calls[0]
            self.assertNotIn("npx", cmd, f"{entry} runs through npx, which falls back to the registry")
            self.assertEqual(
                Path(cwd) / cmd[0],
                workspace / "node_modules" / ".bin" / "ts-node",
                f"{entry} must run the base tree's own ts-node: {cmd}",
            )

    def test_a_base_tree_without_node_modules_is_toolchain_missing_and_reaches_no_registry(self) -> None:
        repo = make_repo_with_initial_commit(
            self.root / "trees", {".gitignore": "/node_modules\n", "README.md": "no install\n"}
        )
        head = _git_out(repo, "rev-parse", "HEAD")
        registry = _RecordingRegistry()
        self.addCleanup(registry.close)
        environment = patch.dict(os.environ, _hermetic_node_environment(self.root / "env", registry.url), clear=True)
        environment.start()
        self.addCleanup(environment.stop)

        result = self.compute(repo, head, timeout_seconds=90)

        self.assertEqual(registry.connections, 0, "the bridge fetched from a package registry")
        self.assert_held(result, "toolchain_missing")

    # ------------------------------------------------------ dirty-tree facts (security B3, arch B1)

    def test_a_clean_checkout_at_base_computes_and_ignored_files_do_not_count(self) -> None:
        # Control: the real base tree carries an ignored node_modules; that is not a dirty tree.
        repo, head = self.checkout()
        result = self.compute(repo, head, runner=_TreeRunner())
        self.assertEqual(result.get("verdict"), "computed", result)
        self.assertEqual(result.get("facts_sha"), head)

    def test_an_untracked_file_in_the_base_tree_is_tree_not_clean(self) -> None:
        repo, head = self.checkout()
        (repo / "apps" / "a-service" / "src" / "planted.ts").write_text(
            "export const planted = 'not at base';\n", encoding="utf-8"
        )
        self.assert_held(self.compute(repo, head, runner=_TreeRunner()), "tree_not_clean")

    def test_a_modified_tracked_file_in_the_base_tree_is_tree_not_clean(self) -> None:
        repo, head = self.checkout()
        (repo / "apps" / "a-service" / "src" / "shipper.ts").write_text(
            "export const shipped = 'Edited';\n", encoding="utf-8"
        )
        self.assert_held(self.compute(repo, head, runner=_TreeRunner()), "tree_not_clean")

    def test_a_tree_changed_while_the_entries_run_is_tree_not_clean(self) -> None:
        repo, head = self.checkout()

        def plant() -> None:
            (repo / "apps" / "a-service" / "src" / "during.ts").write_text(
                "export const during = true;\n", encoding="utf-8"
            )

        self.assert_held(self.compute(repo, head, runner=_TreeRunner(during_event=plant)), "tree_not_clean")

    def test_a_head_that_moves_while_the_entries_run_is_environment_unable(self) -> None:
        repo, head = self.checkout()

        def move() -> None:
            subprocess.run(
                ["git", "-c", "user.email=fixture@aria.test", "-c", "user.name=Aria Fixture",
                 "commit", "-q", "--allow-empty", "-m", "moved"],
                cwd=repo, check=True, capture_output=True,
            )

        self.assert_held(self.compute(repo, head, runner=_TreeRunner(during_event=move)), None)

    # ---------------------------------------------------------- pipe truncation (security B1)

    def test_entry_outputs_larger_than_a_pipe_buffer_reach_the_kernel_whole(self) -> None:
        files = _large_facts_tree()
        for path in (*tool_closure_paths(EVENT_ENTRY, MODULE_ENTRY), plan_coverage.WITNESS_TSCONFIG, NATS_SCHEMA):
            files[path] = (REPO_ROOT / path).read_text(encoding="utf-8")
        repo = make_repo_with_initial_commit(self.root / "trees", files)
        (repo / "node_modules").symlink_to(installed_node_modules("typescript", "ts-node", "yaml", "ajv"),
                                           target_is_directory=True)
        head = _git_out(repo, "rev-parse", "HEAD")
        self.assertEqual(_git_out(repo, "status", "--porcelain", "--untracked-files=all"), "")
        environment = patch.dict(
            os.environ, _hermetic_node_environment(self.root / "env", "http://127.0.0.1:9/"), clear=True
        )
        environment.start()
        self.addCleanup(environment.stop)

        # The real runner: subprocess pipes, exactly as the kernel reads the entries.
        result = self.compute(repo, head)

        self.assertEqual(result.get("verdict"), "computed", result.get("witness"))
        event_facts = result["event_facts"]
        module_facts = result["module_facts"]
        self.assertGreater(len(json.dumps(event_facts)), PIPE_BUFFER_BYTES)
        self.assertGreater(len(json.dumps(module_facts)), PIPE_BUFFER_BYTES)
        produced = {
            fact["event_type"]
            for service in event_facts["services"]
            if service["service"] == "producer-service"
            for fact in service["events_produced"]
        }
        self.assertEqual(produced, set(_BULK_EVENTS))
        self.assertEqual(
            sorted(entry["service"] for entry in module_facts["services"]), sorted(_BULK_SERVICES)
        )


_BULK_EVENTS = [f"BulkFixtureEvent{index:04d}" for index in range(700)]
_BULK_SERVICES = [f"bulk-service-{index:03d}" for index in range(120)]


def _nats_entry(name: str, publish: list[str], subscribe: list[str]) -> list[str]:
    """One services.yaml entry with the schema's grant minimums (as the gates spec writes it)."""
    return [
        f"  - name: {name}",
        f"    application: {name.replace('_', '-')}",
        f"    description: fixture identity of {name}",
        "    publish:",
        *[f"      - {grant}" for grant in [*publish, "$JS.API.>", "$JS.ACK.>", "_INBOX.>"]],
        "    subscribe:",
        *[f"      - {grant}" for grant in [*subscribe, "$JS.API.>", f"_INBOX{name.upper()}.>"]],
    ]


def _large_facts_tree() -> dict[str, str]:
    """A base tree whose event facts and module facts are each well above 64 KiB.

    700 event interfaces, one producer-service emitting each and one consumer-service
    subscribing to each (event facts); 120 SCHEMA_REGISTRY services, each an nx application
    with TypeScript sources, owning a MODULE_SCHEMAS module of 40 tables (module facts).
    """
    files: dict[str, str] = {
        ".gitignore": "/node_modules\n",
        "package.json": json.dumps({"name": "se3-pipe-fixture", "private": True}),
        "tsconfig.base.json": json.dumps({"compilerOptions": {}}),
        "platform/libs/event-bus/src/event-bus.ts": "\n".join([
            "export interface IEventBus {",
            "  publish<TEvent extends { readonly eventType: string }>(event: TEvent): Promise<void>;",
            "  subscribeWildcard(eventType: string, handler: object): Promise<void>;",
            "}",
            "",
        ]),
        "libs/event-contracts/src/base-event.ts": "\n".join([
            "export interface BaseEvent {",
            "  readonly eventId: string;",
            "  readonly eventType: string;",
            "  readonly tenantId: string;",
            "}",
            "export function createBaseEvent<T extends BaseEvent>(",
            "  eventType: T['eventType'],",
            "  tenantId: string,",
            "): BaseEvent & { readonly eventType: T['eventType'] } {",
            "  return { eventId: 'fixture-id', eventType, tenantId };",
            "}",
            "",
        ]),
        "libs/event-contracts/src/bulk-events.ts": "\n".join([
            "import type { BaseEvent } from './base-event';",
            *[
                f"export interface {name}Event extends BaseEvent {{ readonly eventType: '{name}' }}"
                for name in _BULK_EVENTS
            ],
            "",
        ]),
        "apps/producer-service/project.json": json.dumps({"name": "producer-service"}),
        "apps/producer-service/src/producer.ts": "\n".join([
            "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
            "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';",
            "export class Producer {",
            "  constructor(private readonly bus: IEventBus) {}",
            "  async emitAll(tenantId: string): Promise<void> {",
            *[f"    await this.bus.publish(createBaseEvent('{name}', tenantId));" for name in _BULK_EVENTS],
            "  }",
            "}",
            "",
        ]),
        "apps/consumer-service/project.json": json.dumps({"name": "consumer-service"}),
        "apps/consumer-service/src/listener.ts": "\n".join([
            "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
            "export class Listener {",
            "  constructor(private readonly bus: IEventBus) {}",
            "  async start(): Promise<void> {",
            *[f"    await this.bus.subscribeWildcard('{name}', this);" for name in _BULK_EVENTS],
            "  }",
            "}",
            "",
        ]),
        "infrastructure/nats/services.yaml": "\n".join([
            "version: 1",
            "services:",
            *_nats_entry("producer_service", ["events.*.BulkFixtureEvent0000"], []),
            *_nats_entry("consumer_service", [], []),
            "",
        ]),
        "apps/db-migrate/project.json": json.dumps({"name": "db-migrate"}),
    }
    modules: list[str] = []
    registry: list[str] = []
    for index, service in enumerate(_BULK_SERVICES):
        schema = f"bulk_{index:03d}"
        tables = ", ".join(f"'{schema}_fixture_table_{table:02d}'" for table in range(40))
        modules.append(
            f"  {{ moduleName: '{schema}', sourceSchema: '{schema}', infrastructureTables: ['{schema}_outbox'], "
            f"tables: [{tables}] }},"
        )
        registry.append(f"  {{ service: '{service}', schema: '{schema}', migrationsGlob: [], reason: 'fixture' }},")
        files[f"apps/{service}/project.json"] = json.dumps({"name": service})
        files[f"apps/{service}/src/main.ts"] = "export const started = true;\n"
    scoped = ", ".join(f"'bulk_{index:03d}'" for index in range(0, len(_BULK_SERVICES), 2))
    files["libs/backend-common/src/database/schema-manager.service.ts"] = "\n".join([
        "export const MODULE_SCHEMAS = [",
        *modules,
        "];",
        f"export const TENANT_SCOPED_MODULES: ReadonlySet<string> = new Set([{scoped}]);",
        "",
    ])
    files["apps/db-migrate/src/schema-registry.ts"] = "\n".join([
        "export const SCHEMA_REGISTRY = [", *registry, "];", ""
    ])
    return files


if __name__ == "__main__":
    unittest.main()
