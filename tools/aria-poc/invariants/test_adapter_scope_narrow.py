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
* `agent_harness_security_adapter.SCANNED_GLOBS` matches its manifest.

Test isolation: each test creates a tempdir fixture repo with `package.json`
(the marker `_resolve_repo_root` walks up the parent chain to find), seeds the
relevant TS / py files, runs the adapter, asserts shape.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Make the aria-poc directory importable for direct adapter access. This
# module lives under invariants/ so the aria-kernel workflow's `unittest
# discover tools/aria-poc/invariants` step runs it (ARIA-MEDIUM-377).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent_harness_security_adapter import (  # type: ignore[import-not-found]
    SCANNED_GLOBS as HARNESS_SCANNED_GLOBS,
)
from outbox_adapter import (  # type: ignore[import-not-found]
    SCANNED_GLOBS as OUTBOX_SCANNED_GLOBS,
    _FALLBACK_SCANNED_GLOBS as OUTBOX_FALLBACK_GLOBS,
    _iter_files as outbox_iter_files,
    scan as outbox_scan,
)


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
        self.assertEqual(finding["evidence"], [{"path": finding["path"], "line": finding["line"]}])

    def test_the_outbox_enqueue_path_is_not_flagged(self) -> None:
        _seed(self.repo, "apps/hr-service/src/outbox/hr-outbox.module.ts", _OUTBOX_REGISTRATION)
        _seed(self.repo, "apps/hr-service/src/leave/approve.handler.ts",
              _TRANSACTIONAL_HANDLER.replace(
                  "this.eventBus.publish(createRejectedEvent(saved));",
                  "await this.outboxPublisher.enqueue(createRejectedEvent(saved), queryRunner.manager);",
              ))
        self.assertEqual(self._rules(), [])

    def test_a_publish_in_a_method_without_a_transactional_write_is_not_flagged(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
