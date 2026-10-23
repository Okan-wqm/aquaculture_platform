"""RW-1 — the published Prometheus port is a READ-ONLY source.

The runtime watchdog reads the droplet Prometheus through a port published
on 127.0.0.1 (test_rw1_runtime_watchdog_feed pins the loopback binding).
Every local account can reach that port, so it may serve reads only:
``--web.enable-lifecycle`` adds POST /-/quit and /-/reload, and
``--web.enable-admin-api`` adds series deletion and snapshots. A Prometheus
in a tracked compose file that publishes a host port runs with neither.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from urllib.parse import urlsplit

import yaml

from aria_kernel.genesis_policy import WATCHDOG_PULL_DEFAULTS

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WRITE_FLAGS = ("--web.enable-lifecycle", "--web.enable-admin-api")


def _compose_files() -> list[Path]:
    return sorted(_REPO_ROOT.glob("docker-compose*.yml")) + sorted(
        (_REPO_ROOT / "infrastructure").rglob("*compose*.y*ml")
    )


class ThePublishedPrometheusServesReadsOnly(unittest.TestCase):
    def test_a_prometheus_with_a_host_port_enables_no_write_endpoint(self) -> None:
        published = 0
        offenders: list[str] = []
        for path in _compose_files():
            document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            for name, service in (document.get("services") or {}).items():
                if not str(service.get("image", "")).startswith("prom/prometheus:") or not service.get("ports"):
                    continue
                published += 1
                command = service.get("command") or []
                words = command.split() if isinstance(command, str) else [str(word) for word in command]
                offenders.extend(
                    f"{path.relative_to(_REPO_ROOT)}:{name}:{word}"
                    for word in words
                    if word.split("=", 1)[0] in _WRITE_FLAGS
                )
        self.assertGreater(published, 0, "no tracked compose file publishes the watchdog's Prometheus source")
        self.assertEqual(offenders, [])

    def test_the_production_prometheus_publishes_the_policy_default_source(self) -> None:
        """The droplet compose is the stack production runs (project aqua-saas):
        its Prometheus is published exactly where the policy default points."""
        source = urlsplit(WATCHDOG_PULL_DEFAULTS["observability_base_url"])
        document = yaml.safe_load((_REPO_ROOT / "docker-compose.droplet.yml").read_text(encoding="utf-8"))
        self.assertEqual(
            document["services"]["prometheus"]["ports"], [f"{source.hostname}:{source.port}:9090"],
        )


if __name__ == "__main__":
    unittest.main()
