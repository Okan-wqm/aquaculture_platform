"""Plan 020 Phase 14 — outbox + cqrs adapter fixture tests.

What this suite pins:
- outbox_adapter detects publish-outside-transaction + publish-without-
  outbox-import patterns.
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
    def setUp(self) -> None:
        self.repo = _make_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_publish_outside_transaction_flagged(self) -> None:
        path = self.repo / "apps" / "x-service" / "src" / "publisher.ts"
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

    def test_clean_outbox_pattern_no_finding(self) -> None:
        path = self.repo / "apps" / "y-service" / "src" / "ok.ts"
        path.parent.mkdir(parents=True)
        path.write_text("""
import { OutboxPublisherService } from '@platform/outbox';
class P { constructor(private outbox: OutboxPublisherService,
                       private dataSource: any) {}
  async do() {
    await this.dataSource.transaction(async (em: any) => {
      this.eventBus.publish(new E());
    });
  }
}
""", encoding="utf-8")
        result = outbox_scan(self.repo)
        rules = {f["rule"] for f in result["findings"]}
        self.assertNotIn("outbox_entity_base_missing", rules)


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
