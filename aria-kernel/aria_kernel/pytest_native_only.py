"""Select pytest-native tests without re-running unittest TestCase items."""

from __future__ import annotations

import unittest

import pytest


def _is_unittest_test_case(item: pytest.Item) -> bool:
    """Return whether pytest collected ``item`` from a TestCase descendant."""

    class_collector = item.getparent(pytest.Class)
    return class_collector is not None and issubclass(class_collector.obj, unittest.TestCase)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Deselect TestCase items, which the runner executes through unittest."""

    selected: list[pytest.Item] = []
    deselected: list[pytest.Item] = []
    for item in items:
        (deselected if _is_unittest_test_case(item) else selected).append(item)

    items[:] = selected
    if deselected:
        config.hook.pytest_deselected(items=deselected)
