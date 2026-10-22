"""ARIA-MEDIUM-583 — the GitHub App key lives in a broker, not the cycle.

WHY this module exists
----------------------
The nightly cycle and the executor drain are long-running processes that
run discovery, planning and agent orchestration; the workflow used to hand
each of them the App's PRIVATE KEY (a PEM in ``$RUNNER_TEMP`` plus
``ARIA_GH_APP_PRIVATE_KEY`` in the step env) so their deliveries could mint
installation tokens in-process. The App key can mint repository-write
tokens, so narrowing the job token (ARIA-MEDIUM-555) could never take
repository write away from the cycle process: for a whole night, every
agent spawn ran inside a process that could read the key that mints its own
authority.

WHAT this module does
---------------------
A lane starts the broker as a SIBLING step of the kernel-run step (never
its ancestor). The launcher (``python3 -m aria_kernel.token_broker start``,
PEM on stdin) spawns the server with an environment of PATH ONLY — beyond
the interpreter's own locale coercion, which the server's startup check
allows by name and documents; anything else readable from
``/proc/<pid>/environ`` is a named refusal to serve — and the server:

* reads the PEM once, from the stdin pipe, and keeps it in memory only.
  There is no key file to forget to remove; the key is never in any
  environment, any file, or the server's argv;
* refuses to hold the key where a same-uid NON-DESCENDANT could ptrace it:
  Yama ``ptrace_scope`` 0 (or no Yama at all) is a named startup refusal.
  At scope >= 1 the kernel-run process — a sibling, not a parent — cannot
  attach to the broker's memory;
* serves exactly one verb on a private unix socket (mode 0700 directory,
  mode 0600 socket): ``mint`` with ``lease_id``, ``permission_set_name``
  and ``ttl_seconds``. The set name must come from the closed allowlist
  ``gh_token_factory.INSTALLATION_TOKEN_PERMISSION_SETS`` — the ONE table
  the in-process mint also names, so the broker can never widen what a
  lane may hold;
* enforces the per-night mint cap and clamps every TTL to its remaining
  lifetime (the lane passes the job cap as ``--deadline-epoch``): no token
  it mints can outlive the job, and the broker itself exits at the
  deadline however the runner reaps it;
* appends one governance row per mint and per refusal to the ledger file
  (``--ledger``, mode 0600) — stderr is redirected there, so a row is
  never lost to a pipe nobody reads;
* returns the narrowed token, the provider's ``expires_at`` and the
  installation id. It NEVER returns the key.

The kernel-run process reaches it through ``gh_token_factory`` under
``ARIA_GH_TOKEN_BROKER_SOCKET``; ``ARIA_REQUIRE_TOKEN_BROKER=true`` makes
the in-process key path refuse by name, so a lane that declared the broker
can never quietly fall back to spending the key itself.

The mint itself is ``gh_token_factory._mint_installation_token_from_pem`` —
the ONE JWT mint; this module holds the key, it does not re-implement the
protocol.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .secret_scrub import is_armoured_private_key
from .socket_holders import TOKEN_BROKER as _SOCKET_HOLDER

# Linux `sun_path` is 108 bytes including the terminator.
_UNIX_SOCKET_PATH_MAX = 107
_SERVER_START_TIMEOUT_SECONDS = 15.0
_SERVER_STOP_TIMEOUT_SECONDS = 5.0
# Reading the PEM off the launcher's stdin pipe: a PEM is ~1.7-3.3 KiB
# (RSA 2048-4096); 64 KiB accepts any GitHub App key shape and still
# refuses a dump of something else.
_MAX_PEM_BYTES = 64 * 1024
_MAX_REQUEST_BYTES = 8192
_MAX_RESPONSE_BYTES = 64 * 1024
_REQUEST_TIMEOUT_SECONDS = 180.0
_PTRACE_SCOPE_PATH = Path("/proc/sys/kernel/yama/ptrace_scope")
# What the holder's own environ may hold. PATH is the launcher's gift; the
# interpreter itself adds LC_CTYPE at startup when it coerces the C locale
# (PEP 538 — measured on this host: a child exec'd with PATH only reads
# back {PATH, LC_CTYPE}). Anything else in /proc/<pid>/environ means a
# caller handed the holder something readable there — a secret-shaped env
# — and the holder refuses to serve.
_ALLOWED_ENVIRON = frozenset({"PATH", "LC_CTYPE"})
# Log-safety only (the mint's own cycle-id contract stays its owner's):
# the lease id lands in governance rows and ledger lines verbatim.
_LEASE_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,128}")
# A night mints at most two installation tokens per request (the delivery
# hold plus the pre-spawn credential admission) against MAX_REQUESTS_PER_RUN
# = 30, plus burn-in cycles; 120 is that bound with the night's whole
# budget spent on deliveries and nothing left over.
DEFAULT_MINT_CAP = 120
# The broker outlives its starting step by design (the kernel-run step is
# its sibling); what bounds a broker whose lane forgot the deadline is this
# ceiling — the longest executor job (602 min) plus margin.
DEFAULT_BROKER_LIFETIME_SECONDS = 12 * 3600
MAX_BROKER_LIFETIME_SECONDS = 24 * 3600


class TokenBrokerUnavailable(RuntimeError):
    """The lane could not start (or reach) a broker; ``reason`` names why."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class TokenBrokerRefused(RuntimeError):
    """The broker refused a mint; ``reason`` names the closed rule."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class TokenBroker:
    """The running broker: where its socket is and how to stop it."""

    socket_path: Path
    pid: int
    ledger_path: Path | None = None
    _process: subprocess.Popen[bytes] | None = field(default=None, repr=False)

    def stop(self) -> None:
        """Terminate the server and remove its socket directory."""
        process = self._process
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=_SERVER_STOP_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=_SERVER_STOP_TIMEOUT_SECONDS)
        shutil.rmtree(self.socket_path.parent, ignore_errors=True)


def read_ptrace_scope(path: str | Path | None = None) -> int | None:
    """The host's Yama ``ptrace_scope``, or None when there is no Yama."""
    try:
        text = (Path(path) if path is not None else _PTRACE_SCOPE_PATH).read_text(encoding="ascii")
    except (OSError, ValueError):
        return None
    try:
        return int(text.strip())
    except ValueError:
        return None


def yama_scope_permits_isolation(scope: int | None) -> bool:
    """Whether a same-uid NON-DESCENDANT is barred from ptracing the broker.

    Scope 0 is the classic rule — any same-uid process may attach, read the
    broker's memory and walk off with the key; so is a host with no Yama at
    all. 1 (own descendants only), 2 (admin-only) and 3 (no attach at all)
    keep the kernel-run process, a sibling of the broker, out of its memory.
    """
    return scope is not None and scope >= 1


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _startup_refusal(reason: str, **details: Any) -> None:
    """Name the refusal on stderr (the launcher's pipe) and exit."""
    row = {"kind": "token_broker_refused_to_start", "reason": reason, **details}
    sys.stderr.write(json.dumps(row, sort_keys=True) + "\n")
    sys.stderr.flush()


def _read_line(connection: socket.socket, *, cap: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = connection.recv(4096)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            raise ConnectionError("line_too_large")
        if b"\n" in chunk:
            chunks.append(chunk[: chunk.index(b"\n")])
            break
        chunks.append(chunk)
    return b"".join(chunks)


def mint_via_broker(
    socket_path: str | Path,
    *,
    lease_id: str,
    permission_set_name: str,
    ttl_seconds: int,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """One mint through the broker's socket — the client the factory uses.

    Returns the broker's answer dict (``token``, ``expires_at``,
    ``installation_id``, the clamped ``ttl_seconds`` and the served
    ``permission_set``); :class:`TokenBrokerRefused` carries the broker's
    named reason for every refusal.
    """
    request = json.dumps({
        "verb": "mint",
        "lease_id": lease_id,
        "permission_set_name": permission_set_name,
        "ttl_seconds": int(ttl_seconds),
    }).encode("utf-8") + b"\n"
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(float(timeout_seconds) if timeout_seconds is not None else _REQUEST_TIMEOUT_SECONDS)
        try:
            client.connect(str(socket_path))
        except OSError as exc:
            raise TokenBrokerUnavailable(f"broker_socket_unreachable:{type(exc).__name__}") from exc
        try:
            client.sendall(request)
            raw = _read_line(client, cap=_MAX_RESPONSE_BYTES)
        except (OSError, ConnectionError) as exc:
            raise TokenBrokerUnavailable(f"broker_protocol_error:{type(exc).__name__}") from exc
    finally:
        client.close()
    try:
        response = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TokenBrokerRefused("response_not_json") from exc
    if not isinstance(response, dict) or not response.get("ok"):
        reason = response.get("reason") if isinstance(response, dict) else None
        raise TokenBrokerRefused(str(reason or "refused_without_reason"))
    for required in ("token", "expires_at", "installation_id"):
        if not response.get(required):
            raise TokenBrokerRefused(f"response_missing:{required}")
    return response


def start_broker(
    pem: str,
    *,
    app_id: str,
    installation_id: str,
    api_base_url: str | None = None,
    max_mints: int = DEFAULT_MINT_CAP,
    deadline_epoch: float | None = None,
    ledger_path: str | Path | None = None,
    start_timeout_seconds: float = _SERVER_START_TIMEOUT_SECONDS,
) -> TokenBroker:
    """Start the holder server for a lane and return its handle.

    The server is spawned as a DETACHED child (its own session, no
    parent-death signal — it must outlive this launcher, which is a
    workflow step) with an environment of PATH only, reading the PEM from
    its stdin pipe. The launcher validates what it can name before the
    spawn; the server re-checks its own environment, the host's ptrace
    scope, its deadline and the PEM once it starts, and every one of those
    refusals comes back here by name.
    """
    from . import gh_token_factory

    if not is_armoured_private_key(pem):
        raise TokenBrokerUnavailable("pem_not_recognized")
    if not isinstance(app_id, str) or not app_id.strip():
        raise TokenBrokerUnavailable("app_id_missing")
    if not isinstance(installation_id, str) or not installation_id.strip():
        raise TokenBrokerUnavailable("installation_id_missing")
    if not isinstance(max_mints, int) or isinstance(max_mints, bool) or max_mints < 1:
        raise TokenBrokerUnavailable("mint_cap_invalid")
    now = time.time()
    deadline = now + DEFAULT_BROKER_LIFETIME_SECONDS if deadline_epoch is None else float(deadline_epoch)
    if deadline <= now:
        raise TokenBrokerUnavailable("deadline_passed")
    if deadline > now + MAX_BROKER_LIFETIME_SECONDS:
        raise TokenBrokerUnavailable("lifetime_invalid")
    if not yama_scope_permits_isolation(read_ptrace_scope()):
        scope = read_ptrace_scope()
        raise TokenBrokerUnavailable(f"ptrace_scope_permissive:{scope}")
    socket_dir = _SOCKET_HOLDER.make_directory()
    socket_path = socket_dir / _SOCKET_HOLDER.socket_name
    if len(str(socket_path).encode()) > _UNIX_SOCKET_PATH_MAX:
        shutil.rmtree(socket_dir, ignore_errors=True)
        raise TokenBrokerUnavailable("socket_path_too_long")

    argv = [
        sys.executable, "-m", "aria_kernel.token_broker", "serve",
        "--socket", str(socket_path),
        "--app-id", app_id,
        "--installation-id", installation_id,
        "--api-base-url", api_base_url or gh_token_factory.GITHUB_API_BASE_URL,
        "--max-mints", str(int(max_mints)),
        "--deadline-epoch", str(int(deadline)),
    ]
    if ledger_path is not None:
        argv += ["--ledger", str(ledger_path)]
    # PATH only (plus the interpreter's own locale coercion, which the
    # server allows by name): /proc/<server>/environ is the STARTUP
    # environment, and the server refuses to serve if it ever sees more
    # than that there.
    environment = {"PATH": os.environ.get("PATH", os.defpath)}
    working_dir = str(Path(__file__).resolve().parents[1])
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=environment,
        cwd=working_dir,
        start_new_session=True,
    )
    try:
        try:
            process.stdin.write((pem if pem.endswith("\n") else pem + "\n").encode("utf-8"))
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass  # the server refused at startup; the wait below names it
        waited = time.monotonic() + float(start_timeout_seconds)
        while not socket_path.is_socket():
            if process.poll() is not None:
                reason = _death_reason(process)
                shutil.rmtree(socket_dir, ignore_errors=True)
                raise TokenBrokerUnavailable(reason)
            if time.monotonic() >= waited:
                process.kill()
                process.wait(timeout=_SERVER_STOP_TIMEOUT_SECONDS)
                shutil.rmtree(socket_dir, ignore_errors=True)
                raise TokenBrokerUnavailable("server_socket_not_created")
            time.sleep(0.02)
    except BaseException:
        if process.poll() is None:
            process.kill()
        shutil.rmtree(socket_dir, ignore_errors=True)
        raise
    return TokenBroker(
        socket_path=socket_path,
        pid=process.pid,
        ledger_path=Path(ledger_path) if ledger_path is not None else None,
        _process=process,
    )


def _death_reason(process: subprocess.Popen[bytes]) -> str:
    """The named reason from a server that died at startup, if it left one."""
    try:
        tail = (process.stderr.read() or b"").decode("utf-8", "replace").strip().splitlines()
    except (OSError, ValueError):
        tail = []
    for line in reversed(tail):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and row.get("kind") == "token_broker_refused_to_start":
            return f"server_refused:{row.get('reason')}"
    return f"server_exited:{process.returncode}"


@dataclass
class _ServerState:
    app_id: str
    installation_id: str
    pem: str
    api_base_url: str
    max_mints: int
    deadline: float
    ledger: bool
    mints_used: int = 0

    def governance(self, kind: str, **fields: Any) -> None:
        """One governance row per event, onto stderr — which is the ledger."""
        row = {"timestamp": _utc_now(), "kind": kind, **fields}
        sys.stderr.write(json.dumps(row, sort_keys=True) + "\n")
        sys.stderr.flush()


def _read_pem_from_stdin(bound_seconds: float = 15.0) -> str:
    """The PEM, read once from the launcher's pipe, bounded in size and time."""
    chunks: list[bytes] = []
    total = 0
    deadline = time.monotonic() + bound_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("pem_read_timeout")
        ready, _, _ = select.select([sys.stdin], [], [], remaining)
        if not ready:
            raise TimeoutError("pem_read_timeout")
        chunk = os.read(sys.stdin.fileno(), 8192)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_PEM_BYTES:
            raise ValueError("pem_too_large")
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


def _refuse(state: _ServerState | None, connection: socket.socket, reason: str,
            lease_id: Any = None) -> None:
    # The row comes FIRST: the audit record of a refusal exists before the
    # caller learns the outcome, so a broker that dies in between leaves
    # evidence of the ask, never a silent no.
    if state is not None:
        row: dict[str, Any] = {"reason": reason}
        if isinstance(lease_id, str):
            row["lease_id"] = lease_id
        state.governance("token_broker_refused", **row)
    answer = {"ok": False, "reason": reason}
    try:
        connection.sendall(json.dumps(answer).encode("utf-8") + b"\n")
    except OSError:
        pass


def _serve_one(connection: socket.socket, state: _ServerState) -> None:
    from . import gh_token_factory

    with connection:
        connection.settimeout(_REQUEST_TIMEOUT_SECONDS)
        try:
            raw = _read_line(connection, cap=_MAX_REQUEST_BYTES)
        except (OSError, ConnectionError):
            return  # a client that cannot ask, leaves no row
        try:
            request = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            _refuse(state, connection, "request_not_json")
            return
        if not isinstance(request, dict) or request.get("verb") != "mint":
            verb = request.get("verb") if isinstance(request, dict) else None
            _refuse(state, connection, f"unknown_verb:{verb}")
            return
        lease_id = request.get("lease_id")
        if not isinstance(lease_id, str) or _LEASE_ID_RE.fullmatch(lease_id) is None:
            _refuse(state, connection, "lease_id_invalid", lease_id)
            return
        name = request.get("permission_set_name")
        if not isinstance(name, str) or name not in gh_token_factory.INSTALLATION_TOKEN_PERMISSION_SETS:
            _refuse(state, connection, f"unknown_permission_set:{name}", lease_id)
            return
        ttl = request.get("ttl_seconds")
        if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl <= 0:
            _refuse(state, connection, "ttl_invalid", lease_id)
            return
        if state.mints_used >= state.max_mints:
            _refuse(state, connection, f"mint_cap_exceeded:{state.max_mints}", lease_id)
            return
        remaining = int(state.deadline - time.time())
        clamped = min(ttl, remaining, gh_token_factory.PROVIDER_INSTALLATION_TOKEN_LIFETIME_SECONDS)
        if clamped <= 0:
            _refuse(state, connection, "ttl_window_closed", lease_id)
            return
        try:
            token, expires_at = gh_token_factory._mint_installation_token_from_pem(
                app_id=state.app_id,
                installation_id=state.installation_id,
                private_pem=state.pem,
                permissions=gh_token_factory.INSTALLATION_TOKEN_PERMISSION_SETS[name],
                api_base_url=state.api_base_url,
            )
        except Exception as exc:  # noqa: BLE001 — every failure class is a named refusal
            _refuse(state, connection, f"mint_failed:{type(exc).__name__}", lease_id)
            return
        state.mints_used += 1
        # Row first, then the answer — the mint is on the record before the
        # caller can spend it.
        state.governance(
            "token_broker_mint",
            lease_id=lease_id,
            permission_set=name,
            ttl_seconds=clamped,
            mints_remaining=state.max_mints - state.mints_used,
        )
        answer = {
            "ok": True,
            "token": token,
            "expires_at": expires_at,
            "installation_id": state.installation_id,
            "permission_set": name,
            "ttl_seconds": clamped,
        }
        try:
            connection.sendall(json.dumps(answer).encode("utf-8") + b"\n")
        except OSError:
            pass


def _serve(args: argparse.Namespace) -> int:
    """The holder process. Refuses to serve in every state that would leak."""
    extra = sorted(set(os.environ) - _ALLOWED_ENVIRON)
    if extra:
        _startup_refusal("environ_not_minimal", keys=extra)
        return 2
    if not yama_scope_permits_isolation(read_ptrace_scope()):
        _startup_refusal("ptrace_scope_permissive", scope=read_ptrace_scope())
        return 3
    if args.deadline_epoch is None:
        _startup_refusal("deadline_required")
        return 4
    deadline = float(args.deadline_epoch)
    if deadline <= time.time():
        _startup_refusal("deadline_passed", deadline_epoch=deadline)
        return 4
    try:
        pem = _read_pem_from_stdin()
    except (TimeoutError, ValueError) as exc:
        _startup_refusal(str(exc))
        return 5
    if not is_armoured_private_key(pem):
        _startup_refusal("pem_not_recognized")
        return 5
    # From here the process holds the key: stderr becomes the ledger (mode
    # 0600) so every governance row lands somewhere durable and nothing is
    # ever written back to a pipe the launcher left behind. No ledger means
    # the lane asked for no rows; DEVNULL keeps the fd shape uniform.
    if args.ledger:
        ledger_fd = os.open(args.ledger, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.dup2(ledger_fd, 2)
        finally:
            os.close(ledger_fd)
    else:
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, 2)
        finally:
            os.close(devnull)

    socket_path = Path(args.socket)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    state = _ServerState(
        app_id=args.app_id,
        installation_id=args.installation_id,
        pem=pem,
        api_base_url=args.api_base_url,
        max_mints=int(args.max_mints),
        deadline=deadline,
        ledger=bool(args.ledger),
    )
    try:
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        listener.listen(8)
        state.governance(
            "token_broker_started",
            socket=str(socket_path),
            deadline_epoch=int(deadline),
            max_mints=state.max_mints,
        )
        while True:
            remaining = state.deadline - time.time()
            if remaining <= 0:
                state.governance("token_broker_expired", mints_used=state.mints_used)
                return 0
            listener.settimeout(min(0.5, remaining))
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                _serve_one(connection, state)
            except Exception as exc:  # noqa: BLE001 — the holder outlives any one request
                state.governance("token_broker_refused", reason=f"request_error:{type(exc).__name__}")
    finally:
        listener.close()
        try:
            socket_path.unlink(missing_ok=True)
            socket_path.parent.rmdir()
        except OSError:
            pass
    return 0


def main(argv: list[str] | None = None) -> int:
    from . import gh_token_factory

    parser = argparse.ArgumentParser(
        prog="python3 -m aria_kernel.token_broker",
        description="ARIA-MEDIUM-583 — the GitHub App token broker",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    def _common(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--app-id", required=True)
        sub.add_argument("--installation-id", required=True)
        sub.add_argument("--api-base-url", default=gh_token_factory.GITHUB_API_BASE_URL)
        sub.add_argument("--max-mints", type=int, default=DEFAULT_MINT_CAP)
        sub.add_argument("--deadline-epoch", type=float, default=None)
        sub.add_argument("--ledger", default=None)

    launcher = commands.add_parser("start", help="read the PEM on stdin, start the holder, print its socket path")
    _common(launcher)
    server = commands.add_parser("serve", help="the holder itself (started by `start`)")
    _common(server)
    server.add_argument("--socket", required=True)

    args = parser.parse_args(argv)
    if args.command == "serve":
        return _serve(args)

    pem = sys.stdin.read(_MAX_PEM_BYTES + 1)
    if len(pem) > _MAX_PEM_BYTES:
        sys.stderr.write("token broker: PEM larger than the bound\n")
        return 1
    broker = start_broker(
        pem,
        app_id=args.app_id,
        installation_id=args.installation_id,
        api_base_url=args.api_base_url,
        max_mints=args.max_mints,
        deadline_epoch=args.deadline_epoch,
        ledger_path=args.ledger,
    )
    print(str(broker.socket_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
