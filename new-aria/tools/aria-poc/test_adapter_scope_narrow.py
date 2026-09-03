"""Plan 022 §C-7/§C-8 follow-up — adapter scope narrowness invariants.

Pins the iteration surfaces of the outbox + agent-harness-security
adapters to their manifest declarations. The pre-fix `outbox_adapter`
walked the entire `apps/`, `platform/libs/`, and `libs/` trees regardless
of its manifest scope (`apps/**/outbox/**/*.ts`,
`platform/libs/outbox/**/*.ts`), surfacing ~200 hr-service paths and
producing a real-positive scope_violation once the kernel-side scope
matcher (Plan 022 §C-7/§C-8) was repaired.

These tests guarantee:

* `outbox_adapter.SCANNED_GLOBS` (and its `_FALLBACK_SCANNED_GLOBS`
  internal alias) match the manifest exactly — neither broader nor
  narrower than `aria-tools/registry.json` declares.
* `outbox_adapter._iter_files` walks ONLY outbox subtrees, both in
  fallback mode (no `allowed_paths`) and in kernel-injection mode
  (`allowed_paths` supplied).
* `outbox_adapter` does not yield non-outbox paths even when an
  hr-service file sits in the same fixture repo.
* `agent_harness_security_adapter.SCANNED_GLOBS` matches its manifest
  declaration exactly — confirms the implementer-side claim that this
  adapter was already scope-narrow and needs no change.

Test isolation: each test creates a tempdir fixture repo with
`package.json` (the marker `_resolve_repo_root` walks up the parent
chain to find), seeds the relevant TS / py files, runs the adapter,
asserts shape.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Make the aria-poc directory importable for direct adapter access.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness_security_adapter import (  # type: ignore[import-not-found]
    SCANNED_GLOBS as HARNESS_SCANNED_GLOBS,
)
from outbox_adapter import (  # type: ignore[import-not-found]
    SCANNED_GLOBS as OUTBOX_SCANNED_GLOBS,
    _FALLBACK_SCANNED_GLOBS as OUTBOX_FALLBACK_GLOBS,
    _iter_files as outbox_iter_files,
    scan as outbox_scan,
)


# Repository root for this checkout — the `aria-tools/registry.json`
# manifest lives here and is the single source of truth tests pin against.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_REGISTRY_PATH = _REPO_ROOT / "aria-tools" / "registry.json"


def _manifest_globs(tool_id: str) -> list[str]:
    """Read `aria-tools/registry.json` and return the tool's
    `allowed_read_globs` list. Test scaffolding — not load-bearing
    in production."""
    payload = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
    for tool in payload.get("tools", []):
        if tool.get("tool_id") == tool_id:
            globs = tool.get("allowed_read_globs", [])
            if not isinstance(globs, list):
                raise AssertionError(
                    f"{tool_id} allowed_read_globs is not a list",
                )
            return [str(g) for g in globs]
    raise AssertionError(f"{tool_id} not found in registry.json")


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


class OutboxAdapterScopeNarrowTests(unittest.TestCase):
    """Pin outbox_adapter scanned surface to the manifest declaration."""

    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_outbox_adapter_scanned_globs_narrow(self) -> None:
        """SCANNED_GLOBS must match manifest, NOT include broad
        `apps/**/*.ts` or `libs/**/*.ts` patterns that walked the whole
        tree pre-fix. The manifest is the single source of truth; this
        test fails immediately if the adapter drifts above scope."""
        # The exact, sorted manifest globs.
        expected = sorted(_manifest_globs("outbox-adapter"))
        # The adapter's declared globs.
        actual = sorted(OUTBOX_SCANNED_GLOBS)
        self.assertEqual(
            expected,
            actual,
            (
                "outbox_adapter.SCANNED_GLOBS drifted from manifest "
                f"`outbox-adapter.allowed_read_globs`. Expected={expected}, "
                f"actual={actual}. Update the adapter to match the "
                "manifest, or update the manifest+adapter together."
            ),
        )
        # Internal fallback alias must be the same tuple — the public
        # SCANNED_GLOBS is documented to alias _FALLBACK_SCANNED_GLOBS.
        self.assertEqual(tuple(OUTBOX_SCANNED_GLOBS), OUTBOX_FALLBACK_GLOBS)
        # The pre-fix broad patterns must be absent.
        for forbidden in ("apps/**/*.ts", "libs/**/*.ts", "platform/libs/**/*.ts"):
            self.assertNotIn(
                forbidden,
                OUTBOX_SCANNED_GLOBS,
                f"forbidden broad glob `{forbidden}` survived in SCANNED_GLOBS",
            )

    def test_outbox_adapter_walks_only_outbox_paths(self) -> None:
        """Fallback walker (no `allowed_paths` supplied) must visit
        ONLY outbox-surface files. Drop file mix is the strict version
        of the no-hr-drift test below: every file in the seeded repo
        is non-outbox EXCEPT the two outbox files."""
        outbox_in_apps = _seed(
            self.repo,
            "apps/farm-service/src/outbox/feed.outbox.ts",
            "// outbox file, in scope",
        )
        outbox_in_platform = _seed(
            self.repo,
            "platform/libs/outbox/src/publisher.outbox.ts",
            "// outbox file, in scope",
        )
        # Out-of-scope files spread across the broad pre-fix surfaces.
        _seed(self.repo, "apps/hr-service/src/personnel/foo.ts", "// not outbox")
        _seed(self.repo, "apps/farm-service/src/feed/feed.service.ts", "// not outbox")
        _seed(self.repo, "libs/backend-common/src/utils.ts", "// not outbox")
        _seed(self.repo, "platform/libs/cqrs/src/bus.ts", "// not outbox")

        # Iterate via the adapter's path walker — fallback mode (no
        # kernel-pre-filtered list).
        walked = outbox_iter_files(self.repo, allowed_paths=None)
        walked_rel = sorted(p.relative_to(self.repo).as_posix() for p in walked)
        self.assertEqual(
            walked_rel,
            sorted([
                outbox_in_apps.relative_to(self.repo).as_posix(),
                outbox_in_platform.relative_to(self.repo).as_posix(),
            ]),
            "fallback walker yielded out-of-scope files",
        )

    def test_outbox_adapter_no_hr_service_drift(self) -> None:
        """Mirrors the original drift bug: an hr-service TS file MUST
        NOT appear in the adapter's read_paths. This is the regression
        test that would have caught the pre-fix `apps/**/*.ts` walk."""
        outbox_path = _seed(
            self.repo,
            "apps/farm-service/src/outbox/feed.outbox.ts",
            "// outbox source — in scope",
        )
        hr_path = _seed(
            self.repo,
            "apps/hr-service/src/personnel/foo.ts",
            "// hr source — out of scope",
        )

        envelope = outbox_scan(self.repo)
        read_paths = envelope.get("read_paths", [])
        # Outbox path is read.
        self.assertIn(
            outbox_path.relative_to(self.repo).as_posix(),
            read_paths,
        )
        # hr-service path is NOT read.
        self.assertNotIn(
            hr_path.relative_to(self.repo).as_posix(),
            read_paths,
            "hr-service drift returned: adapter read a non-outbox path",
        )

    def test_outbox_adapter_kernel_injection_path_uses_allowed_paths(self) -> None:
        """When `allowed_paths` is supplied (the production path,
        kernel-pre-filtered through `_snapshot_for_tool`), the walker
        consumes that list directly. Verifies the Option-A
        single-source-of-truth path: even if the manifest declared a
        broader fallback, the kernel-pre-filtered list dominates."""
        outbox_path = _seed(
            self.repo,
            "apps/farm-service/src/outbox/feed.outbox.ts",
            "// outbox",
        )
        # Out-of-scope file present on disk; adapter must not read it
        # because it is NOT in `allowed_paths`.
        _seed(
            self.repo,
            "apps/hr-service/src/personnel/foo.ts",
            "// hr service",
        )

        # Kernel-supplied list contains ONLY the outbox path.
        kernel_supplied = [
            outbox_path.relative_to(self.repo).as_posix(),
        ]
        envelope = outbox_scan(self.repo, allowed_paths=kernel_supplied)
        self.assertEqual(envelope["read_paths"], kernel_supplied)

    def test_outbox_adapter_empty_allowed_paths_means_no_walk(self) -> None:
        """Edge case: kernel hands back an empty `allowed_paths` (e.g.
        the working tree contains zero outbox files). Adapter must
        return zero read_paths, not silently fall back to the manifest
        walk and reintroduce drift."""
        _seed(
            self.repo,
            "apps/hr-service/src/personnel/foo.ts",
            "// hr service",
        )
        envelope = outbox_scan(self.repo, allowed_paths=[])
        self.assertEqual(envelope["read_paths"], [])
        self.assertEqual(envelope["findings"], [])


class OutboxAdapterDetectionUnaffectedTests(unittest.TestCase):
    """Confirm the rule detection logic still fires correctly under the
    narrowed scope. Mirrors the existing
    `tests/test_outbox_cqrs_adapters.py` expectations but seeds the
    fixture inside the outbox surface so the narrowed walker still
    sees the file."""

    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_publish_outside_transaction_in_outbox_subtree_flagged(self) -> None:
        path = self.repo / "apps" / "farm-service" / "src" / "outbox" / "publisher.ts"
        path.parent.mkdir(parents=True)
        path.write_text("""
import { EventBus } from '@nestjs/cqrs';
class P { constructor(private eventBus: EventBus) {}
  do() { this.eventBus.publish(new SomeEvent()); }
}
""", encoding="utf-8")
        result = outbox_scan(self.repo)
        rules = {f["rule"] for f in result["findings"]}
        self.assertIn("transactional_outbox_violation", rules)
        self.assertIn("outbox_entity_base_missing", rules)


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
