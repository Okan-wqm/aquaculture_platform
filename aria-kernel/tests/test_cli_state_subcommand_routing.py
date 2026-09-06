"""ORPHAN-CRITICAL-806 — every `state` subcommand must reach its handler.

`_handle_state_command` routes a named set of subcommands to
`_handle_state_store_command` and lets everything else fall through to
verify-snapshot's tail. `compact` was declared in the parser, implemented
in the store handler, and missing from the routing set — so it fell
through and died on `args.snapshot`, an option it does not declare.

The daily state-maintenance lane is compact's only caller. It switched
from its inline compactor to this command on 2026-09-02 (5cd847add) and
has failed every scheduled run since, with an AttributeError naming an
argument belonging to a different command. Compaction stopped, the
artifact index kept rows for files that were already swept, and
`verify_artifacts` then failed every nightly cycle (ORPHAN-CRITICAL-805).

These pins are behavioural: they call the dispatcher, not the routing set,
so a subcommand added tomorrow and forgotten here fails as a routing
error rather than as a crash inside an unrelated command.
"""
from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cli import _handle_state_command, build_parser
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _declared_state_subcommands() -> list[str]:
    parser = build_parser()
    for action in parser._subparsers._group_actions:  # noqa: SLF001 - argparse has no public reader
        state = action.choices.get("state")
        if state is None:
            continue
        for sub in state._subparsers._group_actions:  # noqa: SLF001
            return sorted(sub.choices)
    raise AssertionError("the `state` parser is no longer registered")


class StateSubcommandRoutingTests(unittest.TestCase):
    def test_compact_is_declared(self) -> None:
        self.assertIn("compact", _declared_state_subcommands())

    def test_compact_reaches_its_handler(self) -> None:
        """The regression itself: this raised AttributeError('snapshot')."""
        with tempfile.TemporaryDirectory(prefix="aria-state-routing-") as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            args = argparse.Namespace(
                state_command="compact",
                tools_dir=str(tools),
                retain_days=7,
                dry_run=True,
            )
            self.assertEqual(_handle_state_command(args), 0)

    def test_an_unrouted_subcommand_names_itself(self) -> None:
        """A missing route must not borrow another command's arguments."""
        args = argparse.Namespace(state_command="a-command-nobody-routed")
        with self.assertRaises(GovernanceError) as caught:
            _handle_state_command(args)
        self.assertIn("state_subcommand_not_routed", str(caught.exception))
        # The old failure mode, explicitly excluded: it must not complain
        # about an argument that belongs to verify-snapshot.
        self.assertNotIn("snapshot", str(caught.exception).replace("state_subcommand_not_routed", ""))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
