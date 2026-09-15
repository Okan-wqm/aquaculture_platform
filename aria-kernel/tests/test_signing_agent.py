"""ARIA-HIGH-123 — the kernel-held ssh-agent: the sandbox signs, never reads.

`signing_agent.hold_signing_agent` runs an ssh-agent as a child of the
kernel for the identity window, loads one key into it, and yields the socket
the sandbox is handed. One property per test:

* the agent holds exactly the key it was given (its fingerprint, nothing
  else), on a socket in a fresh directory, and dies with the window — the
  socket and its directory are gone on exit, however the body exits;
* the agent dies with its HOLDER however the holder dies: a holder killed
  with SIGKILL (the OOM-kill / deadline-kill class the runner lives under,
  which never reaches a `finally`) takes the agent with it
  (`PR_SET_PDEATHSIG`), and the sweep removes the socket directory it left;
* the key expires from the agent at the window's deadline (`-t`): a
  lifetime the holder computes from `ARIA_JOB_DEADLINE_EPOCH`, refused by
  name when the window has already closed;
* the agent's environment is minimal (PATH and its socket): the holder's
  environ — the executor's, credentials included — is not inherited;
* a provider library cannot be loaded through the socket (`-P '!*'`):
  `ssh-add -s` is refused by the agent;
* `ssh-keygen -Y sign -f <private path>` with the private file ABSENT and
  the `.pub` beside it signs through the agent (the form git 2.43 uses when
  `user.signingkey` names the private path), and the signature verifies
  against the public key; without the agent the same call fails by name;
* a key the agent cannot load, or a missing binary, is refused by name and
  leaves no agent behind.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import signing_agent as sa
from aria_kernel.signing_agent import (
    DEFAULT_LIFETIME_SECONDS,
    MAX_LIFETIME_SECONDS,
    SigningAgentUnavailable,
    hold_signing_agent,
    lifetime_until,
    prune_stale_signing_agents,
)


def _fingerprint(public_key: Path) -> str:
    done = subprocess.run(["ssh-keygen", "-lf", str(public_key)], capture_output=True, text=True, check=True)
    return next(part for part in done.stdout.split() if part.startswith("SHA256:"))


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie is not alive: its parent (init, after the holder died) reaps it.
    try:
        state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state != "Z"


class SigningAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        if shutil.which("ssh-agent") is None or shutil.which("ssh-keygen") is None:
            self.skipTest("openssh client tools are not on this host")
        self.root = Path(tempfile.mkdtemp(prefix="aria-sa-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.key = self.root / "cycle-key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "aria-cycle-fixture", "-f", str(self.key)],
                       check=True)
        self.fingerprint = _fingerprint(self.key.with_suffix(".pub"))

    def _listed(self, socket_path: Path) -> list[str]:
        done = subprocess.run(["ssh-add", "-l"], capture_output=True, text=True,
                              env={**os.environ, "SSH_AUTH_SOCK": str(socket_path)})
        return [line.split()[1] for line in done.stdout.splitlines()] if done.returncode == 0 else []

    def test_the_agent_holds_exactly_the_one_key_and_dies_with_the_window(self) -> None:
        with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint) as agent:
            self.assertEqual(agent.fingerprint, self.fingerprint)
            self.assertTrue(agent.socket_path.is_socket())
            self.assertEqual(self._listed(agent.socket_path), [self.fingerprint])
            self.assertTrue(agent.socket_path.parent.name.startswith("aria-sa-"))
            self.assertEqual(agent.lifetime_seconds, DEFAULT_LIFETIME_SECONDS)
            socket_path, pid = agent.socket_path, agent.pid
        self.assertFalse(socket_path.parent.exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_the_agent_dies_when_the_body_raises(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "fixture body"):
            with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint) as agent:
                socket_path, pid = agent.socket_path, agent.pid
                raise RuntimeError("fixture body")
        self.assertFalse(socket_path.exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_a_holder_killed_outright_takes_the_agent_with_it_and_the_sweep_removes_its_directory(self) -> None:
        # The holder: a child python process that holds the agent and
        # reports the agent's pid and socket, then waits to be killed.
        temp_root = self.root / "temp"
        temp_root.mkdir()
        holder = subprocess.Popen(
            [sys.executable, "-c",
             "import sys, time\n"
             "from aria_kernel.signing_agent import hold_signing_agent\n"
             f"with hold_signing_agent({str(self.key)!r}, expected_fingerprint={self.fingerprint!r}) as agent:\n"
             "    print(agent.pid, agent.socket_path, flush=True)\n"
             "    time.sleep(120)\n"],
            stdout=subprocess.PIPE, text=True,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "TMPDIR": str(temp_root)},
        )
        try:
            line = holder.stdout.readline().split()
            agent_pid, socket_path = int(line[0]), Path(line[1])
            self.assertTrue(socket_path.is_socket())
            self.assertEqual(self._listed(socket_path), [self.fingerprint])
            self.assertEqual(socket_path.parent.parent, temp_root)
            holder.kill()
            holder.wait(timeout=10)
        finally:
            if holder.poll() is None:
                holder.kill()
        deadline = time.monotonic() + 5.0
        while _alive(agent_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(_alive(agent_pid), "the agent outlived a SIGKILLed holder")
        self.assertTrue(socket_path.parent.exists(), "the killed holder never reached its cleanup")
        self.assertEqual(self._listed(socket_path), [], "nothing answers on the socket")
        swept = prune_stale_signing_agents(temp_root=temp_root)
        self.assertEqual(swept["swept"], [socket_path.parent.name])
        self.assertFalse(socket_path.parent.exists())

    def test_the_sweep_leaves_a_live_agent_alone(self) -> None:
        temp_root = self.root / "temp"
        temp_root.mkdir()
        (temp_root / "aria-sa-dead0000").mkdir()
        (temp_root / "aria-sa-dead0000" / "agent").write_text("", encoding="utf-8")
        # Not the sweep's to remove: a fixture root under the same prefix, a
        # directory with files of its own.
        (temp_root / "aria-sa-test-not-an-agent-dir").mkdir()
        (temp_root / "aria-sa-files000").mkdir()
        (temp_root / "aria-sa-files000" / "cycle-key").write_text("", encoding="utf-8")
        with mock.patch.object(tempfile, "tempdir", str(temp_root)):
            with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint) as agent:
                swept = prune_stale_signing_agents(temp_root=temp_root)
                self.assertTrue(agent.socket_path.is_socket(), "the live agent's socket survives the sweep")
                self.assertEqual(self._listed(agent.socket_path), [self.fingerprint])
        self.assertEqual(swept["live"], [agent.socket_path.parent.name])
        self.assertEqual(swept["swept"], ["aria-sa-dead0000"])
        self.assertFalse((temp_root / "aria-sa-dead0000").exists())
        self.assertTrue((temp_root / "aria-sa-test-not-an-agent-dir").exists())
        self.assertTrue((temp_root / "aria-sa-files000" / "cycle-key").exists())

    def test_the_key_expires_from_the_agent_at_the_lifetime(self) -> None:
        with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint, lifetime_seconds=1) as agent:
            self.assertEqual(agent.lifetime_seconds, 1)
            self.assertEqual(self._listed(agent.socket_path), [self.fingerprint])
            deadline = time.monotonic() + 5.0
            while self._listed(agent.socket_path) and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertEqual(self._listed(agent.socket_path), [], "the key is gone from the agent after its lifetime")
            self.assertTrue(agent.socket_path.is_socket(), "the agent itself is still the holder's to stop")

    def test_the_lifetime_is_the_windows_remaining_time_and_a_closed_window_is_refused(self) -> None:
        self.assertEqual(lifetime_until(None), DEFAULT_LIFETIME_SECONDS)
        self.assertEqual(lifetime_until(1_000.0, now=400.0), 600)
        self.assertEqual(lifetime_until(1_000.0, now=1_000.0), 0)
        self.assertEqual(lifetime_until(1_000.0, now=1_500.0), -500)
        self.assertEqual(lifetime_until(10_000_000.0, now=0.0), MAX_LIFETIME_SECONDS)
        for closed in (0, -5, MAX_LIFETIME_SECONDS + 1):
            with self.subTest(lifetime=closed), self.assertRaises(SigningAgentUnavailable) as refused:
                with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint, lifetime_seconds=closed):
                    self.fail("unreachable")
            self.assertEqual(refused.exception.reason, "lifetime_invalid")

    def test_the_identity_holder_bounds_the_lifetime_by_the_job_deadline(self) -> None:
        import ast

        source = (Path(__file__).resolve().parents[1] / "aria_kernel" / "implementation_identity.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        call = next(node for node in ast.walk(tree)
                    if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "hold_signing_agent")
        keywords = {keyword.arg: keyword for keyword in call.keywords}
        self.assertIn("lifetime_seconds", keywords)
        self.assertIn("lifetime_until", ast.dump(keywords["lifetime_seconds"].value))
        self.assertIn("JOB_DEADLINE_EPOCH_ENV", ast.dump(keywords["lifetime_seconds"].value))

    def test_the_agents_environment_is_minimal(self) -> None:
        with mock.patch.dict(os.environ, {"FIXTURE_SECRET_TOKEN": "leaked-if-seen", "GH_TOKEN": "leaked-if-seen"}):
            with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint) as agent:
                try:
                    environ = Path(f"/proc/{agent.pid}/environ").read_bytes()
                except PermissionError:
                    self.skipTest("the agent's environ is not readable by this uid (non-dumpable), which is the point")
        names = sorted(entry.split(b"=", 1)[0].decode() for entry in environ.split(b"\0") if entry)
        self.assertEqual(names, ["PATH", "SSH_AUTH_SOCK"])
        self.assertNotIn(b"leaked-if-seen", environ)

    def test_a_provider_library_cannot_be_loaded_through_the_socket(self) -> None:
        library = next((path for path in Path("/usr/lib").rglob("libc.so.6")), None)
        if library is None:
            self.skipTest("no shared library to name")
        with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint) as agent:
            done = subprocess.run(
                ["ssh-add", "-s", str(library)], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                env={**os.environ, "SSH_AUTH_SOCK": str(agent.socket_path)}, timeout=15,
            )
            self.assertNotEqual(done.returncode, 0)
            self.assertIn("agent refused operation", done.stderr)
            self.assertEqual(self._listed(agent.socket_path), [self.fingerprint], "the agent holds its one key still")
        self.assertEqual(sa.NO_PROVIDER_PATTERN, "!*")

    def test_ssh_keygen_signs_through_the_agent_with_the_private_file_absent(self) -> None:
        hidden = self.root / "elsewhere"
        hidden.mkdir()
        shape = self.root / "sandbox-view"
        shape.mkdir()
        shutil.copy(self.key.with_suffix(".pub"), shape / "cycle-key.pub")
        payload = self.root / "payload"
        payload.write_text("tree 0000\n", encoding="utf-8")
        with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint) as agent:
            signed = subprocess.run(
                ["ssh-keygen", "-Y", "sign", "-n", "git", "-f", str(shape / "cycle-key"), str(payload)],
                capture_output=True, text=True, env={**os.environ, "SSH_AUTH_SOCK": str(agent.socket_path)},
            )
            self.assertEqual(signed.returncode, 0, signed.stderr)
            self.assertTrue(payload.with_suffix(".sig").is_file())
            allowed = self.root / "allowed"
            key_type, key_blob = self.key.with_suffix(".pub").read_text(encoding="utf-8").split()[:2]
            allowed.write_text(f"aria-cycle-fixture {key_type} {key_blob}\n", encoding="utf-8")
            with payload.open("rb") as handle:
                verified = subprocess.run(
                    ["ssh-keygen", "-Y", "verify", "-f", str(allowed), "-I", "aria-cycle-fixture", "-n", "git",
                     "-s", str(payload.with_suffix(".sig"))],
                    stdin=handle, capture_output=True, text=True,
                )
            self.assertEqual(verified.returncode, 0, verified.stderr)
            payload.with_suffix(".sig").unlink()
            unsigned = subprocess.run(
                ["ssh-keygen", "-Y", "sign", "-n", "git", "-f", str(shape / "cycle-key"), str(payload)],
                capture_output=True, text=True, env={**os.environ, "SSH_AUTH_SOCK": str(self.root / "nowhere")},
            )
        self.assertNotEqual(unsigned.returncode, 0)
        self.assertIn("No private key found", unsigned.stderr)

    @staticmethod
    def _live_agent_dirs() -> set[Path]:
        return {path for path in Path(tempfile.gettempdir()).glob("aria-sa-*")
                if path.is_dir() and (path / sa._SOCKET_NAME).exists()}

    def test_a_wrong_fingerprint_is_refused_and_leaves_no_agent(self) -> None:
        # The host temp dir is shared with every other suite running on this
        # machine (a sibling lane's executor fixture holds a real agent there
        # for seconds at a time), so the pin is the DELTA the refused hold
        # leaves behind, never the absolute set — the first cut asserted the
        # whole directory empty and failed a pre-push on another process's
        # agent (push #7, 2026-09-14).
        before = self._live_agent_dirs()
        with self.assertRaises(SigningAgentUnavailable) as refused:
            with hold_signing_agent(self.key, expected_fingerprint="SHA256:" + "A" * 43):
                self.fail("an agent holding a key the caller did not expect must not be handed out")
        self.assertEqual(refused.exception.reason, "agent_holds_wrong_keys")
        self.assertEqual(sorted(self._live_agent_dirs() - before), [])

    def test_an_unloadable_key_is_refused_by_name(self) -> None:
        broken = self.root / "broken"
        broken.write_text("not a key\n", encoding="utf-8")
        broken.chmod(0o600)
        with self.assertRaises(SigningAgentUnavailable) as refused:
            with hold_signing_agent(broken, expected_fingerprint=self.fingerprint):
                self.fail("unreachable")
        self.assertTrue(refused.exception.reason.startswith("ssh_add_failed:"), refused.exception.reason)

    def test_a_missing_binary_is_refused_by_name(self) -> None:
        with mock.patch.object(sa.shutil, "which", return_value=None):
            with self.assertRaises(SigningAgentUnavailable) as refused:
                with hold_signing_agent(self.key, expected_fingerprint=self.fingerprint):
                    self.fail("unreachable")
        self.assertEqual(refused.exception.reason, "ssh_agent_missing")

    def test_the_parent_death_signal_is_armed_before_exec(self) -> None:
        # The pre-exec step asks for SIGTERM on the holder thread's death and
        # re-checks the parent: a holder that died between fork and prctl
        # would otherwise leave the child parented to init, signal armed for
        # nobody.
        prctl = mock.Mock(return_value=0)
        with mock.patch.object(sa.os, "getppid", return_value=4242):
            sa._die_with_holder(4242, prctl)()
            # No new privileges FIRST: the set-gid ssh-agent would drop the
            # death signal at exec otherwise (measured on this host).
            self.assertEqual(prctl.call_args_list, [
                mock.call(sa._PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0),
                mock.call(sa._PR_SET_PDEATHSIG, int(signal.SIGTERM), 0, 0, 0),
            ])
            with mock.patch.object(sa.os, "_exit", side_effect=SystemExit) as exit_:
                with self.assertRaises(SystemExit):
                    sa._die_with_holder(1, prctl)()
                exit_.assert_called_once_with(126)
        # Resolved in the parent, before the fork.
        self.assertTrue(callable(sa._prctl()))


if __name__ == "__main__":
    unittest.main()
