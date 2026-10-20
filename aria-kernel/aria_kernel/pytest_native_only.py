"""Select pytest-native tests without re-running unittest TestCase items.

ARIA-LOW-599 — the pytest half of the suite partition also accounts for its
real-sandbox pin skips. With ``--refuse-sandbox-skips`` (passed by the kernel
lane's ``scripts/ci/aria-suite-run.sh --pytest-native``), a run in which any
test skipped as a real-sandbox pin (``aria_kernel.sandbox_pin_skip``) is
refused: the lane provisions the sandbox backend before the suite, so there a
skipped pin is a containment proof that did not run. The unittest half is
refused by the same predicate in ``suite_shards verify``. Without the option
(a laptop, a host without user namespaces) the pin stays a skip, the
sandbox's own fail-closed contract.
"""

from __future__ import annotations

import unittest

import pytest

from .sandbox_pin_skip import is_sandbox_pin_skip

_REFUSE_OPTION = "--refuse-sandbox-skips"
# pytest prefixes the message of a skip report's (path, line, message) triple.
_SKIP_MESSAGE_PREFIX = "Skipped: "


def _is_unittest_test_case(item: pytest.Item) -> bool:
    """Return whether pytest collected ``item`` from a TestCase descendant."""

    class_collector = item.getparent(pytest.Class)
    return class_collector is not None and issubclass(class_collector.obj, unittest.TestCase)


class SandboxSkipLedger:
    """The run's real-sandbox pin skips, and the lane's refusal of them."""

    def __init__(self, *, refuse: bool) -> None:
        self.refuse = refuse
        self.skips: list[str] = []

    @pytest.hookimpl(trylast=True)
    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        # A skip report's longrepr is pytest's (path, line, message) triple.
        if not report.skipped or not isinstance(report.longrepr, tuple):
            return
        message = str(report.longrepr[2]).removeprefix(_SKIP_MESSAGE_PREFIX)
        if is_sandbox_pin_skip(message):
            self.skips.append(report.nodeid)

    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        if self.refuse and self.skips and exitstatus == pytest.ExitCode.OK:
            session.exitstatus = pytest.ExitCode.TESTS_FAILED

    def pytest_terminal_summary(self, terminalreporter: pytest.TerminalReporter) -> None:
        if not self.refuse or not self.skips:
            return
        terminalreporter.write_line(
            f"{_REFUSE_OPTION} refused: {len(self.skips)} real-sandbox pin skipped on a lane that "
            "provisions the sandbox backend, so a containment proof did not run:",
            red=True,
        )
        for nodeid in sorted(self.skips):
            terminalreporter.write_line(f"  {nodeid}")


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        _REFUSE_OPTION,
        action="store_true",
        default=False,
        help="fail the run when a test skipped as a real-sandbox pin (the kernel lane)",
    )


def pytest_configure(config: pytest.Config) -> None:
    config.pluginmanager.register(
        SandboxSkipLedger(refuse=bool(config.getoption(_REFUSE_OPTION))),
        "aria-sandbox-skip-ledger",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Deselect TestCase items, which the runner executes through unittest."""

    selected: list[pytest.Item] = []
    deselected: list[pytest.Item] = []
    for item in items:
        (deselected if _is_unittest_test_case(item) else selected).append(item)

    items[:] = selected
    if deselected:
        config.hook.pytest_deselected(items=deselected)
