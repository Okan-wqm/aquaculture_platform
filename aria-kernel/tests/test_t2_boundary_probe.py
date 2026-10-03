"""ARIA-HIGH-281 / ADR-0023 — ARIA's runner (T2) holds no operator capability: enforced and measured.

Two halves, both from ADR-0023 ("What keeps T2 from signing or approving"):

* where signers are verified, the kernel refuses an anchor that enrols a key
  the runner holds (a cycle key registered in ``kg_signers`` or held in the
  workspace signing-key directory), and an enrolment chain a runner key
  signed into, so no T2 key can admit an operator act;
* the T2 probe measures, as the runner account, every capability the ADR
  forbids it (the operator key, uid 0, sudo, docker, a personal token, an
  enrolled key). The hourly host timer runs it as ``gharunner`` and publishes
  the verdict the droplet alert reads.

Every key here is a throwaway minted in a temp dir; no test opens the
operator's key path (the probe's paths are pointed into the temp dir). The
live probe runs as an invariant when this suite runs as ``gharunner``, the
identity the ADR names; elsewhere the probe is driven through its
collaborators.
"""
from __future__ import annotations

import contextlib
import hashlib
import inspect
import io
import json
import os
import pwd
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import yaml

from aria_kernel import habitat
from aria_kernel import operator_request_signature as ors
from aria_kernel.knowledge_graph import fingerprint_of_public_key, register_convention_signer
from aria_kernel.mcp_server import AriaMcpServer
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_requests import (
    ALL_OPERATOR_NAMESPACES,
    OperatorRequestFixture,
    allowed_signers_line,
    git,
    mint_ed25519_key,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HABITAT = _REPO_ROOT / "scripts" / "aria" / "runner-habitat" / "systemd"
_RULES = _REPO_ROOT / "infrastructure" / "monitoring" / "droplet" / "rules" / "80-aria-t2-boundary.yml"
# ADR-0023 names the runner account; the habitat drop-in pins it.
_T2_ACCOUNT = "gharunner"


def _clean_env() -> mock._patch:
    env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
    return mock.patch.dict(os.environ, env, clear=True)


@contextlib.contextmanager
def _as_runner(*, user: str = "gharunner", uid: int = 1000, sudo: str = "denied",
               groups: frozenset[str] = frozenset({"gharunner"})):
    """The probe's view of its own account, without asking this host's root account anything."""
    with mock.patch.object(habitat.pwd, "getpwuid", return_value=SimpleNamespace(pw_name=user)), \
            mock.patch.object(habitat.os, "geteuid", return_value=uid), \
            mock.patch.object(habitat, "_sudo_verdict", return_value=sudo), \
            mock.patch.object(habitat, "_group_names", return_value=groups):
        yield


class KernelKeySeparationTests(unittest.TestCase):
    """An anchor that enrols a key ARIA's runner holds is no anchor (ADR-0023 guard 3)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-t2-keys-")
        self.addCleanup(self.tmp.cleanup)
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name) / "fixture")
        self.base = git(self.fx.repo, "rev-parse", "HEAD").strip()
        self.signers = (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).read_text(encoding="utf-8")
        self.cycle_key = mint_ed25519_key(Path(self.tmp.name) / "cycle", name="cycle")
        self.with_cycle_key = self.signers + allowed_signers_line(
            "cycle@aria.test", self.cycle_key, namespace=ALL_OPERATOR_NAMESPACES)

    def _reason(self) -> str | None:
        return ors.allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools)[1]

    def _register(self, key: Path) -> None:
        public = key.with_suffix(".pub").read_text(encoding="utf-8").strip()
        register_convention_signer(cycle_id="cycle-t2-probe", signer_key_fp=fingerprint_of_public_key(public),
                                   public_key=public, base_dir=self.fx.tools)

    def _enrol_by_hand(self, allowed_signers: str) -> None:
        """An enrolment the operator's key signs past ``aria-kernel feedback enrol`` (which refuses it)."""
        anchor = ors.allowed_signers_at(self.fx.repo, commit=git(self.fx.repo, "rev-parse", "HEAD").strip(),
                                        base_dir=self.fx.tools)
        assert anchor is not None
        registry = (self.fx.repo / ors.NAMESPACE_REGISTRY_PATH).read_bytes()
        row = dict(ors.enrolment_genesis_row(allowed_signers.encode(), registry), kind="enrolment",
                   parent={"allowed_signers": "sha256:" + hashlib.sha256(anchor.content).hexdigest(),
                           "registry": "sha256:" + hashlib.sha256(registry).hexdigest()},
                   actor_class="T0", audience=anchor.audience,
                   expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
        signed = ors.sign_operator_subject(row, namespace=ors.ENROL_NAMESPACE, domain_tag="aria-operator-enrol/v1",
                                           signing_key=self.fx.key, signer_principal=self.fx.principal)
        ledger = (self.fx.repo / ors.ENROLMENTS_PATH).read_text(encoding="utf-8")
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: allowed_signers,
                              ors.ENROLMENTS_PATH: ledger + json.dumps(signed, sort_keys=True) + "\n"})

    def test_a_registered_runner_key_enrolled_for_the_operator_leaves_no_anchor(self) -> None:
        self._register(self.cycle_key)
        with self.assertRaisesRegex(GovernanceError, ors.RUNNER_KEY_ENROLLED):
            self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.with_cycle_key})
        git(self.fx.repo, "checkout", "-q", "--", ors.ALLOWED_SIGNERS_PATH)
        self.assertIsNone(self._reason())
        self._enrol_by_hand(self.with_cycle_key)
        self.assertEqual(self._reason(), ors.RUNNER_KEY_ENROLLED)
        server = AriaMcpServer(base_dir=self.fx.tools, workspace_root=self.fx.repo, allow_writes=True)
        refused = server.call_tool("runtime_signal_ingest", {
            "source": "operator", "service": "s", "summary": "s", "code_refs": ["a.py"],
            "operator_approval": {"actor_class": "T0"}})
        self.assertIn(f"mcp_write_anchor_unavailable: {ors.RUNNER_KEY_ENROLLED}", refused["content"][0]["text"])
        # The operator removes the key the only way the chain allows: a signed enrolment.
        self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.signers})
        self.assertIsNone(self._reason())

    def test_a_key_held_in_the_workspace_key_directory_is_the_runners(self) -> None:
        keys = self.fx.repo / "aria-debts" / "keys"
        keys.mkdir(parents=True)
        (keys / "cycle-held.pub").write_text(self.cycle_key.with_suffix(".pub").read_text(encoding="utf-8"),
                                             encoding="utf-8")
        self._enrol_by_hand(self.with_cycle_key)
        self.assertEqual(self._reason(), ors.RUNNER_KEY_ENROLLED)

    def test_an_enrolment_a_runner_key_signed_breaks_the_chain_for_good(self) -> None:
        self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.with_cycle_key})
        self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.with_cycle_key + "# signed by the newcomer\n"},
                      key=self.cycle_key, principal="cycle@aria.test")
        self.assertIsNone(self._reason())
        self._register(self.cycle_key)
        self.assertEqual(self._reason(), ors.ENROL_SIGNED_BY_RUNNER_KEY)
        with self.assertRaisesRegex(GovernanceError, ors.ENROL_SIGNED_BY_RUNNER_KEY):
            self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: self.signers})

    def test_an_unreadable_runner_key_record_leaves_no_anchor(self) -> None:
        self._register(self.cycle_key)
        with (self.fx.tools / "knowledge-graph" / "signers.jsonl").open("a", encoding="utf-8") as handle:
            handle.write('{"public_key": "forged"}\n')
        self.assertEqual(self._reason(), ors.RUNNER_KEYS_UNAVAILABLE)

    def test_every_trust_reader_names_the_store_it_excludes_runner_keys_from(self) -> None:
        for function, parameter in ((ors.allowed_signers_for_checkout, "base_dir"), (ors.allowed_signers_at, "base_dir"),
                                    (ors.record_enrolment, "base_dir"), (ors.verify_enrolment_chain, "runner_keys")):
            with self.subTest(function=function.__name__):
                self.assertIs(inspect.signature(function).parameters[parameter].default, inspect.Parameter.empty)


class ProbeTests(unittest.TestCase):
    """The probe judges each capability ADR-0023 forbids T2, as the running account sees it."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-t2-probe-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.key_dir = self.root / "ssh"
        self.key_dir.mkdir()
        operator = mint_ed25519_key(self.root / "operator", name="op")
        self.allowed = allowed_signers_line("op@aria.test", operator, namespace=ALL_OPERATOR_NAMESPACES).encode()
        self.env = self.root / "runner.env"
        self.env.write_text("ARIA_OBSERVABILITY_API_KEY=not-a-token\n", encoding="utf-8")

    def _probe(self, **overrides) -> habitat.T2Boundary:
        options = {"allowed_signers": self.allowed, "registered_keys": frozenset(), "key_dirs": [self.key_dir],
                   "runner_env": self.env, "operator_key": self.root / "root" / "aria-operator-signing",
                   "docker_socket": self.root / "docker.sock"}
        options.update(overrides)
        return habitat.probe_t2_boundary(**options)

    def test_an_account_that_holds_nothing_holds_the_boundary(self) -> None:
        with _as_runner():
            boundary = self._probe()
        self.assertEqual((boundary.identity, boundary.violations, boundary.held), (_T2_ACCOUNT, (), True))
        self.assertEqual(habitat.T2_RUNNER_USER, _T2_ACCOUNT)

    def test_each_capability_the_adr_forbids_is_a_named_violation(self) -> None:
        readable_key = self.root / "readable-key"
        readable_key.write_text("x", encoding="utf-8")
        socket = self.root / "docker.sock"
        socket.write_text("", encoding="utf-8")
        cases = {
            "runner_uid_is_root": ({"user": "root", "uid": 0}, {}),
            "probe_not_run_as_gharunner": ({"user": "ubuntu"}, {}),
            "operator_key_readable": ({}, {"operator_key": readable_key}),
            "sudo_admitted": ({"sudo": "admitted"}, {}),
            "sudo_inconclusive": ({"sudo": "inconclusive"}, {}),
            "docker_group_member": ({"groups": frozenset({"gharunner", "docker"})}, {}),
            "docker_socket_reachable": ({}, {"docker_socket": socket}),
            "runner_env_unreadable": ({}, {"runner_env": self.key_dir}),
            "runner_key_registry_unavailable": ({}, {"registered_keys": None}),
            "allowed_signers_unavailable": ({}, {"allowed_signers": None}),
        }
        for reason, (account, overrides) in cases.items():
            with self.subTest(reason=reason), _as_runner(**account):
                boundary = self._probe(**overrides)
                self.assertIn(reason, boundary.violations)
                self.assertFalse(boundary.held)

    def test_a_personal_token_in_the_runner_env_is_a_violation_and_an_app_token_is_not(self) -> None:
        for text, held in (("TOKEN=ghp_" + "a" * 36 + "\n", False), ("X=github_pat_" + "b" * 40 + "\n", False),
                           ("ARIA_GH_TOKEN=anything\n", False), ("APP=ghs_" + "c" * 36 + "\n", True)):
            self.env.write_text(text, encoding="utf-8")
            with self.subTest(text=text[:8]), _as_runner():
                boundary = self._probe()
                self.assertEqual(boundary.held, held, boundary.violations)
                self.assertNotIn("a" * 36, json.dumps(boundary.violations), "a token value is never echoed")

    def test_a_key_the_runner_holds_or_registered_is_never_enrolled(self) -> None:
        cycle = mint_ed25519_key(self.key_dir, name="cycle")
        blob = cycle.with_suffix(".pub").read_text(encoding="utf-8").split()[1]
        enrolled = self.allowed + allowed_signers_line("cycle@aria.test", cycle, namespace="aria-operator-request").encode()
        with _as_runner():
            self.assertIn("runner_key_enrolled", self._probe(allowed_signers=enrolled).violations)
            cycle.with_suffix(".pub").unlink()  # the private half alone is holding the key
            self.assertIn("runner_key_enrolled", self._probe(allowed_signers=enrolled).violations)
            cycle.unlink()
            self.assertTrue(self._probe(allowed_signers=enrolled).held)
            registered = self._probe(allowed_signers=enrolled, registered_keys=frozenset({blob}))
            self.assertEqual(registered.violations, ("runner_key_enrolled",))

    def test_the_verdict_is_published_in_the_textfile_format_the_alert_reads(self) -> None:
        with _as_runner(sudo="admitted"):
            text = habitat.t2_boundary_textfile(self._probe(), probed_at=1_700_000_000.5)
        self.assertIn("aria_t2_boundary_held 0\n", text)
        self.assertIn('aria_t2_boundary_violation{reason="sudo_admitted"} 1\n', text)
        self.assertIn("aria_t2_boundary_probe_timestamp_seconds 1700000000\n", text)

    def test_the_key_readers_agree_with_ssh_keygen(self) -> None:
        cycle = mint_ed25519_key(self.root / "sig", name="k")
        blob = cycle.with_suffix(".pub").read_text(encoding="utf-8").split()[1]
        lines = f'# comment {blob}\nprincipal namespaces="a,b" ssh-ed25519 {blob} c\n'.encode()
        self.assertEqual(ors.enrolled_key_blobs(lines), {blob})
        data = self.root / "data"
        data.write_bytes(b"subject")
        subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(cycle), "-n", "aria-test", str(data)],
                       check=True, capture_output=True, stdin=subprocess.DEVNULL)
        self.assertEqual(ors.signature_key_blob(data.with_name("data.sig").read_text(encoding="ascii")), blob)
        self.assertIsNone(ors.signature_key_blob("-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n"))


class ProbeCliTests(unittest.TestCase):
    """`aria-kernel habitat t2-probe` — the verb the hourly timer runs."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-t2-cli-")
        self.addCleanup(self.tmp.cleanup)
        patcher = _clean_env()
        patcher.start()
        self.addCleanup(patcher.stop)
        root = Path(self.tmp.name)
        self.fx = OperatorRequestFixture(root / "fixture")
        self.env = root / "runner.env"
        self.env.write_text("ARIA_OBSERVABILITY_API_KEY=x\n", encoding="utf-8")
        self.textfile = root / "aria_t2_boundary.prom"
        for name, value in (("OPERATOR_SIGNING_KEY", root / "no-operator-key"), ("DOCKER_SOCKET", root / "no-docker")):
            paths = mock.patch.object(habitat, name, value)
            paths.start()
            self.addCleanup(paths.stop)

    def _run(self) -> tuple[int, dict]:
        from aria_kernel.cli import main as cli_main

        out = io.StringIO()
        with contextlib.redirect_stdout(out), _as_runner():
            code = cli_main(["habitat", "t2-probe", "--workspace-root", str(self.fx.repo), "--runner-env", str(self.env),
                             "--key-dir", str(self.fx.repo / "aria-debts" / "keys"), "--textfile", str(self.textfile),
                             "--tools-dir", str(self.fx.tools)])
        return code, json.loads(out.getvalue())

    def test_the_verb_judges_the_allowed_signers_on_main_and_publishes_the_verdict(self) -> None:
        code, verdict = self._run()
        self.assertEqual((code, verdict["held"], verdict["violations"]), (0, True, []))
        self.assertEqual(verdict["allowed_signers_commit"], git(self.fx.repo, "rev-parse", "HEAD").strip())
        self.assertIn("aria_t2_boundary_held 1\n", self.textfile.read_text(encoding="utf-8"))
        keys = self.fx.repo / "aria-debts" / "keys"
        held = mint_ed25519_key(keys, name="cycle-held")
        signers = (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).read_text(encoding="utf-8")
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: signers + allowed_signers_line("c@aria.test", held)})
        code, verdict = self._run()
        self.assertEqual((code, verdict["violations"]), (3, ["runner_key_enrolled"]))
        self.assertIn('aria_t2_boundary_violation{reason="runner_key_enrolled"} 1', self.textfile.read_text())


class HourlyProbeHabitatTests(unittest.TestCase):
    """The hourly timer runs the probe as gharunner, with nothing in the unit answering for the account."""

    def _settings(self, name: str, section: str) -> dict[str, str]:
        import configparser

        parser = configparser.ConfigParser(strict=False, interpolation=None)
        parser.optionxform = str  # systemd keys are case-sensitive
        parser.read_string((_HABITAT / name).read_text(encoding="utf-8"))
        return dict(parser[section])

    def test_the_service_runs_the_root_owned_probe_as_gharunner_and_masks_nothing(self) -> None:
        service = self._settings("aria-t2-probe.service", "Service")
        self.assertEqual((service["User"], service["Group"]), ("gharunner", "gharunner"))
        for masking in ("NoNewPrivileges", "SupplementaryGroups", "InaccessiblePaths", "ProtectHome", "PrivateUsers"):
            self.assertNotIn(masking, service, f"{masking} would answer for the account under test")
        self.assertEqual(service["ExecStart"], "/var/lib/aria/code/scripts/aria/aria-t2-probe.sh")
        self.assertIn("/var/lib/node_exporter/textfile/aria_t2_boundary.prom", service["ExecStopPost"])
        timer = self._settings("aria-t2-probe.timer", "Timer")
        self.assertEqual((timer["OnCalendar"], timer["Persistent"], timer["Unit"]),
                         ("hourly", "true", "aria-t2-probe.service"))
        script = (_REPO_ROOT / "scripts" / "aria" / "aria-t2-probe.sh").read_text(encoding="utf-8")
        self.assertIn("habitat t2-probe", script)
        self.assertIn('--key-dir "$HOME/.ssh"', script)

    def test_the_provisioner_installs_the_probe_with_the_habitat_and_enables_it(self) -> None:
        script = (_REPO_ROOT / "scripts" / "aria" / "provision_runner.sh").read_text(encoding="utf-8")
        for unit in ("aria-t2-probe.service", "aria-t2-probe.timer"):
            self.assertIn(f"${{HABITAT_SYSTEMD}}/{unit}|/etc/systemd/system/{unit}", script)
        self.assertIn("systemctl enable --now aria-t2-probe.timer", script)

    def test_the_alerts_read_the_series_the_probe_publishes(self) -> None:
        rules = {rule["alert"]: rule for group in yaml.safe_load(_RULES.read_text(encoding="utf-8"))["groups"]
                 for rule in group["rules"]}
        with _as_runner(sudo="admitted"):
            published = habitat.t2_boundary_textfile(habitat.probe_t2_boundary(
                allowed_signers=None, registered_keys=frozenset(), key_dirs=[], runner_env=Path("/nonexistent"),
                operator_key=Path("/nonexistent"), docker_socket=Path("/nonexistent")), probed_at=0)
        breach, silent = rules["AriaT2BoundaryBreached"], rules["AriaT2BoundaryProbeSilent"]
        self.assertEqual((breach["labels"]["severity"], silent["labels"]["severity"]), ("critical", "warning"))
        self.assertIn("aria_t2_boundary_held == 0", breach["expr"])
        self.assertIn("aria_t2_boundary_probe_timestamp_seconds", silent["expr"])
        for series in ("aria_t2_boundary_held", "aria_t2_boundary_probe_timestamp_seconds"):
            self.assertIn(f"\n{series} ", "\n" + published)


@unittest.skipUnless(pwd.getpwuid(os.geteuid()).pw_name == _T2_ACCOUNT,
                     "the live T2 invariant runs as the runner account ADR-0023 names (gharunner)")
class LiveT2BoundaryInvariant(unittest.TestCase):
    """Run as gharunner on the runner host: the account holds no operator capability."""

    def test_the_runner_account_holds_no_operator_capability(self) -> None:
        runner_root = Path(os.environ.get("ARIA_RUNNER_ROOT", "/home/gharunner/actions-runner"))
        boundary = habitat.probe_t2_boundary(
            allowed_signers=(_REPO_ROOT / ors.ALLOWED_SIGNERS_PATH).read_bytes(), registered_keys=frozenset(),
            key_dirs=[Path.home() / ".ssh"], runner_env=runner_root / ".env")
        self.assertEqual(boundary.violations, ())


if __name__ == "__main__":
    unittest.main()
