"""Plan 032 Faz 032d — single-worker delivery closure.

Invariants:
  I-V12-DLV-01  exactly one runtime profile (implementer) holds `external_writes`;
                since ARIA-HIGH-124 the grant is the EXECUTOR's delivery credential:
                the Claude permission projection allows no push for any profile
                and denies `git push`, the kernel CLI, force-push and gh api.
  I-V12-DLV-02  `issue_delivery_credentials` returns None without the grant; with
                it the env carries GH_TOKEN + an env-only git credential helper,
                the governance ledger names the env keys, mode, consumer, mint
                instant and coverage window but NEVER the token value, PAT mode
                fires `installation_token_fallback_active`, a mint failure is a
                refusal (governance row + error), the revoke runs under the
                lease's OWN token, and (round 6) a lease whose provider horizon
                cannot cover the window it is asked to cover is revoked and
                refused `provider_expiry_short` by name.
  I-V12-DLV-03  the built spawn env accepts executor extras verbatim; `run_claude_exec`
                exposes `extra_env`; the executor ADMITS the credential source
                before the spawn (`admit_delivery_credentials`: one lease minted
                and revoked at once) and the DELIVERY mints the lease where it is
                consumed (`deliver_implementation` enters `hold_delivery_credentials`
                after the gate, around the push and the PR — ARIA-HIGH-124 round
                6); the spawn seam carries no GH_TOKEN (source-level pins).
  I-V12-DLV-04  `pr_manager` keys intents on ARIA_REQUEST_ID inside a spawn and on
                `proposal:<id>` outside it; postconditions carry proposal_id.
  I-V12-DLV-05  delivery closure derives the closed state vocabulary from real
                ledger rows: accepted-without-PR is false success, two PRs for one
                request is a duplicate, own_pr_ci `cleared` is the verified state,
                and the SLO cannot be met by anything but ≥3 verified PRs.
  I-V12-DLV-06  `doctor` carries the `delivery_closure` organ (fail on duplicates,
                warn on false success) and the CLI exposes `delivery status`.
  I-V12-DLV-07  the implementer agent file is back under the 200-line cap.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import inspect
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import delivery_closure as dc
from aria_kernel import delivery_credentials as dcred
from aria_kernel import recovery
from aria_kernel.agent_env import build_agent_env
from aria_kernel.command_policy import claude_permission_rules, claude_rule_matches
from aria_kernel.doctor import run_doctor
from aria_kernel.gh_token_factory import InstallationTokenLease
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.runtime_profiles import load_runtime_profiles
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


def _lease(tmp: Path, token: str, *, fallback: bool, provider_expiry: str | None = None) -> InstallationTokenLease:
    path = tmp / "lease.token"
    path.write_text(token, encoding="utf-8")
    return InstallationTokenLease(
        cycle_id="cyc-test-1", token_file=path, ttl_seconds=600,
        gh_app_installation_id=None if fallback else "42", fallback_active=fallback,
        minted_at_utc=datetime.now(timezone.utc).isoformat(), provider_expiry=provider_expiry,
    )


class TheGrantIsSingular(unittest.TestCase):
    def test_I_V12_DLV_01_only_the_implementer_writes_externally(self) -> None:
        profiles = load_runtime_profiles()
        holders = [pid for pid, p in profiles.items() if p.external_writes]
        self.assertEqual(holders, ["implementer"])
        allow, deny = claude_permission_rules(external_writes=True)
        # ARIA-HIGH-124 — the push is the executor's: no allow projection
        # admits it for any grant, and the deny projection names it.
        self.assertFalse(any(claude_rule_matches(r, "git push origin aria-impl-0abc12") for r in allow), allow)
        self.assertTrue(any(claude_rule_matches(r, "git push origin aria-impl-0abc12") for r in deny), deny)
        self.assertTrue(any(claude_rule_matches(r, "python3 -m aria_kernel pr create --x") for r in deny), deny)
        from aria_kernel.implementation_safety import BashDenylistHit, verify_bash_command_allowed

        with self.assertRaises(BashDenylistHit):
            verify_bash_command_allowed(["git", "push", "origin", "aria-impl-0abc12"])
        with self.assertRaises(BashDenylistHit):
            verify_bash_command_allowed(["git", "push", "--force", "origin", "main"])
        self.assertTrue(any(claude_rule_matches(r, "gh api repos/x/y -X DELETE") for r in deny), deny)


class CredentialsAreScoped(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _governance_text(self) -> str:
        return (self.tools / "governance.jsonl").read_text(encoding="utf-8")

    def test_I_V12_DLV_02_none_without_grant_scoped_with_it(self) -> None:
        closed = SimpleNamespace(external_writes=False, profile_id="worker")
        self.assertIsNone(dcred.issue_delivery_credentials(
            profile=closed, request_id="AIR-1", cycle_id="cyc-1", workspace_root=self.root, base_dir=self.tools,
            mint=lambda **kw: self.fail("mint must not run without the grant"),
        ))
        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        seen: dict[str, object] = {}

        def mint(**kw):
            seen.update(kw)
            return _lease(self.root, "ghs_secretvalue_123", fallback=False)

        cred = dcred.issue_delivery_credentials(
            profile=granted, request_id="AIR-1", cycle_id="x", workspace_root=self.root, base_dir=self.tools,
            ttl_seconds=60, mint=mint,
        )
        self.assertIsNotNone(cred)
        assert cred is not None
        self.assertEqual(cred.env["GH_TOKEN"], "ghs_secretvalue_123")
        self.assertEqual(cred.env["GIT_CONFIG_VALUE_0"], "!gh auth git-credential")
        self.assertEqual(cred.mode, "installation")
        self.assertEqual(seen["ttl_seconds"], dcred.MIN_DELIVERY_TTL_SECONDS, "TTL floor binds")
        self.assertRegex(str(seen["cycle_id"]), r"^[A-Za-z0-9_-]{6,64}$")
        text = self._governance_text()
        self.assertIn(dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT, text)
        self.assertIn('"GH_TOKEN"', text, "env NAMES are recorded")
        self.assertNotIn("ghs_secretvalue_123", text, "the value never lands on a ledger")
        self.assertNotIn(dcred.INSTALLATION_TOKEN_FALLBACK_EVENT, text)
        # (round 6) the row says WHO consumes it, WHEN it was minted (the
        # lease's own sub-second instant) and for how long it must live.
        issued = self._governance_rows(dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT)
        self.assertEqual(len(issued), 1, issued)
        self.assertEqual(issued[0]["details"]["consumer"], dcred.DELIVERY_CREDENTIAL_CONSUMER)
        self.assertEqual(issued[0]["details"]["covers_seconds"], dcred.DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS)
        self.assertEqual(issued[0]["details"]["minted_at_utc"], cred.lease.minted_at_utc)
        self.assertIsNone(issued[0]["details"]["provider_expiry"])

        revoked: list[tuple[str, str | None]] = []

        def revoke(*, lease, environment):  # noqa: ANN001 — the factory's revoke shape
            revoked.append((lease.cycle_id, (environment or {}).get("GH_TOKEN")))
            return "revoked"

        dcred.revoke_delivery_credentials(cred, request_id="AIR-1", base_dir=self.tools, revoke=revoke)
        # (round 6) the revoke runs under the lease's OWN token: `DELETE
        # /installation/token` revokes the token it is called with, and the
        # value lives only in the credential's env.
        self.assertEqual(revoked, [("cyc-test-1", "ghs_secretvalue_123")])
        self.assertFalse(cred.lease.token_file.exists())
        self.assertIn(dcred.DELIVERY_CREDENTIAL_REVOKED_EVENT, self._governance_text())

    def _governance_rows(self, kind: str) -> list[dict]:
        return [json.loads(line) for line in self._governance_text().splitlines()
                if line.strip() and json.loads(line).get("kind") == kind]

    def test_I_V12_DLV_02_a_provider_horizon_that_cannot_cover_the_window_is_revoked_and_refused(self) -> None:
        # ARIA-HIGH-124 (round 6) — the credential is minted for a window
        # (`covers_seconds`: the push and the PR opener at their bounds).
        # A lease whose PROVIDER expiry falls inside that window would die
        # under the subprocess it serves: refused by name, the lease it
        # minted revoked with its own value, nothing issued; one that
        # covers it is issued and the row carries the horizon. A horizon
        # the holder cannot read is refused the same way.
        from aria_kernel.state_store import GIT_TIMEOUT_SECONDS
        from aria_kernel.pr_manager import GH_PR_CREATE_TIMEOUT_SECONDS
        from aria_kernel.gh_token_factory import (
            INSTALLATION_TOKEN_MINT_TIMEOUT_SECONDS,
            INSTALLATION_TOKEN_REVOKE_TIMEOUT_SECONDS,
            PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS,
        )

        self.assertEqual(dcred.DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS, GIT_TIMEOUT_SECONDS + GH_PR_CREATE_TIMEOUT_SECONDS)
        self.assertLessEqual(dcred.DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS, PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS,
                             "the consumption window fits the provider's hour by construction")
        self.assertEqual(dcred.MAX_DELIVERY_TTL_SECONDS, PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS)
        self.assertEqual(dcred.DEFAULT_DELIVERY_TTL_SECONDS, dcred.DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS)
        self.assertEqual(dcred.DELIVERY_CREDENTIAL_WORST_CASE_SECONDS,
                         INSTALLATION_TOKEN_MINT_TIMEOUT_SECONDS + INSTALLATION_TOKEN_REVOKE_TIMEOUT_SECONDS)
        window = dcred.DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS
        self.assertIsNone(dcred.provider_horizon_refusal(None, covers_seconds=window))
        self.assertIsNone(dcred.provider_horizon_refusal("2026-01-01T01:00:00Z", covers_seconds=window,
                                                         now=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc).timestamp()))
        self.assertEqual(
            dcred.provider_horizon_refusal("2026-01-01T00:05:00Z", covers_seconds=window,
                                           now=datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc).timestamp()),
            f"provider_expiry_short:expires_at=2026-01-01T00:05:00Z:covers={window}s:remaining=300s",
        )
        self.assertEqual(dcred.provider_horizon_refusal("soon", covers_seconds=window), "provider_expiry_unreadable:'soon'")
        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        revoked: list[tuple[str, str | None]] = []

        def revoke(*, lease, environment):  # noqa: ANN001 — the factory's revoke shape
            revoked.append((lease.cycle_id, (environment or {}).get("GH_TOKEN")))
            return "revoked"

        short = (datetime.now(timezone.utc) + timedelta(seconds=window - 1)).isoformat()
        with self.assertRaisesRegex(dcred.DeliveryCredentialError, r"delivery_credential_unavailable:provider_expiry_short:"):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-h1", cycle_id="cyc-horizon", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: _lease(self.root, "ghs_dies_too_soon", fallback=False, provider_expiry=short),
                revoke=revoke, covers_seconds=window,
            )
        self.assertEqual(revoked, [("cyc-test-1", "ghs_dies_too_soon")], "the minted lease is revoked with its own value")
        self.assertFalse((self.root / "lease.token").exists())
        refused = self._governance_rows(dcred.DELIVERY_CREDENTIAL_REFUSED_EVENT)
        self.assertEqual([row["details"]["error_class"] for row in refused], ["ProviderHorizonShort"])
        self.assertEqual((refused[0]["details"]["provider_expiry"], refused[0]["details"]["covers_seconds"],
                          refused[0]["details"]["revoke_outcome"]), (short, window, "revoked"))
        self.assertEqual(self._governance_rows(dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT), [])
        self.assertNotIn("ghs_dies_too_soon", self._governance_text())
        with self.assertRaisesRegex(dcred.DeliveryCredentialError, r"provider_expiry_unreadable"):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-h2", cycle_id="cyc-horizon", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: _lease(self.root, "ghs_unreadable", fallback=False, provider_expiry="tomorrow"),
                revoke=revoke, covers_seconds=window,
            )
        # The positive half: a horizon past the window is issued, recorded.
        covering = (datetime.now(timezone.utc) + timedelta(seconds=PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS)).isoformat()
        cred = dcred.issue_delivery_credentials(
            profile=granted, request_id="AIR-h3", cycle_id="cyc-horizon", workspace_root=self.root, base_dir=self.tools,
            mint=lambda **kw: _lease(self.root, "ghs_covers", fallback=False, provider_expiry=covering),
            revoke=revoke, covers_seconds=window,
        )
        assert cred is not None
        self.assertEqual(cred.lease.provider_expiry, covering)
        issued = self._governance_rows(dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT)
        self.assertEqual([row["details"]["provider_expiry"] for row in issued], [covering])
        with self.assertRaises(ValueError):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-h4", cycle_id="cyc-horizon", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: self.fail("an unknown consumer is refused before any mint"), consumer="agent_spawn",
            )

    def test_I_V12_DLV_02_the_admission_mints_and_revokes_at_once_and_reads_nothing(self) -> None:
        # ARIA-HIGH-124 (round 6) — what the executor runs BEFORE the spawn:
        # one lease through the same hold the delivery uses (the real mint
        # in sentinel mode), revoked before the call returns, its value
        # read by nobody; recorded as an admission (`consumer:
        # executor_admission`, then `delivery_credential_admitted`), so a
        # ledger reader can tell the admission's mint from the delivery's.
        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        workspace = self.root / "workspace"
        workspace.mkdir()
        dirs_before = {path.name for path in Path(tempfile.gettempdir()).iterdir() if path.name.startswith(dcred.PRIVATE_TOKEN_DIR_PREFIX)}
        with mock.patch.dict(os.environ, {"ARIA_DRY_RUN": "true"}):
            admission = dcred.admit_delivery_credentials(
                profile=granted, request_id="AIR-adm", cycle_id="cyc-admission", workspace_root=workspace, base_dir=self.tools,
            )
        assert admission is not None
        self.assertEqual((admission.mode, admission.provider_expiry), ("dry_run", None))
        self.assertFalse(hasattr(admission, "env"), "the admission hands out no value")
        dirs_after = {path.name for path in Path(tempfile.gettempdir()).iterdir() if path.name.startswith(dcred.PRIVATE_TOKEN_DIR_PREFIX)}
        self.assertEqual(dirs_after, dirs_before, "the admission's private directory is gone with its revoke")
        kinds = [json.loads(line)["kind"] for line in self._governance_text().splitlines()
                 if line.strip() and json.loads(line)["kind"].startswith("delivery_credential_")]
        self.assertEqual(kinds, [dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT, dcred.DELIVERY_CREDENTIAL_REVOKED_EVENT,
                                 dcred.DELIVERY_CREDENTIAL_ADMITTED_EVENT])
        issued = self._governance_rows(dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT)
        self.assertEqual([row["details"]["consumer"] for row in issued], [dcred.DELIVERY_CREDENTIAL_ADMISSION_CONSUMER])
        admitted = self._governance_rows(dcred.DELIVERY_CREDENTIAL_ADMITTED_EVENT)
        self.assertEqual((admitted[0]["details"]["mode"], admitted[0]["details"]["covers_seconds"]),
                         ("dry_run", dcred.DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS))
        self.assertEqual(
            dcred.DELIVERY_CREDENTIAL_CONSUMERS, ("executor_admission", "executor_delivery", "self_revert_delivery"),
        )
        # Without the grant: nothing minted, nothing recorded.
        closed = SimpleNamespace(external_writes=False, profile_id="worker")
        self.assertIsNone(dcred.admit_delivery_credentials(
            profile=closed, request_id="AIR-adm2", cycle_id="cyc-admission", workspace_root=workspace, base_dir=self.tools,
        ))
        self.assertEqual(len(self._governance_rows(dcred.DELIVERY_CREDENTIAL_ADMITTED_EVENT)), 1)
        # A lane that cannot mint is refused here, by name.
        with mock.patch.object(dcred, "mint_installation_token", side_effect=RuntimeError("no app")):
            with self.assertRaisesRegex(dcred.DeliveryCredentialError, "delivery_credential_unavailable:RuntimeError"):
                dcred.admit_delivery_credentials(
                    profile=granted, request_id="AIR-adm3", cycle_id="cyc-admission", workspace_root=workspace, base_dir=self.tools,
                )

    def test_I_V12_DLV_02_pat_fallback_and_refusal_are_visible(self) -> None:
        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        cred = dcred.issue_delivery_credentials(
            profile=granted, request_id="AIR-2", cycle_id="cyc-2", workspace_root=self.root, base_dir=self.tools,
            mint=lambda **kw: _lease(self.root, "ghp_operatorpat", fallback=True),
        )
        assert cred is not None
        self.assertEqual(cred.mode, "pat_fallback")
        self.assertIn(dcred.INSTALLATION_TOKEN_FALLBACK_EVENT, self._governance_text())
        with self.assertRaises(dcred.DeliveryCredentialError):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-3", cycle_id="cyc-3", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: (_ for _ in ()).throw(RuntimeError("no app")),
            )
        self.assertIn(dcred.DELIVERY_CREDENTIAL_REFUSED_EVENT, self._governance_text())
        with self.assertRaises(dcred.DeliveryCredentialError):
            dcred.issue_delivery_credentials(
                profile=granted, request_id="AIR-4", cycle_id="cyc-4", workspace_root=self.root, base_dir=self.tools,
                mint=lambda **kw: _lease(self.root, "", fallback=False),
            )

    def test_I_V12_DLV_02_the_token_file_lives_in_a_private_directory_outside_the_workspace(self) -> None:
        # ARIA-HIGH-124 (round 5) — the hold makes a 0700 directory of its
        # own OUTSIDE the workspace and the REAL mint (sentinel mode: no
        # network, no PAT) writes the token file there, 0600 (observed
        # through the mint the hold uses); the hold reads it into memory
        # and unlinks it at once, so while the hold is open the directory
        # is EMPTY; the issued row says where the file was as a fact; the
        # revoke removes the directory. Until round 5 the file sat at
        # `<workspace>/aria-debts/keys/<lease>.token`, inside every
        # sandbox's workspace bind, for the hold's whole lifetime.
        from aria_kernel import gh_token_factory

        granted = SimpleNamespace(external_writes=True, profile_id="implementer")
        workspace = self.root / "workspace"
        workspace.mkdir()
        minted: list[tuple[Path, int]] = []
        real_mint = gh_token_factory.mint_installation_token

        def observing_mint(**kwargs):
            lease = real_mint(**kwargs)
            minted.append((Path(lease.token_file), Path(lease.token_file).stat().st_mode & 0o777))
            return lease

        with mock.patch.dict(os.environ, {"ARIA_DRY_RUN": "true"}), \
                mock.patch.object(dcred, "mint_installation_token", observing_mint):
            with dcred.hold_delivery_credentials(
                profile=granted, request_id="AIR-5", cycle_id="cyc-round-5", workspace_root=workspace, base_dir=self.tools,
            ) as cred:
                assert cred is not None
                token_file = Path(cred.lease.token_file)
                self.assertEqual(minted, [(token_file, 0o600)])
                self.assertFalse(token_file.exists(), "the token is in memory; the file is consumed at once")
                self.assertEqual(token_file.parent, cred.token_dir)
                assert cred.token_dir is not None
                self.assertEqual(list(cred.token_dir.iterdir()), [])
                self.assertEqual(cred.token_dir.stat().st_mode & 0o777, 0o700)
                self.assertFalse(cred.token_dir.is_relative_to(workspace.resolve()))
                self.assertTrue(cred.token_dir.name.startswith(dcred.PRIVATE_TOKEN_DIR_PREFIX))
                self.assertFalse((workspace / "aria-debts" / "keys").exists(), "nothing was written under the workspace")
                self.assertEqual((cred.mode, cred.env["GH_TOKEN"]), ("dry_run", dcred.DRY_RUN_TOKEN_SENTINEL))
        self.assertFalse(token_file.exists())
        self.assertFalse(cred.token_dir.exists(), "the private directory goes with the revoke")
        issued = [json.loads(line) for line in self._governance_text().splitlines()
                  if json.loads(line).get("kind") == dcred.DELIVERY_CREDENTIAL_ISSUED_EVENT]
        self.assertEqual([row["details"]["token_file_outside_workspace"] for row in issued], [True])
        # A profile without the grant makes no directory at all.
        closed = SimpleNamespace(external_writes=False, profile_id="worker")
        with dcred.hold_delivery_credentials(
            profile=closed, request_id="AIR-6", cycle_id="cyc-none", workspace_root=workspace, base_dir=self.tools,
        ) as none:
            self.assertIsNone(none)

    def test_I_V12_DLV_02_a_token_directory_that_is_not_private_is_refused_before_any_token(self) -> None:
        # The mint's own guard, and the hold's: a directory inside the
        # workspace, a group-readable one, an absent one — each refused by
        # name before a token is fetched or written; a process temp dir
        # that resolves INTO the workspace refuses the hold itself instead
        # of falling back to the keys dir.
        from aria_kernel.gh_token_factory import TokenDirectoryUnusable, mint_installation_token

        workspace = self.root / "workspace"
        workspace.mkdir()
        inside = workspace / "private"
        inside.mkdir(mode=0o700)
        loose = self.root / "loose"
        loose.mkdir(mode=0o750)
        with mock.patch.dict(os.environ, {"ARIA_DRY_RUN": "true"}):
            with self.assertRaisesRegex(TokenDirectoryUnusable, "token_dir_inside_workspace"):
                mint_installation_token(cycle_id="cyc-round-5", workspace_root=workspace, token_dir=inside)
            with self.assertRaisesRegex(TokenDirectoryUnusable, "token_dir_mode_not_private"):
                mint_installation_token(cycle_id="cyc-round-5", workspace_root=workspace, token_dir=loose)
            with self.assertRaisesRegex(TokenDirectoryUnusable, "token_dir_not_a_directory"):
                mint_installation_token(cycle_id="cyc-round-5", workspace_root=workspace, token_dir=self.root / "absent")
            self.assertEqual(sorted(path.name for path in (inside, loose) for path in path.iterdir()), [])
            granted = SimpleNamespace(external_writes=True, profile_id="implementer")
            with mock.patch.object(tempfile, "tempdir", str(inside)):
                with self.assertRaisesRegex(dcred.DeliveryCredentialError, "token_dir_inside_workspace"):
                    with dcred.hold_delivery_credentials(
                        profile=granted, request_id="AIR-7", cycle_id="cyc-round-5", workspace_root=workspace,
                        base_dir=self.tools,
                    ):
                        self.fail("a hold whose directory sits inside the workspace must not yield")
            self.assertEqual(list(inside.iterdir()), [], "the refused directory was removed")
            # And a mint refusal through the hold is a credential refusal.
            with mock.patch.object(dcred, "private_token_dir", return_value=loose):
                with self.assertRaisesRegex(dcred.DeliveryCredentialError, "TokenDirectoryUnusable:token_dir_mode_not_private"):
                    with dcred.hold_delivery_credentials(
                        profile=granted, request_id="AIR-8", cycle_id="cyc-round-5", workspace_root=workspace,
                        base_dir=self.tools,
                    ):
                        self.fail("must not yield")
        self.assertIn(dcred.DELIVERY_CREDENTIAL_REFUSED_EVENT, self._governance_text())
        self.assertFalse((workspace / "aria-debts").exists(), "no token was written under the workspace")

    def test_I_V12_DLV_02_the_sweep_removes_a_dead_holds_directory_and_leaves_a_live_one(self) -> None:
        # ARIA-HIGH-124 (round 6) — an executor killed mid-hold leaves its
        # private directory (and, between the mint's write and the hold's
        # read, the token file) in the process temp dir. The startup sweep
        # removes one older than the provider's hour — with its contents —
        # and leaves a younger one, which is a live hold's.
        import inspect

        from aria_kernel import autonomy_orchestrator

        temp_root = self.root / "temp"
        temp_root.mkdir()
        dead = temp_root / f"{dcred.PRIVATE_TOKEN_DIR_PREFIX}dead0000"
        dead.mkdir(mode=0o700)
        (dead / "cyc-dead.token").write_text("ghp_left_behind", encoding="utf-8")
        stale = self.root.stat().st_mtime - dcred.MAX_DELIVERY_TTL_SECONDS - 5
        os.utime(dead, (stale, stale))
        live = temp_root / f"{dcred.PRIVATE_TOKEN_DIR_PREFIX}live0000"
        live.mkdir(mode=0o700)
        (temp_root / "aria-other-thing").mkdir()
        swept = dcred.prune_stale_delivery_credential_dirs(temp_root=temp_root)
        self.assertEqual((swept["swept"], swept["live"], swept["errors"]), ([dead.name], [live.name], []))
        self.assertFalse(dead.exists(), "the dead hold's directory goes with the file it held")
        self.assertTrue(live.exists())
        self.assertTrue((temp_root / "aria-other-thing").exists(), "not the sweep's to remove")
        self.assertEqual(dcred.prune_stale_delivery_credential_dirs(temp_root=temp_root)["swept"], [])
        # Wired into the same startup sweep as the broker sockets.
        source = inspect.getsource(autonomy_orchestrator)
        self.assertIn('"delivery_credential_dirs": prune_stale_delivery_credential_dirs(),', source)

    def test_I_V12_DLV_03_extras_reach_the_built_env_and_the_executor_holds_the_credential(self) -> None:
        built = build_agent_env({"PATH": "/usr/bin", "GH_TOKEN": "ambient"}, profile_passthrough=(),
                                extra={"ARIA_REQUEST_ID": "AIR-9"}, home=self.root / "home")
        self.assertEqual(built.env["ARIA_REQUEST_ID"], "AIR-9")
        self.assertNotIn("GH_TOKEN", built.env, "the ambient token is dropped; the executor adds none")
        import claude_runtime

        self.assertIn("extra_env", inspect.signature(claude_runtime.run_claude_exec).parameters)
        executor = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        # ARIA-HIGH-124 (round 6) — the executor ADMITS the credential
        # source before the spawn (one lease minted and revoked at once)
        # and holds NO lease across it: the delivery mints where it
        # consumes. The spawn extras carry the request id and nothing
        # credential-shaped.
        self.assertIn("admit_delivery_credentials(", executor)
        self.assertNotIn("hold_delivery_credentials(", executor, "the executor holds no lease across the spawn")
        self.assertNotIn("spawn_extra_env.update(delivery_credential.env)", executor)
        self.assertNotIn("issue_delivery_credentials(", executor)
        self.assertNotIn("credential_environment=", executor)
        main_body = executor[executor.index("def _main("):]
        admit = main_body.index("admit_delivery_credentials(")
        spawn = main_body.index("cli_exit = invoke_claude_cli(")
        deliver = main_body.index("deliver_implementation(")
        self.assertLess(admit, spawn, "admitted before the spawn")
        self.assertLess(spawn, deliver, "delivered after it")
        self.assertIn("profile=_delivery_profile,", main_body[deliver:])
        # ARIA-HIGH-124 (round 4) — and the delivery is handed the identity
        # this process HOLDS, so it can verify the tip before it spends the
        # credential on a push.
        self.assertIn("signer_key_fp=implementation_identity.fingerprint,", executor)
        self.assertIn('"ARIA_REQUEST_ID": str(request_id)', executor)
        # The hold itself: issued on entry, revoked on every exit.
        source = inspect.getsource(dcred.hold_delivery_credentials)
        self.assertIn("issue_delivery_credentials(", source)
        self.assertIn("finally:", source)
        self.assertIn("revoke_delivery_credentials(", source)
        self.assertEqual(dcred.DELIVERY_CREDENTIAL_CONSUMER, "executor_delivery")
        # (round 6) and the DELIVERY enters it after the gate, around the
        # push and the PR, for exactly the consumption window.
        from aria_kernel import implementation_delivery

        delivery = inspect.getsource(implementation_delivery.deliver_implementation)
        gate = delivery.index("run_apply_gate(")
        hold = delivery.index("hold_delivery_credentials(")
        push = delivery.index('["push", _PUSH_REMOTE')
        opener = delivery.index("open_pr_for_action(")
        self.assertLess(gate, hold, "minted after the gate")
        self.assertLess(hold, push, "minted before the push")
        self.assertLess(push, opener)
        self.assertIn("covers_seconds=DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS", delivery)
        self.assertIn("with ExitStack() as credential_hold:", delivery)


class IntentsAreKeyedOnTheRequest(unittest.TestCase):
    def test_I_V12_DLV_04_request_id_from_env(self) -> None:
        self.assertEqual(dcred.request_id_from_env("proposal:p1", environ={}), "proposal:p1")
        self.assertEqual(dcred.request_id_from_env("proposal:p1", environ={"ARIA_REQUEST_ID": "AIR-7"}), "AIR-7")
        from aria_kernel import pr_manager

        with mock.patch.dict(os.environ, {"ARIA_REQUEST_ID": "AIR-7"}):
            self.assertEqual(pr_manager._effect_request_id("p1"), "AIR-7")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ARIA_REQUEST_ID", None)
            self.assertEqual(pr_manager._effect_request_id("p1"), "proposal:p1")
        source = (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "pr_manager.py").read_text(encoding="utf-8")
        self.assertNotIn('request_id=f"proposal:{proposal_id}"', source)
        self.assertEqual(source.count('"proposal_id": proposal_id}'), 2, "both postconditions carry the proposal")


class ClosureIsDerived(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _row(self, rel: tuple[str, ...], surface: str, row: dict) -> None:
        path = self.tools.joinpath(*rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, {"schema_version": 1, "recorded_at": "2026-09-03T00:00:00+00:00", **row}, expected_surface=surface)

    def _request(self, rid: str, role: str = "implementation") -> None:
        self._row(("agent-invocations", "requests.jsonl"), "agent_invocation_requests",
                  {"row_id": f"request:{rid}", "row_type": "request", "request_id": rid, "role": role,
                   "target_agent": "aria-implementer", "state": "PENDING", "created_at": f"2026-09-03T00:00:0{rid[-1]}+00:00"})

    def _claim(self, rid: str, cid: str, *, release: str | None = None) -> None:
        self._row(("agent-invocations", "claims.jsonl"), "agent_invocation_claims",
                  {"row_type": "claim", "event": "claimed", "claim_id": cid, "request_id": rid, "agent_id": "aria-implementer"})
        if release:
            self._row(("agent-invocations", "claims.jsonl"), "agent_invocation_claims",
                      {"row_type": "claim", "event": "released", "claim_id": cid, "request_id": rid, "reason": release})

    def _accept(self, rid: str, cid: str) -> None:
        self._row(("agent-invocations", "results.jsonl"), "agent_invocation_results",
                  {"row_id": f"result:{cid}", "row_type": "result", "claim_id": cid, "request_id": rid, "status": "accepted", "role": "implementation"})

    def _pr(self, rid: str, number: int, *, proposal: str) -> None:
        push = recovery.record_intent(request_id=rid, effect_kind="git_push", target=f"origin/aria-impl-{number}",
                                      intended_postcondition={"branch": f"aria-impl-{number}", "proposal_id": proposal}, base_dir=self.tools)
        recovery.record_receipt(operation_id=push["operation_id"], request_id=rid, observed={"branch": f"aria-impl-{number}"}, base_dir=self.tools)
        intent = recovery.record_intent(request_id=rid, effect_kind="pr_create", target=f"main<-aria-impl-{number}",
                                        intended_postcondition={"head_ref": f"aria-impl-{number}", "proposal_id": proposal}, base_dir=self.tools)
        recovery.record_receipt(operation_id=intent["operation_id"], request_id=rid,
                                observed={"pr_number": number, "url": f"https://github.com/o/r/pull/{number}"}, base_dir=self.tools)

    def _ci(self, number: int, status: str, red: list[str] | None = None) -> None:
        self._row(("ci", "own-pr-checks.jsonl"), "own_pr_checks",
                  {"cycle_id": "cyc", "pr_number": number, "head_ref": f"aria-impl-{number}", "head_sha": "a" * 40,
                   "red_jobs": red or [], "status": status})

    def test_I_V12_DLV_05_states_and_slo_from_rows(self) -> None:
        self._request("AIR-1"); self._request("AIR-2"); self._request("AIR-3"); self._request("AIR-4"); self._request("AIR-5")
        self._request("AIR-6", role="challenger_plan")
        # AIR-1: accepted, nothing delivered → false success
        self._claim("AIR-1", "c1"); self._accept("AIR-1", "c1")
        # AIR-2: delivered + verified
        self._claim("AIR-2", "c2"); self._accept("AIR-2", "c2"); self._pr("AIR-2", 20, proposal="p2"); self._ci(20, "cleared")
        # AIR-3: PR red
        self._claim("AIR-3", "c3"); self._accept("AIR-3", "c3"); self._pr("AIR-3", 30, proposal="p3"); self._ci(30, "open", ["aria-kernel"])
        # AIR-4: two PRs for one request → duplicate
        self._claim("AIR-4", "c4"); self._accept("AIR-4", "c4"); self._pr("AIR-4", 40, proposal="p4"); self._pr("AIR-4", 41, proposal="p4")
        # AIR-5: released twice, nothing else
        self._claim("AIR-5", "c5a", release="claude_cli_exit_1"); self._claim("AIR-5", "c5b", release="submit_timeout_120s")
        report = dc.compute_delivery_closure(base_dir=self.tools)
        states = {r.request_id: r.state for r in report.records}
        self.assertEqual(states, {"AIR-1": "result_accepted", "AIR-2": "ci_green", "AIR-3": "ci_red",
                                  "AIR-4": "duplicate", "AIR-5": "released"})
        self.assertNotIn("AIR-6", states, "only implementation requests are delivery requests")
        rec = {r.request_id: r for r in report.records}
        self.assertTrue(rec["AIR-2"].delivered)
        self.assertEqual(rec["AIR-2"].pr_numbers, [20])
        self.assertEqual(rec["AIR-3"].red_jobs, ["aria-kernel"])
        self.assertEqual(rec["AIR-5"].last_release_reason, "submit_timeout_120s")
        self.assertEqual(rec["AIR-4"].proposal_ids, ["p4"])
        s = report.summary
        self.assertEqual((s["verified_prs"], s["false_success"], s["duplicate_prs"], s["red_prs"]), (1, 1, 1, 1))
        self.assertFalse(s["slo"]["met"])
        self.assertEqual(s["slo"]["gaps"], ["verified_prs<3", "false_success>0", "duplicate_prs>0"])
        self.assertEqual(set(s["by_state"]), set(dc.DELIVERY_STATES))
        for state in states.values():
            self.assertIn(state, dc.DELIVERY_STATES)

    def test_I_V12_DLV_05_pending_intents_merge_and_lifecycle_link(self) -> None:
        self._request("AIR-1"); self._claim("AIR-1", "c1"); self._accept("AIR-1", "c1")
        recovery.record_intent(request_id="AIR-1", effect_kind="git_push", target="origin/aria-impl-9",
                               intended_postcondition={"branch": "aria-impl-9", "proposal_id": "p9"}, base_dir=self.tools)
        report = dc.compute_delivery_closure(base_dir=self.tools)
        self.assertEqual(report.records[0].state, "push_pending")
        self.assertEqual(report.summary["unresolved_intents"], 1)
        # a lifecycle `opened` row for the same proposal links the PR even without a receipt
        self._row(("pr-lifecycle.jsonl",), "pr_lifecycle", {"cycle_id": "cyc", "event": "opened", "pr_number": 9, "proposal_id": "p9"})
        report = dc.compute_delivery_closure(base_dir=self.tools)
        self.assertEqual((report.records[0].state, report.records[0].pr_numbers), ("pr_opened", [9]))
        self._row(("ci", "merge-outcomes.jsonl"), "merge_outcomes",
                  {"cycle_id": "cyc", "pr_number": 9, "head_ref": "aria-impl-9", "merge_sha": "b" * 40, "red_jobs": [], "pending_jobs": [], "status": "green"})
        report = dc.compute_delivery_closure(base_dir=self.tools)
        self.assertEqual(report.records[0].state, "merged")
        self.assertTrue(report.records[0].delivered)
        text = dc.render_delivery_text(report)
        self.assertIn("AIR-1", text)
        self.assertIn("SLO met: false", text)

    def test_I_V12_DLV_06_doctor_organ_and_cli(self) -> None:
        healthy = run_doctor(base_dir=self.tools, workspace_root=self.root)
        organ = next(c for c in healthy.checks if c.name == "delivery_closure")
        self.assertEqual((organ.status, organ.reason), ("ok", "no_implementation_requests"))
        self._request("AIR-1"); self._claim("AIR-1", "c1"); self._accept("AIR-1", "c1")
        organ = next(c for c in run_doctor(base_dir=self.tools, workspace_root=self.root).checks if c.name == "delivery_closure")
        self.assertEqual(organ.status, "warn")
        self._pr("AIR-1", 1, proposal="p1"); self._pr("AIR-1", 2, proposal="p1")
        organ = next(c for c in run_doctor(base_dir=self.tools, workspace_root=self.root).checks if c.name == "delivery_closure")
        self.assertEqual((organ.status, organ.reason), ("fail", "duplicate_prs"))
        from aria_kernel.cli import build_parser

        args = build_parser().parse_args(["delivery", "status", "--json"])
        self.assertEqual((args.command, args.delivery_command, args.json), ("delivery", "status", True))

    def test_I_V12_DLV_07_implementer_agent_file_within_cap(self) -> None:
        text = (_REPO_ROOT / ".claude" / "agents" / "aria-implementer.md").read_text(encoding="utf-8")
        self.assertLessEqual(text.count("\n"), 200)
        self.assertIn("runtime_profile: implementer", text)


if __name__ == "__main__":
    unittest.main()
