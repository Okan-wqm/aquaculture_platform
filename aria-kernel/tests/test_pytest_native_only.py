"""Behavioral contract for the pytest-native side of the suite partition."""

from __future__ import annotations

import pytest

from aria_kernel import pytest_native_only


pytest_plugins = ("pytester",)


def test_native_only_plugin_partitions_mixed_module(pytester: pytest.Pytester) -> None:
    """Keep native shapes once and deselect direct/indirect TestCase items."""

    pytester.makepyfile(
        mixed_partition_test="""
            import unittest

            import pytest


            class DirectCase(unittest.TestCase):
                def test_direct(self):
                    raise AssertionError("unittest TestCase must be deselected")


            class IndirectCase(DirectCase):
                def test_indirect(self):
                    raise AssertionError("indirect TestCase must be deselected")


            def test_native_function():
                assert True


            class TestNativeClass:
                def test_method(self):
                    assert True


            @pytest.mark.parametrize("value", [1, 2])
            def test_native_parametrized(value):
                assert value in (1, 2)
        """
    )

    collected = pytester.runpytest(
        "--collect-only",
        "-q",
        "-p",
        "no:cacheprovider",
        plugins=[pytest_native_only],
    )
    node_ids = sorted(
        line.strip()
        for line in collected.stdout.lines
        if line.startswith("mixed_partition_test.py::")
    )
    assert node_ids == [
        "mixed_partition_test.py::TestNativeClass::test_method",
        "mixed_partition_test.py::test_native_function",
        "mixed_partition_test.py::test_native_parametrized[1]",
        "mixed_partition_test.py::test_native_parametrized[2]",
    ]
    assert len(node_ids) == len(set(node_ids))
    collected.stdout.fnmatch_lines(["*4/7 tests collected (3 deselected)*"])

    executed = pytester.runpytest(
        "-q",
        "-p",
        "no:cacheprovider",
        plugins=[pytest_native_only],
    )
    executed.assert_outcomes(passed=4, deselected=3)


# ARIA-LOW-599 — the pytest half accounts for its real-sandbox pin skips the
# way the unittest shard runner does: on the kernel lane (`aria-suite-run.sh
# --pytest-native` passes --refuse-sandbox-skips) a pin that skipped is a
# containment proof that did not run, so the run is refused, not green.
_SANDBOX_PIN_FIXTURE = """
    import pytest

    from tests._helpers.sandbox_pins import skip_sandbox_pin


    def test_pin_that_cannot_run_here():
        skip_sandbox_pin("fixture host has no bwrap")


    def test_unrelated_skip():
        pytest.skip("not a sandbox pin")


    def test_passes():
        assert True
"""


def test_the_lane_option_refuses_a_skipped_sandbox_pin(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(sandbox_pin_fixture_test=_SANDBOX_PIN_FIXTURE)

    refused = pytester.runpytest(
        "-q", "-rs", "-p", "no:cacheprovider", "--refuse-sandbox-skips", plugins=[pytest_native_only]
    )

    refused.assert_outcomes(passed=1, skipped=2)
    assert refused.ret == pytest.ExitCode.TESTS_FAILED
    refused.stdout.fnmatch_lines([
        "*refused: 1 real-sandbox pin skipped*",
        "*sandbox_pin_fixture_test.py::test_pin_that_cannot_run_here*",
    ])
    assert "test_unrelated_skip" not in "\n".join(
        line for line in refused.stdout.lines if line.startswith("  sandbox_pin_fixture_test.py::")
    )


def test_off_the_lane_a_skipped_sandbox_pin_stays_a_skip(pytester: pytest.Pytester) -> None:
    # A laptop or a host without user namespaces: the pin skips, which is the
    # sandbox's own fail-closed contract, and the run is not refused.
    pytester.makepyfile(sandbox_pin_fixture_test=_SANDBOX_PIN_FIXTURE)

    plain = pytester.runpytest("-q", "-p", "no:cacheprovider", plugins=[pytest_native_only])

    plain.assert_outcomes(passed=1, skipped=2)
    assert plain.ret == pytest.ExitCode.OK


def test_the_lane_option_passes_a_run_whose_pins_all_ran(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        clean_fixture_test="""
            import pytest

            def test_passes():
                assert True

            def test_unrelated_skip():
                pytest.skip("not a sandbox pin")
        """
    )

    clean = pytester.runpytest(
        "-q", "-p", "no:cacheprovider", "--refuse-sandbox-skips", plugins=[pytest_native_only]
    )

    clean.assert_outcomes(passed=1, skipped=1)
    assert clean.ret == pytest.ExitCode.OK
