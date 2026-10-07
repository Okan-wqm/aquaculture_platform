"""Plan 020 Phase 14 — outbox + cqrs adapter fixture tests.

What this suite pins:
- outbox_adapter flags a domain event published with eventBus.publish in
  a transactional write path of a service that registers the outbox
  (ARIA-MEDIUM-379), and not the enqueue path.
- cqrs_adapter detects controller direct repository call + repository
  injection patterns.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))

from cqrs_adapter import scan as cqrs_scan  # type: ignore[import-not-found]
from outbox_adapter import scan as outbox_scan  # type: ignore[import-not-found]


def _make_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-backend-adapter-"))
    (repo / "package.json").write_text("{}", encoding="utf-8")
    return repo


class OutboxAdapterTests(unittest.TestCase):
    """ARIA-MEDIUM-379 — the one outbox rule end to end through ``scan``; the
    scope and the false-positive fixtures live in
    ``tools/aria-poc/invariants/test_adapter_scope_narrow.py``."""

    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def _seed(self, rel: str, text: str) -> Path:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_raw_publish_after_a_committed_write_is_flagged(self) -> None:
        self._seed("apps/x-service/src/outbox/x-outbox.module.ts",
                   "export const M = OutboxModule.forFeature({ entity: XOutbox });\n")
        path = self._seed("apps/x-service/src/things/handlers/create.handler.ts", """
export class CreateHandler {
  async execute(command: CreateCommand): Promise<Thing> {
    await this.dataSource.transaction(async (manager) => manager.save(Thing, thing));
    await this.eventBus.publish(createThingCreatedEvent(thing));
    return thing;
  }
}
""")
        result = outbox_scan(self.repo)
        self.assertEqual({f["rule"] for f in result["findings"]}, {"domain_event_published_outside_outbox"})
        self.assertEqual(set(result["evidence_sources"]), {path.relative_to(self.repo).as_posix()})

    def test_enqueue_inside_the_transaction_is_clean(self) -> None:
        self._seed("apps/x-service/src/outbox/x-outbox.module.ts",
                   "export const M = OutboxModule.forFeature({ entity: XOutbox });\n")
        self._seed("apps/x-service/src/things/handlers/create.handler.ts", """
export class CreateHandler {
  async execute(command: CreateCommand): Promise<Thing> {
    await this.dataSource.transaction(async (manager) => {
      await manager.save(Thing, thing);
      await this.outboxPublisher.enqueue(createThingCreatedEvent(thing), manager);
    });
    return thing;
  }
}
""")
        self.assertEqual(outbox_scan(self.repo)["findings"], [])


class CqrsAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_controller_direct_repo_call_flagged(self) -> None:
        path = self.repo / "apps" / "x-service" / "src" / "controllers" / "bad.controller.ts"
        path.parent.mkdir(parents=True)
        path.write_text("""
import { Controller } from '@nestjs/common';
import { Repository } from 'typeorm';
@Controller('x') class C {
  constructor(private repo: Repository<X>) {}
  async do() { return this.repo.findOne({}); }
}
""", encoding="utf-8")
        result = cqrs_scan(self.repo)
        rules = {f["rule"] for f in result["findings"]}
        self.assertIn("controller_skips_command_query_bus", rules)
        self.assertIn("controller_injects_repository_directly", rules)
        self.assertEqual(set(result["evidence_sources"]), {path.relative_to(self.repo).as_posix()})

    def test_controller_with_command_bus_clean(self) -> None:
        path = self.repo / "apps" / "x-service" / "src" / "controllers" / "good.controller.ts"
        path.parent.mkdir(parents=True)
        path.write_text("""
import { CommandBus } from '@nestjs/cqrs';
class C {
  constructor(private bus: CommandBus) {}
  async do() { return this.bus.execute(new DoCommand()); }
}
""", encoding="utf-8")
        result = cqrs_scan(self.repo)
        rules = {f["rule"] for f in result["findings"]}
        self.assertNotIn("controller_skips_command_query_bus", rules)


if __name__ == "__main__":
    unittest.main()
