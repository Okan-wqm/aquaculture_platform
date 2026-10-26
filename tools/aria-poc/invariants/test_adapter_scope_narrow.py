"""Plan 022 §C-7/§C-8 follow-up — adapter scope invariants.

Pins the iteration surfaces of the outbox + agent-harness-security adapters
to their manifest declarations.

ARIA-MEDIUM-379 — the outbox adapter's scope is application source
(`apps/*/src/**/*.ts`), not the outbox directories. Reading only the outbox
directories (the Plan 022 narrowing) made both of its former rules judge the
outbox machinery itself: all three hits on main were false positives, and the
domain code where a raw publish is the defect was never read. The scope is
still pinned to the manifest, and libraries, tests, migrations and the outbox
implementation stay out of it.

These tests guarantee:

* `outbox_adapter.SCANNED_GLOBS` (and its `_FALLBACK_SCANNED_GLOBS` alias)
  match the manifest (`tools/aria-adapters/outbox-adapter.tool.json`)
  exactly, and never widen to libraries;
* `outbox_adapter._iter_files` walks application source only, in fallback
  mode and in kernel-injection mode (`allowed_paths` supplied), and an empty
  kernel list means no walk;
* the rule flags a raw publish in a transactional write path of a service
  that registers the outbox, and nothing else (true- and false-positive
  fixtures);
* `cqrs_adapter.SCANNED_GLOBS` matches its manifest, and the cqrs and outbox
  adapters skip the same non-production sources (specs, `__tests__`, `.test.ts`,
  migrations) through ONE shared predicate, not two private lists (DET-RCA B18);
* `agent_harness_security_adapter.SCANNED_GLOBS` matches its manifest.

Test isolation: each test creates a tempdir fixture repo with `package.json`
(the marker `_resolve_repo_root` walks up the parent chain to find), seeds the
relevant TS / py files, runs the adapter, asserts shape.
"""
from __future__ import annotations

import ast
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Make the aria-poc directory importable for direct adapter access. This
# module lives under invariants/ so the aria-kernel workflow's `unittest
# discover tools/aria-poc/invariants` step runs it (ARIA-MEDIUM-377).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_harness_security_adapter import (  # type: ignore[import-not-found]
    CREDENTIAL_TABLE_PATH as HARNESS_CREDENTIAL_TABLE_PATH,
    SCANNED_GLOBS as HARNESS_SCANNED_GLOBS,
    _load_credential_table as harness_credential_table,
)
from cqrs_adapter import (  # type: ignore[import-not-found]
    SCANNED_GLOBS as CQRS_SCANNED_GLOBS,
    _iter_files as cqrs_iter_files,
    scan as cqrs_scan,
)
from outbox_adapter import (  # type: ignore[import-not-found]
    SCANNED_GLOBS as OUTBOX_SCANNED_GLOBS,
    _FALLBACK_SCANNED_GLOBS as OUTBOX_FALLBACK_GLOBS,
    _iter_files as outbox_iter_files,
    scan as outbox_scan,
)


_POC = Path(__file__).resolve().parents[1]
_REPO_ROOT = Path(__file__).resolve().parents[3]
_MANIFEST_DIR = _REPO_ROOT / "tools" / "aria-adapters"


def _manifest_globs(tool_id: str) -> list[str]:
    """The tool's ``allowed_read_globs`` from its COMMITTED declaration.

    ARIA-MEDIUM-377 — this used to read ``aria-tools/registry.json``, the
    gitignored registry ``registry_compiler`` builds at runtime. A fresh
    checkout and the CI job (whose bootstrap writes ``.aria-ci/tools``) have
    no such file, so both pins failed with FileNotFoundError wherever they
    could run. The registry is compiled from the manifests
    (``tools/aria-adapters/<tool_id>.tool.json``), the only declaration an
    adapter has since ARIA-MEDIUM-378 gave the Plan 016 portfolio adapters
    manifests of their own.
    """
    row = json.loads((_MANIFEST_DIR / f"{tool_id}.tool.json").read_text(encoding="utf-8"))
    globs = row.get("allowed_read_globs", [])
    if not isinstance(globs, list):
        raise AssertionError(f"{tool_id} allowed_read_globs is not a list")
    return [str(g) for g in globs]


def _make_repo() -> Path:
    """Create a tempdir fixture repo with `package.json` so
    `_resolve_repo_root` resolves to it."""
    repo = Path(tempfile.mkdtemp(prefix="aria-adapter-scope-narrow-"))
    (repo / "package.json").write_text("{}", encoding="utf-8")
    return repo


def _seed(repo: Path, rel: str, content: str = "") -> Path:
    """Write `content` to `repo/rel`, creating parent dirs."""
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


_OUTBOX_REGISTRATION = (
    "import { OutboxModule } from '@platform/outbox';\n"
    "export const HrOutbox = OutboxModule.forFeature({ entity: HrOutbox });\n"
)

_TRANSACTIONAL_HANDLER = """
export class RejectHandler {
  async execute(command: RejectCommand): Promise<Request> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.startTransaction();
    try {
      const saved = await queryRunner.manager.save(Request, request);
      await queryRunner.commitTransaction();
      this.eventBus.publish(createRejectedEvent(saved));
      return saved;
    } finally {
      await queryRunner.release();
    }
  }
}
"""


class OutboxAdapterScopeTests(unittest.TestCase):
    """Pin outbox_adapter's scanned surface to the manifest declaration."""

    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_outbox_adapter_scanned_globs_match_the_manifest(self) -> None:
        self.assertEqual(sorted(_manifest_globs("outbox-adapter")), sorted(OUTBOX_SCANNED_GLOBS))
        self.assertEqual(tuple(OUTBOX_SCANNED_GLOBS), OUTBOX_FALLBACK_GLOBS)
        for glob in OUTBOX_SCANNED_GLOBS:
            self.assertTrue(glob.startswith("apps/"), f"{glob} widens past application source")

    def test_outbox_adapter_walks_application_source_only(self) -> None:
        handler = _seed(self.repo, "apps/hr-service/src/leave/reject.handler.ts", "// handler")
        registration = _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", "// module")
        _seed(self.repo, "apps/hr-service/src/leave/__tests__/reject.spec.ts", "// test")
        _seed(self.repo, "apps/hr-service/src/database/migrations/1-x.ts", "// migration")
        _seed(self.repo, "apps/hr-service/test/e2e.ts", "// outside src")
        _seed(self.repo, "platform/libs/outbox/src/outbox-worker.service.ts", "// library")
        _seed(self.repo, "libs/backend-common/src/utils.ts", "// library")
        walked = sorted(p.relative_to(self.repo).as_posix() for p in outbox_iter_files(self.repo, None))
        self.assertEqual(walked, sorted([
            handler.relative_to(self.repo).as_posix(),
            registration.relative_to(self.repo).as_posix(),
        ]))

    def test_outbox_adapter_kernel_injection_path_uses_allowed_paths(self) -> None:
        handler = _seed(self.repo, "apps/hr-service/src/leave/reject.handler.ts", "// handler")
        _seed(self.repo, "apps/hr-service/src/leave/approve.handler.ts", "// not supplied")
        supplied = [handler.relative_to(self.repo).as_posix()]
        envelope = outbox_scan(self.repo, allowed_paths=supplied)
        self.assertEqual(envelope["read_paths"], supplied)

    def test_outbox_adapter_empty_allowed_paths_means_no_walk(self) -> None:
        _seed(self.repo, "apps/hr-service/src/leave/reject.handler.ts", _TRANSACTIONAL_HANDLER)
        envelope = outbox_scan(self.repo, allowed_paths=[])
        self.assertEqual(envelope["read_paths"], [])
        self.assertEqual(envelope["findings"], [])


class OutboxAdapterDetectionTests(unittest.TestCase):
    """ARIA-MEDIUM-379 — true- and false-positive fixtures for the one rule."""

    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def _rules(self) -> list[tuple[str, str, int]]:
        return [(f["rule"], f["path"], f["line"]) for f in outbox_scan(self.repo)["findings"]]

    def test_raw_publish_in_a_transactional_write_path_is_flagged(self) -> None:
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/leave/reject.handler.ts", _TRANSACTIONAL_HANDLER)
        self.assertEqual(self._rules(), [(
            "domain_event_published_outside_outbox", "apps/hr-service/src/leave/reject.handler.ts", 9,
        )])
        finding = outbox_scan(self.repo)["findings"][0]
        # The publish, then the durable write it follows (review M3: the
        # premise a judge verifies names the actual write).
        self.assertEqual(finding["evidence"], [
            {"path": finding["path"], "line": 9}, {"path": finding["path"], "line": 7},
        ])

    def test_a_save_then_publish_without_a_transaction_is_flagged(self) -> None:
        # Review M2: complete-training saves through a repository and then
        # publishes, with no transaction; it is the same dual write.
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/training/complete.handler.ts", """
export class CompleteHandler {
  async execute(command: CompleteCommand): Promise<Enrollment> {
    const saved = await this.enrollmentRepository.save(enrollment);
    this.eventBus.publish(createCompletedEvent(saved));
    return saved;
  }
}
""")
        self.assertEqual(self._rules(), [(
            "domain_event_published_outside_outbox", "apps/hr-service/src/training/complete.handler.ts", 5,
        )])

    def test_a_write_and_a_publish_through_same_class_helpers_are_flagged(self) -> None:
        # Review M2: harvest-completed saves in one helper and publishes in
        # another, both called from handle().
        _seed(self.repo, "apps/farm-service/src/outbox/farm-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/farm-service/src/events/harvest.listener.ts", """
export class HarvestListener {
  async handle(event: Harvested): Promise<void> {
    await this.updateBatch(event);
    await this.publishFollowUps(event);
  }

  private async updateBatch(event: Harvested): Promise<void> {
    await this.batchRepository.save(batch);
  }

  private async publishFollowUps(event: Harvested): Promise<void> {
    await this.eventBus.publish(createCompletedEvent(event));
  }
}
""")
        findings = outbox_scan(self.repo)["findings"]
        self.assertEqual([(f["line"], [e["line"] for e in f["evidence"]]) for f in findings], [(13, [13, 9])])

    def test_a_map_delete_or_a_write_after_the_publish_is_not_a_dual_write(self) -> None:
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/cache/cache.service.ts", """
export class CacheService {
  async evict(key: string): Promise<void> {
    this.cache.delete(key);
    await this.eventBus.publish(createEvictedEvent(key));
  }

  async record(entry: Entry): Promise<void> {
    await this.eventBus.publish(createSeenEvent(entry));
    await this.entryRepository.save(entry);
  }
}
""")
        self.assertEqual(self._rules(), [])

    def test_the_outbox_enqueue_path_is_not_flagged(self) -> None:
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/leave/approve.handler.ts",
              _TRANSACTIONAL_HANDLER.replace(
                  "this.eventBus.publish(createRejectedEvent(saved));",
                  "await this.outboxPublisher.enqueue(createRejectedEvent(saved), queryRunner.manager);",
              ))
        self.assertEqual(self._rules(), [])

    def test_a_publish_in_a_unit_without_a_durable_write_is_not_flagged(self) -> None:
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/ingest/telemetry.service.ts", """
export class TelemetryService {
  async save(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.startTransaction();
    await queryRunner.commitTransaction();
  }

  async forward(reading: Reading): Promise<void> {
    await this.eventBus.publish(createReadingEvent(reading));
  }
}
""")
        self.assertEqual(self._rules(), [])

    def test_a_service_without_the_outbox_is_not_flagged(self) -> None:
        _seed(self.repo, "apps/legacy-service/src/leave/reject.handler.ts", _TRANSACTIONAL_HANDLER)
        self.assertEqual(self._rules(), [])

    def test_the_outbox_implementation_and_comments_are_not_judged(self) -> None:
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/outbox/best-effort-publisher.ts", _TRANSACTIONAL_HANDLER)
        _seed(self.repo, "apps/hr-service/src/leave/reject.handler.ts", _TRANSACTIONAL_HANDLER.replace(
            "this.eventBus.publish(createRejectedEvent(saved));",
            "// Previously eventBus.publish() was called AFTER commit.",
        ))
        self.assertEqual(self._rules(), [])


# One path set inside the scope of BOTH adapters (cqrs: ``controllers/`` and
# ``*.controller.ts``; outbox: ``apps/*/src/**``). The near misses share a
# fragment with a skip entry (``.test.ts``, ``/migrations/``, ``dist/``,
# ``.spec.ts``) without carrying it, so a looser predicate goes red.
_CONTROLLERS = "apps/hr-service/src/leave/controllers"
_READ = [f"{_CONTROLLERS}/{name}.controller.ts"
         for name in ("leave", "latest", "migrations", "distribution", "spec")]
_SPEC_AND_TESTS_DIR = [f"{_CONTROLLERS}/leave.controller.spec.ts", f"{_CONTROLLERS}/__tests__/leave.helper.ts"]
_TEST_AND_MIGRATION = [
    f"{_CONTROLLERS}/leave.controller.test.ts",
    "apps/hr-service/src/migrations/1-leave.controller.ts",
]
_SKIP_FRAGMENTS = {"/__tests__/", ".spec.ts", ".test.ts", "/migrations/", "node_modules/", "dist/"}


class CqrsAdapterScopeTests(unittest.TestCase):
    """DET-RCA B18 — the cqrs adapter reads production controllers, and the cqrs
    and outbox adapters leave the same non-production sources unread."""

    def setUp(self) -> None:
        self.repo = _make_repo()
        self.addCleanup(shutil.rmtree, self.repo, True)

    def _both_adapters_walk_only_production(self, skipped: list[str]) -> None:
        for rel in [*_READ, *skipped]:
            _seed(self.repo, rel, "// source")
        for adapter, iter_files in (("cqrs", cqrs_iter_files), ("outbox", outbox_iter_files)):
            for mode, supplied in (("glob walk", None), ("kernel allowed_paths", [*_READ, *skipped])):
                with self.subTest(adapter=adapter, mode=mode):
                    walked = sorted(p.relative_to(self.repo).as_posix() for p in iter_files(self.repo, supplied))
                    self.assertEqual(walked, sorted(_READ))

    def test_cqrs_adapter_scanned_globs_match_the_manifest(self) -> None:
        self.assertEqual(sorted(_manifest_globs("cqrs-adapter")), sorted(CQRS_SCANNED_GLOBS))

    def test_both_adapters_skip_specs_and_tests_directories(self) -> None:
        # Pin of the intended skip (the cqrs premise: a controller that serves
        # requests in production); green on the base by design.
        self._both_adapters_walk_only_production(_SPEC_AND_TESTS_DIR)

    def test_both_adapters_skip_test_files_and_migrations(self) -> None:
        # Red on the base: the cqrs list lacks `.test.ts` and `/migrations/`.
        self._both_adapters_walk_only_production(_TEST_AND_MIGRATION)

    def test_a_production_controller_is_flagged_and_its_spec_is_not(self) -> None:
        defect = "class C {\n  constructor(@InjectRepository(X) private repo: Repository<X>) {}\n}\n"
        for rel in (_READ[0], *_SPEC_AND_TESTS_DIR):
            _seed(self.repo, rel, defect)
        result = cqrs_scan(self.repo)
        self.assertEqual(result["read_paths"], [_READ[0]])
        self.assertEqual({f["path"] for f in result["findings"]}, {_READ[0]})

    def test_neither_adapter_keeps_a_private_skip_list(self) -> None:
        # Red on the base: both adapters define the fragments themselves. One
        # owner means the literals live in the shared predicate and nowhere else.
        for name in ("cqrs_adapter", "outbox_adapter"):
            tree = ast.parse((_POC / f"{name}.py").read_text(encoding="utf-8"))
            owned = {
                n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and n.value in _SKIP_FRAGMENTS
            }
            self.assertEqual(owned, set(), f"{name} owns skip fragments instead of the shared predicate")

    def test_the_shared_predicate_decides_the_skip(self) -> None:
        # NEW API this package introduces (red on the base because the module
        # does not exist): tools/aria-poc/adapter_scope.py,
        # ``is_excluded_source(rel: str) -> bool`` over a repo-relative posix path.
        scope = importlib.import_module("adapter_scope")
        excluded = [
            *_SPEC_AND_TESTS_DIR, *_TEST_AND_MIGRATION,
            "apps/hr-service/node_modules/x/y.controller.ts", "apps/hr-service/dist/y.controller.js",
        ]
        self.assertEqual([r for r in excluded if not scope.is_excluded_source(r)], [])
        self.assertEqual([r for r in _READ if scope.is_excluded_source(r)], [])

    def test_the_runner_argv_reads_no_spec(self) -> None:
        # The runner starts `python3 <adapter>.py` in tools/aria-poc with no
        # PYTHONPATH: a shared module the adapters import must resolve there.
        supplied = [_READ[0], *_SPEC_AND_TESTS_DIR]
        for rel in supplied:
            _seed(self.repo, rel, "// source")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "ARIA_REPO_ROOT": str(self.repo)}
        for name in ("cqrs_adapter", "outbox_adapter"):
            completed = subprocess.run(
                [sys.executable, f"{name}.py"], cwd=_POC, env=env, capture_output=True, text=True,
                input=json.dumps({"repo_snapshot": {"allowed_paths": supplied}}), timeout=60, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
            self.assertEqual(json.loads(completed.stdout)["read_paths"], [_READ[0]], name)


class AgentHarnessSecurityScopeUnchangedTests(unittest.TestCase):
    """Pin agent_harness_security_adapter.SCANNED_GLOBS to the manifest.

    Per Planner-B's investigation, this adapter was already scope-narrow
    pre-fix. This test locks the invariant so future edits cannot
    silently broaden the scan surface."""

    def test_agent_harness_security_adapter_scope_unchanged(self) -> None:
        # Manifest globs (the source of truth).
        manifest = _manifest_globs("agent-harness-security-adapter")
        # The adapter declares SCANNED_GLOBS as a subset of manifest:
        # `aria-tools/registry.json` is the single literal path the
        # adapter excludes from glob iteration (the kernel reads it
        # through the registry loader, not through the glob walker).
        # All other manifest entries MUST be present in SCANNED_GLOBS.
        manifest_glob_set = set(manifest)
        # Brace alternation `*.{yml,yaml}` from the manifest expands
        # into two adapter entries (`*.yml`, `*.yaml`) — accept both
        # forms equally.
        adapter_set = set(HARNESS_SCANNED_GLOBS)
        # The literal `aria-tools/registry.json` line in the manifest
        # is the ONLY entry the adapter is permitted to omit; every
        # other manifest entry must be present, possibly with brace
        # alternation expanded.
        unexpanded_difference = manifest_glob_set - adapter_set
        # Allow brace-expansion: `.github/workflows/*.{yml,yaml}` in the
        # manifest is satisfied by both `.github/workflows/*.yml` AND
        # `.github/workflows/*.yaml` in the adapter.
        allowed_omissions = {"aria-tools/registry.json"}
        for missing in list(unexpanded_difference):
            if missing in allowed_omissions:
                unexpanded_difference.discard(missing)
                continue
            if "{" in missing and "}" in missing:
                # Try brace-expanded variants.
                head, _, rest = missing.partition("{")
                inner, _, tail = rest.partition("}")
                variants = {head + part + tail for part in inner.split(",")}
                if variants.issubset(adapter_set):
                    unexpanded_difference.discard(missing)
        self.assertSetEqual(
            unexpanded_difference,
            set(),
            (
                "agent_harness_security_adapter.SCANNED_GLOBS missing "
                f"manifest entries: {sorted(unexpanded_difference)}. "
                "Either narrow the manifest or update the adapter."
            ),
        )

        # The adapter MUST NOT walk anything broader than the manifest.
        # Allow concrete brace-expansions, but reject any additional
        # top-level entry.
        manifest_expanded: set[str] = set()
        for entry in manifest_glob_set:
            if "{" in entry and "}" in entry:
                head, _, rest = entry.partition("{")
                inner, _, tail = rest.partition("}")
                manifest_expanded.update(head + part + tail for part in inner.split(","))
            else:
                manifest_expanded.add(entry)
        adapter_extra = adapter_set - manifest_expanded
        self.assertSetEqual(
            adapter_extra,
            set(),
            (
                "agent_harness_security_adapter.SCANNED_GLOBS includes "
                f"out-of-manifest entries: {sorted(adapter_extra)}. "
                "Manifest is the single source of truth."
            ),
        )


class AgentHarnessCredentialTableTests(unittest.TestCase):
    """Rule 1 reads the kernel's one credential table (ARIA-HIGH-519).

    The adapter loads aria-kernel/aria_kernel/secret_scrub.py alone, by path:
    the file must lie inside the scope the manifest declares, and the scan
    must work when that file is the only kernel code present, which is the
    runner's argv (`python3 agent_harness_security_adapter.py` from
    tools/aria-poc) with no PYTHONPATH.
    """

    def test_the_table_lies_inside_the_declared_read_scope(self) -> None:
        # The kernel's own read-scope gate decides, on the committed manifest.
        from aria_kernel.tool_health import find_scope_violations

        relative = HARNESS_CREDENTIAL_TABLE_PATH.relative_to(_REPO_ROOT).as_posix()
        manifest = json.loads(
            (_MANIFEST_DIR / "agent-harness-security-adapter.tool.json").read_text(encoding="utf-8")
        )
        self.assertTrue(manifest["allowed_read_globs"])
        self.assertEqual(find_scope_violations(manifest, [relative]), [])

    def test_the_runner_argv_scans_with_the_table_file_alone(self) -> None:
        rows = harness_credential_table().shapes_in("harness")
        self.assertTrue(rows)
        tree = Path(tempfile.mkdtemp(prefix="aria-harness-table-"))
        self.addCleanup(shutil.rmtree, tree, True)
        poc = tree / "checkout" / "tools" / "aria-poc"
        kernel = tree / "checkout" / "aria-kernel" / "aria_kernel"
        poc.mkdir(parents=True)
        kernel.mkdir(parents=True)
        shutil.copy2(Path(__file__).resolve().parents[1] / "agent_harness_security_adapter.py", poc)
        shutil.copy2(HARNESS_CREDENTIAL_TABLE_PATH, kernel)
        # The package __init__ imports some sixty modules the room may not
        # hold; here it refuses to load, so an adapter that imports the
        # package instead of the one file fails this test.
        (kernel / "__init__.py").write_text(
            'raise ImportError("the aria_kernel package must not be imported by the harness adapter")\n',
            encoding="utf-8",
        )
        scanned = tree / "scanned"
        _seed(scanned, ".github/workflows/leak.yml", "\n".join(row.fixture for row in rows) + "\n")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "ARIA_REPO_ROOT": str(scanned)}
        completed = subprocess.run(
            [sys.executable, "agent_harness_security_adapter.py"],
            cwd=poc, env=env, input=json.dumps({"cycle_id": "harness-table"}),
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
        labels = {
            finding["label"] for finding in json.loads(completed.stdout)["findings"]
            if finding["rule"] == "secret_leak_in_yaml_or_md"
        }
        self.assertEqual(labels, {row.name for row in rows})


if __name__ == "__main__":
    unittest.main()
