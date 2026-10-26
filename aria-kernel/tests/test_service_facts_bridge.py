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

    Each facts entry answers its scripted result (a CompletedProcess, or an exception to raise).
    Any other command, git included, is a test failure: the base-tree checks read git through the
    kernel's hermetic owner (``workspace_view``), never through the entry runner (SE-3-R2
    round-2 RA), so the cases run on a real fixture checkout.
    """

    def __init__(
        self,
        *,
        event: subprocess.CompletedProcess[str] | BaseException | None = None,
        module: subprocess.CompletedProcess[str] | BaseException | None = None,
    ) -> None:
        self.event = event if event is not None else _completed(json.dumps(EVENT_FACTS))
        self.module = module if module is not None else _completed(json.dumps(MODULE_FACTS))
        self.calls: list[tuple[list[str], str, int]] = []

    def __call__(self, cmd: list[str], cwd: str, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
        self.calls.append((list(cmd), cwd, timeout_seconds))
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
        # A real clean checkout: the tree checks read its HEAD and status through the kernel's
        # hermetic git owner; only the two entries are scripted.
        self.workspace = make_repo_with_initial_commit(
            self.root / "base-tree", {".gitignore": "/node_modules\n", "README.md": "base tree\n"}
        )
        self.head = _git_out(self.workspace, "rev-parse", "HEAD")

    def bridge(self, runner: _BridgeRunner, *, base_sha: str | None = None) -> dict[str, Any]:
        compute = getattr(plan_coverage, "compute_service_facts", None)
        self.assertTrue(
            callable(compute),
            "plan_coverage.compute_service_facts (SE-3 kernel -> TS facts bridge) does not exist",
        )
        assert compute is not None
        result = compute(
            workspace_root=self.workspace, base_sha=self.head if base_sha is None else base_sha, runner=runner
        )
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
        self.assertEqual(result.get("facts_sha"), self.head)
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
        result = self.bridge(_BridgeRunner(), base_sha="c" * 40)
        self.assert_held(result, None)

    def test_an_unreadable_head_is_environment_unable(self) -> None:
        # A base tree that is no git checkout has no HEAD to read.
        self.workspace = self.root / "not-a-checkout"
        self.workspace.mkdir()
        result = self.bridge(_BridgeRunner(), base_sha=BASE_SHA)
        self.assert_held(result, "head_unreadable")

    def test_the_workspace_head_entry_computes_the_facts_of_the_checkouts_own_head(self) -> None:
        result = plan_coverage.compute_service_facts_at_head(workspace_root=self.workspace, runner=_BridgeRunner())
        self.assertEqual(result.get("verdict"), "computed", result)
        self.assertEqual(result["facts_sha"], self.head)

    def test_the_workspace_head_entry_holds_a_checkout_git_cannot_read_instead_of_raising(self) -> None:
        # ``workspace_view.workspace_head_sha`` raises on a git failure (PV R4), and this entry's
        # callers (the cycle's service examination, plan admission, the impact CLI, the learning
        # sweep) hold a change on a named ``environment_unable``, never on an exception: the
        # entry's own contract is ``head_unreadable``. A ``.git`` file naming a missing gitdir is
        # a checkout whose HEAD git cannot answer.
        broken = self.root / "broken-checkout"
        broken.mkdir()
        (broken / ".git").write_text(f"gitdir: {self.root / 'missing-gitdir'}\n", encoding="utf-8")
        result = plan_coverage.compute_service_facts_at_head(workspace_root=broken, runner=_BridgeRunner())
        self.assert_held(result, "head_unreadable")


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
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)  # allowlist-external-network: loopback-only listener (bound to 127.0.0.1 below) that stands in for the npm registry to prove the bridge makes no fetch
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
    """The two entries stay scripted on a real fixture checkout, whose git the bridge reads itself.

    ``during_event`` runs while the event entry "runs", to change the tree between the
    bridge's checks (an implementer writing into the worktree, a checkout moving HEAD).
    """

    def __init__(self, *, during_event: Any = None) -> None:
        super().__init__()
        self.during_event = during_event

    def __call__(self, cmd: list[str], cwd: str, timeout_seconds: int) -> subprocess.CompletedProcess[str]:
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
        workspace, head = self.checkout()
        runner = _BridgeRunner()
        result = self.compute(workspace, head, runner=runner)
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


# ---------------------------------------------------------------------------------------------
# SE-3-R2 corrective round 1 (build/SE-3-R2/appellate-r1.md):
# - R1: ``git status`` hides ignored paths and empty directories, while both entries read the
#   disk. An ignored file under a scanned src root (the repo ignores tmp, build, dist… at any
#   depth), an empty apps/<dir> or an ignored-only one became facts stamped ``facts_sha =
#   base_sha``. The entries now enumerate the tree's tracked files, so such content never reaches
#   the facts; the ignored root node_modules control still computes.
# - R2: the SE-1 key reader followed a tracked symlinked apps/<dir>/project.json out of the tree,
#   and Node's JSON error carried the target's first bytes into ``witness.stderr_tail``.
# ---------------------------------------------------------------------------------------------

_SMALL_EVENTS = ["SmallFixtureShipped"]
_SMALL_SERVICES = ["small-service-000"]
_OUTSIDE_MARKER = "ZQXJ-outside-marker-7c41"


class ServiceFactsCorrectiveRoundOneTests(unittest.TestCase):
    """The roots the SE-3-R2 appellate accepted, on the real entries through the real runner."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-se3-r2c1-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        environment = patch.dict(
            os.environ, _hermetic_node_environment(self.root / "env", "http://127.0.0.1:9/"), clear=True
        )
        environment.start()
        self.addCleanup(environment.stop)

    def base_tree(self, gitignore: str) -> Path:
        files = _facts_tree(_SMALL_EVENTS, _SMALL_SERVICES)
        files[".gitignore"] = gitignore
        for path in (*tool_closure_paths(EVENT_ENTRY, MODULE_ENTRY), plan_coverage.WITNESS_TSCONFIG, NATS_SCHEMA):
            files[path] = (REPO_ROOT / path).read_text(encoding="utf-8")
        repo = make_repo_with_initial_commit(self.root / "trees", files)
        (repo / "node_modules").symlink_to(installed_node_modules("typescript", "ts-node", "yaml", "ajv"),
                                           target_is_directory=True)
        return repo

    def compute(self, repo: Path) -> dict[str, Any]:
        head = _git_out(repo, "rev-parse", "HEAD")
        self.assertEqual(_git_out(repo, "status", "--porcelain", "--untracked-files=all"), "")
        result = plan_coverage.compute_service_facts(workspace_root=repo, base_sha=head)
        self.assertIsInstance(result, dict)
        return result

    def test_ignored_files_and_app_dirs_without_tracked_files_never_reach_the_facts(self) -> None:
        repo = self.base_tree("/node_modules\ntmp\nbuild\n")
        planted = repo / "apps" / "producer-service" / "src" / "tmp" / "planted.ts"
        planted.parent.mkdir(parents=True)
        planted.write_text(
            "import { createBaseEvent } from '../../../../libs/event-contracts/src/base-event';\n"
            "export const planted = createBaseEvent('PlantedIgnored', 'tenant-1');\n",
            encoding="utf-8",
        )
        (repo / "apps" / "ghost-service" / "src").mkdir(parents=True)
        (repo / "apps" / "build").mkdir()
        (repo / "apps" / "build" / "project.json").write_text(
            json.dumps({"name": "phantom-build-service"}), encoding="utf-8"
        )
        ignored = _git_out(repo, "status", "--porcelain", "--ignored=matching", "--untracked-files=all")
        # git collapses an ignored directory to its name.
        self.assertIn("!! apps/producer-service/src/tmp/", ignored)
        self.assertIn("!! apps/build/", ignored)

        result = self.compute(repo)

        self.assertEqual(result.get("verdict"), "computed", result.get("witness"))
        dumped = json.dumps(result)
        for planted_fact in ("PlantedIgnored", "tmp/planted.ts", "ghost-service", "phantom-build-service"):
            self.assertNotIn(planted_fact, dumped)
        self.assertEqual(
            sorted(service["service"] for service in result["event_facts"]["services"]),
            sorted(["producer-service", "consumer-service", "db-migrate", *_SMALL_SERVICES]),
        )

    def test_a_tracked_project_json_linking_out_of_the_tree_is_held_and_leaks_nothing(self) -> None:
        repo = self.base_tree("/node_modules\n")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "marker.txt").write_text(f"{_OUTSIDE_MARKER}\n", encoding="utf-8")
        (repo / "apps" / "x-service").mkdir()
        (repo / "apps" / "x-service" / "project.json").symlink_to(outside / "marker.txt")
        for args in (("add", "apps/x-service/project.json"),
                     ("-c", "user.email=fixture@aria.test", "-c", "user.name=Aria Fixture",
                      "commit", "-q", "-m", "a tracked symlink under apps/")):
            subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
        self.assertTrue(_git_out(repo, "ls-files", "-s", "apps/x-service/project.json").startswith("120000 "))

        result = self.compute(repo)

        self.assertEqual(result.get("verdict"), "environment_unable", result)
        for key in ("event_facts", "module_facts", "facts_sha"):
            self.assertNotIn(key, result)
        witness = result.get("witness") or {}
        self.assertIn("SourceTreeUnavailable", json.dumps(witness))
        self.assertIn("apps/x-service/project.json", json.dumps(witness))
        self.assertNotIn(_OUTSIDE_MARKER[:4], json.dumps(result))


# ---------------------------------------------------------------------------------------------
# SE-3-R2 corrective round 2 (build/SE-3-R2/appellate-r2.md):
# - RA: ``_base_tree_error`` read HEAD and ``git status`` through the injectable entry runner, which
#   inherits GIT_DIR / GIT_INDEX_FILE and the repository's fsmonitor, and ``git status`` does not
#   compare a tracked file flagged assume-unchanged or skip-worktree with the disk. Either way the
#   bridge computed over content that is not in the base commit and stamped it ``facts_sha =
#   base_sha``. The tree checks now run only through the kernel's hermetic git owner
#   (``workspace_view``), and a flagged index entry is refused by name (``tree_index_flagged``).
# - RB: the entries enumerated the tracked set, but the type checker resolved imports on the
#   default compiler host, so an ignored, symlinked-directory or absolute-path module that a
#   tracked file imports became facts. The checker now sees only the tracked tree, the workspace
#   node_modules and the TypeScript lib directory.
# ---------------------------------------------------------------------------------------------

_PLANTED_FLAGGED = "PlantedViaFlaggedIndex"
_PLANTED_INDEX = "PlantedViaIndex"
_PLANTED_IMPORT = "PlantedViaIgnoredImport"
_PRODUCER = "apps/producer-service/src/producer.ts"
_VIA_IMPORT = "apps/producer-service/src/via-import.ts"


def _hermetic_git_out(repo: Path, *args: str) -> str:
    """git as the kernel's owner runs it: no inherited GIT_* variable, no fsmonitor."""
    environment = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    return subprocess.run(
        ["git", "-c", "core.fsmonitor=false", *args],
        cwd=repo, check=True, capture_output=True, text=True, env=environment,
    ).stdout.strip()


def _via_import_source(specifier: str) -> str:
    """A tracked producer whose event type comes from ``specifier``; the type is on line 3."""
    return "".join([
        "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';\n",
        f"import {{ PLANTED_TYPE }} from '{specifier}';\n",
        "export const viaImport = createBaseEvent(PLANTED_TYPE, 'tenant-1');\n",
    ])


class ServiceFactsCorrectiveRoundTwoTests(unittest.TestCase):
    """RA and RB of the SE-3-R2 round-2 appellate, on the real entries through the real runner."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-se3-r2c2-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        environment = patch.dict(
            os.environ, _hermetic_node_environment(self.root / "env", "http://127.0.0.1:9/"), clear=True
        )
        environment.start()
        self.addCleanup(environment.stop)

    def base_tree(self, gitignore: str = "/node_modules\ntmp\n", extra: dict[str, str] | None = None) -> Path:
        files = _facts_tree(_SMALL_EVENTS, _SMALL_SERVICES)
        files[".gitignore"] = gitignore
        files.update(extra or {})
        for path in (*tool_closure_paths(EVENT_ENTRY, MODULE_ENTRY), plan_coverage.WITNESS_TSCONFIG, NATS_SCHEMA):
            files[path] = (REPO_ROOT / path).read_text(encoding="utf-8")
        repo = make_repo_with_initial_commit(self.root / "trees", files)
        (repo / "node_modules").symlink_to(installed_node_modules("typescript", "ts-node", "yaml", "ajv"),
                                           target_is_directory=True)
        return repo

    def compute(self, repo: Path, head: str) -> dict[str, Any]:
        result = plan_coverage.compute_service_facts(workspace_root=repo, base_sha=head)
        self.assertIsInstance(result, dict)
        return result

    def assert_held_without(self, result: dict[str, Any], error_token: str, *absent: str) -> None:
        self.assertEqual(result.get("verdict"), "environment_unable", result)
        for key in ("event_facts", "module_facts", "facts_sha"):
            self.assertNotIn(key, result, f"a held bridge run carries {key}")
        error = (result.get("witness") or {}).get("error")
        self.assertIsInstance(error, str, result)
        self.assertIn(error_token, error)
        dumped = json.dumps(result)
        for text in absent:
            self.assertNotIn(text, dumped)

    # ------------------------------------------------------------ RA: index flags

    def flagged_rewrite(self, flag: str) -> tuple[Path, str]:
        repo = self.base_tree()
        head = _git_out(repo, "rev-parse", "HEAD")
        subprocess.run(["git", "update-index", flag, _PRODUCER], cwd=repo, check=True, capture_output=True)
        (repo / _PRODUCER).write_text(
            "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';\n"
            f"export const planted = createBaseEvent('{_PLANTED_FLAGGED}', 'tenant-1');\n",
            encoding="utf-8",
        )
        # Precondition: the flag hides the rewrite from git status, as the owner itself runs it.
        self.assertEqual(_hermetic_git_out(repo, "status", "--porcelain", "--untracked-files=all"), "")
        return repo, head

    def test_an_assume_unchanged_rewrite_of_a_tracked_file_is_held_by_name(self) -> None:
        repo, head = self.flagged_rewrite("--assume-unchanged")
        self.assert_held_without(self.compute(repo, head), "tree_index_flagged", _PLANTED_FLAGGED)

    def test_a_skip_worktree_rewrite_of_a_tracked_file_is_held_by_name(self) -> None:
        repo, head = self.flagged_rewrite("--skip-worktree")
        self.assert_held_without(self.compute(repo, head), "tree_index_flagged", _PLANTED_FLAGGED)

    # ------------------------------------------------- RA: ambient git environment

    def force_added_planted(self) -> tuple[Path, str]:
        """The base tree with an ignored producer force-added to its real index."""
        repo = self.base_tree()
        head = _git_out(repo, "rev-parse", "HEAD")
        planted = repo / "apps" / "producer-service" / "src" / "tmp" / "planted.ts"
        planted.parent.mkdir(parents=True)
        planted.write_text(
            "import { createBaseEvent } from '../../../../libs/event-contracts/src/base-event';\n"
            f"export const planted = createBaseEvent('{_PLANTED_INDEX}', 'tenant-1');\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "-f", str(planted)], cwd=repo, check=True, capture_output=True)
        return repo, head

    def test_an_ambient_git_index_file_does_not_hide_a_force_added_file(self) -> None:
        repo, head = self.force_added_planted()
        alternate = self.root / "alternate-index"
        subprocess.run(["git", "read-tree", "HEAD"], cwd=repo, check=True, capture_output=True,
                       env={**os.environ, "GIT_INDEX_FILE": str(alternate)})
        with patch.dict(os.environ, {"GIT_INDEX_FILE": str(alternate)}):
            # Precondition: under the ambient index, git status sees a clean tree.
            self.assertEqual(_git_out(repo, "status", "--porcelain", "--untracked-files=all"), "")
            result = self.compute(repo, head)
        self.assert_held_without(result, "tree_not_clean", _PLANTED_INDEX, "tmp/planted.ts")

    def test_an_ambient_git_dir_at_another_repository_at_base_does_not_vouch_for_the_tree(self) -> None:
        repo, head = self.force_added_planted()
        other = self.root / "other"
        subprocess.run(["git", "clone", "-q", str(repo), str(other)], check=True, capture_output=True)
        self.assertEqual(_git_out(other, "rev-parse", "HEAD"), head)
        with patch.dict(os.environ, {"GIT_DIR": str(other / ".git")}):
            # Precondition: under the ambient GIT_DIR, HEAD is the base and git status is clean.
            self.assertEqual(_git_out(repo, "rev-parse", "HEAD"), head)
            self.assertEqual(_git_out(repo, "status", "--porcelain", "--untracked-files=all"), "")
            result = self.compute(repo, head)
        self.assert_held_without(result, "tree_not_clean", _PLANTED_INDEX, "tmp/planted.ts")

    def test_plan_coverage_builds_no_git_argv_of_its_own(self) -> None:
        # The tree checks and the HEAD read go through the kernel's hermetic git owner
        # (workspace_view), never through an argv this module spells and an injectable runner runs.
        import ast

        source = Path(plan_coverage.__file__).read_text(encoding="utf-8")
        spelled = [
            node.lineno
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Constant) and node.value == "git"
        ]
        self.assertEqual(spelled, [], f"plan_coverage.py spells a git argv at lines {spelled}")

    # ------------------------------------------- RB: imports outside the tracked tree

    def assert_import_outside_the_tree_is_no_fact(self, repo: Path, plant: Any) -> None:
        head = _git_out(repo, "rev-parse", "HEAD")
        before = self.compute(repo, head)
        self.assertEqual(before.get("verdict"), "computed", before.get("witness"))
        plant()
        self.assertEqual(_hermetic_git_out(repo, "status", "--porcelain", "--untracked-files=all"), "")
        after = self.compute(repo, head)
        self.assertEqual(after.get("verdict"), "computed", after.get("witness"))
        self.assertEqual(json.dumps(after["event_facts"], sort_keys=True),
                         json.dumps(before["event_facts"], sort_keys=True))
        self.assertIn(
            {"application": "producer-service", "site": f"{_VIA_IMPORT}:3", "form": "PLANTED_TYPE"},
            after["event_facts"]["unresolved"]["produced"],
        )
        self.assertNotIn(_PLANTED_IMPORT, json.dumps(after))

    def test_an_ignored_module_a_tracked_file_imports_is_no_fact(self) -> None:
        repo = self.base_tree(extra={_VIA_IMPORT: _via_import_source("./tmp/value")})

        def plant() -> None:
            value = repo / "apps" / "producer-service" / "src" / "tmp" / "value.ts"
            value.parent.mkdir(parents=True)
            value.write_text(f"export const PLANTED_TYPE = '{_PLANTED_IMPORT}' as const;\n", encoding="utf-8")

        self.assert_import_outside_the_tree_is_no_fact(repo, plant)

    def test_a_module_behind_an_ignored_directory_symlink_is_no_fact(self) -> None:
        repo = self.base_tree(extra={_VIA_IMPORT: _via_import_source("./tmp/value")})
        outside = self.root / "outside-dir"

        def plant() -> None:
            outside.mkdir()
            (outside / "value.ts").write_text(
                f"export const PLANTED_TYPE = '{_PLANTED_IMPORT}' as const;\n", encoding="utf-8"
            )
            (repo / "apps" / "producer-service" / "src" / "tmp").symlink_to(outside, target_is_directory=True)

        self.assert_import_outside_the_tree_is_no_fact(repo, plant)

    def test_a_module_at_an_absolute_path_outside_the_tree_is_no_fact(self) -> None:
        outside = self.root / "outside-absolute"
        repo = self.base_tree(extra={_VIA_IMPORT: _via_import_source(str(outside / "value"))})

        def plant() -> None:
            outside.mkdir()
            (outside / "value.ts").write_text(
                f"export const PLANTED_TYPE = '{_PLANTED_IMPORT}' as const;\n", encoding="utf-8"
            )

        self.assert_import_outside_the_tree_is_no_fact(repo, plant)


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
    return _facts_tree(_BULK_EVENTS, _BULK_SERVICES)


def _facts_tree(events: list[str], services: list[str]) -> dict[str, str]:
    """A base tree both real entries compute on: ``events`` each defined, produced by
    producer-service and consumed by consumer-service; ``services`` each an nx application that
    owns a MODULE_SCHEMAS module of 40 tables through SCHEMA_REGISTRY."""
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
                for name in events
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
            *[f"    await this.bus.publish(createBaseEvent('{name}', tenantId));" for name in events],
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
            *[f"    await this.bus.subscribeWildcard('{name}', this);" for name in events],
            "  }",
            "}",
            "",
        ]),
        "infrastructure/nats/services.yaml": "\n".join([
            "version: 1",
            "services:",
            *_nats_entry("producer_service", [f"events.*.{events[0]}"], []),
            *_nats_entry("consumer_service", [], []),
            "",
        ]),
        "apps/db-migrate/project.json": json.dumps({"name": "db-migrate"}),
    }
    modules: list[str] = []
    registry: list[str] = []
    for index, service in enumerate(services):
        schema = f"bulk_{index:03d}"
        tables = ", ".join(f"'{schema}_fixture_table_{table:02d}'" for table in range(40))
        modules.append(
            f"  {{ moduleName: '{schema}', sourceSchema: '{schema}', infrastructureTables: ['{schema}_outbox'], "
            f"tables: [{tables}] }},"
        )
        registry.append(f"  {{ service: '{service}', schema: '{schema}', migrationsGlob: [], reason: 'fixture' }},")
        files[f"apps/{service}/project.json"] = json.dumps({"name": service})
        files[f"apps/{service}/src/main.ts"] = "export const started = true;\n"
    scoped = ", ".join(f"'bulk_{index:03d}'" for index in range(0, len(services), 2))
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
