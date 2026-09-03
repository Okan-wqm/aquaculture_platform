"""The droplet daemon: host lease + exclusive pid lock + HTTP thread + scheduler ticks; ARIA_STOP / SIGTERM exit."""
from __future__ import annotations

import os
import signal
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..file_lock import with_exclusive_lock
from ..tool_registry import append_tools_governance, ensure_tools_dir
from .scheduler import tick
from .server import GatewayConfig, build_server

DAEMON_ID = "aria-gateway"
DEFAULT_POLL_INTERVAL_SECONDS = 60.0


def run_gateway_daemon(
    *,
    base_dir: str | Path,
    workspace_root: str | Path,
    config: GatewayConfig | None = None,
    max_iterations: int | None = None,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    interrupt_event: threading.Event | None = None,
    aria_stop_filename: str = "ARIA_STOP",
    serve_http: bool = True,
    runner: Any | None = None,
) -> dict[str, Any]:
    """Returns {exits_clean, exit_reason, iterations}. Mirrors aria_watchdog."""
    root = ensure_tools_dir(base_dir)
    workspace = Path(workspace_root).resolve()
    cfg = config or GatewayConfig()
    daemons_dir = root / "daemons"
    daemons_dir.mkdir(parents=True, exist_ok=True)
    stop = interrupt_event or threading.Event()
    original = signal.getsignal(signal.SIGTERM) if hasattr(signal, "SIGTERM") else None

    def _on_term(signum: int, frame: Any) -> None:  # noqa: ARG001
        stop.set()

    if hasattr(signal, "SIGTERM") and threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, _on_term)
    iterations = 0
    try:
        with with_exclusive_lock(daemons_dir / f"{DAEMON_ID}.pid.lock", timeout_seconds=2.0):
            (daemons_dir / f"{DAEMON_ID}.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
            from ..autonomous_host_lease import acquire_lease

            try:
                acquire_lease(base_dir=root, allow_same_host_refresh=True)
            except Exception as exc:  # noqa: BLE001 — GovernanceError family; the lease is another host's
                append_tools_governance(root, "gateway_daemon_refused", {"reason": "host_lease_blocked", "error": str(exc)[:200]})
                return {"exits_clean": False, "exit_reason": "host_lease_blocked", "iterations": 0}
            server = None
            thread = None
            if serve_http:
                server, _state = build_server(config=cfg, base_dir=root, workspace_root=workspace)
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True)
                thread.start()
            append_tools_governance(root, "gateway_daemon_started", {"host": cfg.host, "port": cfg.port, "http": serve_http})
            reason = "max_iterations"
            try:
                while True:
                    if (root / aria_stop_filename).exists():
                        reason = "aria_stop"
                        break
                    if stop.is_set():
                        reason = "interrupted"
                        break
                    tick(base_dir=root, workspace_root=workspace, now=datetime.now(timezone.utc), runner=runner)
                    iterations += 1
                    try:
                        acquire_lease(base_dir=root, allow_same_host_refresh=True)
                    except Exception:  # noqa: BLE001 — lost the lease mid-run: stop, another host owns the loop
                        reason = "host_lease_lost"
                        break
                    if max_iterations is not None and iterations >= max_iterations:
                        break
                    if stop.wait(poll_interval_seconds):
                        reason = "interrupted"
                        break
            finally:
                if server is not None:
                    server.shutdown()
                    server.server_close()
                append_tools_governance(root, "gateway_daemon_stopped", {"reason": reason, "iterations": iterations})
            return {"exits_clean": reason != "host_lease_lost", "exit_reason": reason, "iterations": iterations}
    except TimeoutError:
        return {"exits_clean": False, "exit_reason": "daemon_already_running", "iterations": 0}
    finally:
        if hasattr(signal, "SIGTERM") and original is not None and threading.current_thread() is threading.main_thread():
            try:
                signal.signal(signal.SIGTERM, original)
            except (OSError, ValueError):
                pass


__all__ = ["DAEMON_ID", "DEFAULT_POLL_INTERVAL_SECONDS", "run_gateway_daemon"]
