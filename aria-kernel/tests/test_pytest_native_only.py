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
