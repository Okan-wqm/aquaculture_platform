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

    def test_every_published_prometheus_port_is_the_policy_default_source(self) -> None:
        """Owner-agnostic: whichever tracked compose file defines the Prometheus
        (docker-compose.droplet.yml and docker-compose.monitoring.yml both do
        today — DEPLOY-CRITICAL-017 tracks the duplicate), every one that
        publishes a host port publishes exactly where the policy default points,
        and at least one does."""
        published, offenders = _published_port_offenders(_tracked_compose_documents())
        self.assertGreater(published, 0, "no tracked compose file publishes the watchdog's Prometheus source")
        self.assertEqual(offenders, [])

    def test_the_pin_survives_the_tracked_compose_consolidation(self) -> None:
        """DEPLOY-CRITICAL-017's fix deletes the monitoring services from
        docker-compose.droplet.yml; the RW-1 source pin must not depend on
        which file owns Prometheus (the base pin raised KeyError there)."""
        documents = _tracked_compose_documents()
        droplet = documents["docker-compose.droplet.yml"]
        consolidated = {
            **documents,
            "docker-compose.droplet.yml": {
                **droplet,
                "services": {k: v for k, v in droplet["services"].items() if k != "prometheus"},
            },
        }
        published, offenders = _published_port_offenders(consolidated)
        self.assertGreater(published, 0)
        self.assertEqual(offenders, [])


def _tracked_compose_documents() -> dict[str, dict]:
    return {
        path.relative_to(_REPO_ROOT).as_posix(): yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for path in _compose_files()
    }


def _published_port_offenders(documents: dict[str, dict]) -> tuple[int, list[str]]:
    """(how many compose Prometheus publish a host port, which publish anything
    but the policy default source ``<host>:<port>:9090``)."""
    source = urlsplit(WATCHDOG_PULL_DEFAULTS["observability_base_url"])
    expected = [f"{source.hostname}:{source.port}:9090"]
    published = 0
    offenders: list[str] = []
    for path, document in sorted(documents.items()):
        for name, service in (document.get("services") or {}).items():
            if not str(service.get("image", "")).startswith("prom/prometheus:") or not service.get("ports"):
                continue
            published += 1
            ports = [str(port) for port in service["ports"]]
            if ports != expected:
                offenders.append(f"{path}:{name}:{ports}")
    return published, offenders


if __name__ == "__main__":
    unittest.main()
