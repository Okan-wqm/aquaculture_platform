"""ARIA-HIGH-247 — the runner habitat is what the host runs, and applying it installs only the habitat.

``scripts/aria/provision_runner.sh`` installs the repository copy of the
habitat (``scripts/aria/runner-habitat/systemd/``) and, in ``--dry-run``,
reports every place the host differs from it. Until this fix the habitat
carried a 3 GiB cap on every login session (``user-.slice``), sized for a
retired 7.8 GiB droplet, on a 31 GiB host whose operator sessions held
10.9 GB (2026-09-29); apply mode also installed and enabled the event gateway
and the telemetry export, which are not the runner's habitat. The operator
could therefore apply neither, and the drift gate could never pass.

These tests read the provisioner and the habitat files; none runs the
provisioner (it mutates the host). ``bash -n`` parses each script without
executing a line of it.
"""

from __future__ import annotations

import configparser
import re
import subprocess
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PROVISIONER = _REPO_ROOT / "scripts" / "aria" / "provision_runner.sh"
_GATEWAY_PROVISIONER = _REPO_ROOT / "scripts" / "aria" / "provision_gateway.sh"
_HABITAT = _REPO_ROOT / "scripts" / "aria" / "runner-habitat" / "systemd"
_HOST_UNITS = _REPO_ROOT / "infrastructure" / "aria"
_UNIT_SUFFIXES = (".service", ".timer", ".socket", ".path", ".slice", ".target")
# A memory property that bounds a cgroup (a weight such as CPUWeight is a share, not a cap).
_MEMORY_CAPS = ("MemoryMax", "MemoryHigh", "MemorySwapMax", "MemoryLimit")
_SIZE = re.compile(r"(\d+)([KMGT])")
_SIZE_FACTOR = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}


def _install_table(script: str) -> dict[str, str]:
    """``habitat file (relative) -> host destination`` from the provisioner's install table."""
    rows = re.findall(r"^\$\{HABITAT_SYSTEMD\}/(\S+)\|(\S+)$", script, flags=re.MULTILINE)
    return dict(rows)


def _enabled_units(script: str) -> list[str]:
    units: list[str] = []
    for tail in re.findall(r"systemctl enable --now ([^\n&|;]+)", script):
        units.extend(token for token in tail.split() if token.endswith(_UNIT_SUFFIXES))
    return units


def _probes(script: str) -> list[tuple[str, str, str]]:
    """Every ``unit|Property|want`` the drift gate compares with ``systemctl show``."""
    return re.findall(r'"(\$\{SERVICE_NAME\}|[\w.@-]+)\|(\w+)\|([^"|]+)"', script)


def _settings(path: Path) -> dict[str, str]:
    parser = configparser.ConfigParser(strict=False, interpolation=None, allow_no_value=True)
    parser.optionxform = str  # systemd keys are case-sensitive
    parser.read_string(path.read_text(encoding="utf-8"))
    merged: dict[str, str] = {}
    for section in parser.sections():
        if section in {"Service", "Slice", "Timer", "Unit"}:
            merged.update({key: value or "" for key, value in parser[section].items()})
    return merged


def _unit_of(destination: str) -> str:
    """The unit a destination configures: a drop-in's ``<unit>.d`` parent, else the unit file itself."""
    parent, _, name = destination.rpartition("/")
    directory = parent.rpartition("/")[2]
    return directory[: -len(".d")] if directory.endswith(".d") else name


def _as_systemctl_shows(value: str) -> str:
    size = _SIZE.fullmatch(value)
    return str(int(size.group(1)) * _SIZE_FACTOR[size.group(2)]) if size else value


class HabitatInstallTableTests(unittest.TestCase):
    def setUp(self) -> None:
        self.script = _PROVISIONER.read_text(encoding="utf-8")
        self.table = _install_table(self.script)

    def test_the_provisioner_parses(self) -> None:
        for script in (_PROVISIONER, _GATEWAY_PROVISIONER):
            with self.subTest(script=script.name):
                proc = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True, timeout=30, check=False)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_every_habitat_file_is_installed_once_and_nothing_else_is(self) -> None:
        shipped = sorted(path.relative_to(_HABITAT).as_posix() for path in _HABITAT.rglob("*") if path.is_file())
        self.assertTrue(self.table, "the provisioner's install table was not found")
        self.assertEqual(sorted(self.table), shipped)

    def test_apply_enables_only_units_the_habitat_ships(self) -> None:
        habitat_units = {Path(destination).name for destination in self.table.values()}
        enabled = _enabled_units(self.script)
        self.assertTrue(enabled, "the provisioner enables the habitat's timer")
        self.assertEqual([unit for unit in enabled if unit not in habitat_units], [],
                         "apply mode installs and enables the runner habitat only")

    def test_the_provisioner_installs_no_host_unit_from_outside_the_habitat(self) -> None:
        for unit in sorted(path.name for path in _HOST_UNITS.glob("*") if path.is_file()):
            with self.subTest(unit=unit):
                self.assertFalse(unit in self.script, f"provision_runner.sh installs {unit}, which is not the runner habitat")

    def test_every_effective_value_probe_checks_a_value_the_habitat_sets(self) -> None:
        by_unit: dict[str, dict[str, str]] = {}
        for relative, destination in self.table.items():
            by_unit.setdefault(_unit_of(destination), {}).update(_settings(_HABITAT / relative))
        probes = _probes(self.script)
        self.assertTrue(probes, "the drift gate's effective-value probes were not found")
        for unit, prop, want in probes:
            with self.subTest(unit=unit, prop=prop):
                self.assertIn(unit, by_unit, "the drift gate probes a unit the habitat installs nothing for")
                self.assertIn(prop, by_unit[unit], "the drift gate probes a property no habitat file sets")
                self.assertEqual(_as_systemctl_shows(by_unit[unit][prop]), want)


class HabitatBudgetTests(unittest.TestCase):
    """The habitat budgets the units it owns; the operator's login sessions are not among them.

    On the host the habitat runs on (31959 MiB, 8 CPUs), the operator's
    sessions held 10.9 GB on 2026-09-29 and 26.4 GB (peak 29.0 GB, page cache
    included) on 2026-10-17. A fixed per-session cap either kills those
    sessions or caps nothing, and the operator declined to install one. The
    runner is protected by its own cgroup cap and ``OOMPolicy=continue``.
    """

    def test_no_habitat_file_caps_the_memory_of_login_sessions(self) -> None:
        table = _install_table(_PROVISIONER.read_text(encoding="utf-8"))
        for relative, destination in sorted(table.items()):
            unit = _unit_of(destination)
            if not (unit == "user.slice" or unit.startswith("user-")):
                continue
            with self.subTest(file=relative):
                capped = sorted(set(_settings(_HABITAT / relative)) & set(_MEMORY_CAPS))
                self.assertEqual(capped, [], f"{relative} caps the operator's sessions")

    def test_the_runner_service_keeps_its_own_cap_and_survives_a_killed_job(self) -> None:
        service: dict[str, str] = {}
        for drop_in in sorted(_HABITAT.glob("actions-runner.*.conf")):
            service.update(_settings(drop_in))
        self.assertEqual(service.get("MemoryMax"), "3G")
        self.assertEqual(service.get("OOMPolicy"), "continue")


class GatewayProvisionerTests(unittest.TestCase):
    """The event gateway and the telemetry export keep a provisioner of their own."""

    def test_the_gateway_provisioner_installs_and_reports_every_host_unit(self) -> None:
        script = _GATEWAY_PROVISIONER.read_text(encoding="utf-8")
        for unit in sorted(path.name for path in _HOST_UNITS.glob("*") if path.is_file()):
            with self.subTest(unit=unit):
                self.assertTrue(unit in script, f"provision_gateway.sh does not install {unit}")
        self.assertTrue('[ "$DRY_RUN" -eq 1 ]' in script, "the gateway provisioner keeps a report-only mode")


if __name__ == "__main__":
    unittest.main()
