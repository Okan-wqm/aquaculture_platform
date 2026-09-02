"""The workspace HMAC key is secret material, not a function of the path.

The audit's reproduction class: ``_derive_workspace_key`` hashed the
tools-root PATH, so anyone who can name the directory can re-derive every
token's key minted in it. Both promotion lanes (auto and panel) share this
one derivation, so these pins cover both token families:

1. The key for a recreated store at the SAME path differs — the path alone
   must never be enough to re-derive the key.
2. An explicit ``ARIA_WORKSPACE_HMAC_KEY`` external secret overrides any
   local material, and rotating it changes the key.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.adapter_calibration import _derive_workspace_key
from aria_kernel.tool_registry import ensure_tools_dir


class WorkspaceKeySecrecyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-wk-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self._saved_env = os.environ.pop("ARIA_WORKSPACE_HMAC_KEY", None)
        if self._saved_env is not None:
            self.addCleanup(
                lambda: os.environ.__setitem__("ARIA_WORKSPACE_HMAC_KEY", self._saved_env)
            )

    def test_key_is_not_the_hash_of_the_path(self) -> None:
        store = self._tmp / "aria-tools"
        root = ensure_tools_dir(store)
        path_hash = hashlib.sha256(str(root.resolve()).encode("utf-8")).digest()
        self.assertNotEqual(
            _derive_workspace_key(root),
            path_hash,
            "the workspace key must not be derivable from public knowledge "
            "(the tools-root path)",
        )

    def test_recreated_store_at_the_same_path_gets_a_different_key(self) -> None:
        store = self._tmp / "aria-tools"
        root = ensure_tools_dir(store)
        first = _derive_workspace_key(root)

        shutil.rmtree(store, ignore_errors=True)
        fresh_root = ensure_tools_dir(store)
        self.assertNotEqual(
            _derive_workspace_key(fresh_root),
            first,
            "a recreated store at the same path must not accept replayed "
            "tokens minted under the old key",
        )

    def test_external_secret_overrides_and_rotates(self) -> None:
        root = ensure_tools_dir(self._tmp / "aria-tools")
        local = _derive_workspace_key(root)

        os.environ["ARIA_WORKSPACE_HMAC_KEY"] = "ab" * 32
        with_secret = _derive_workspace_key(root)
        self.assertNotEqual(with_secret, local)

        os.environ["ARIA_WORKSPACE_HMAC_KEY"] = "cd" * 32
        self.assertNotEqual(_derive_workspace_key(root), with_secret)


if __name__ == "__main__":
    unittest.main()
