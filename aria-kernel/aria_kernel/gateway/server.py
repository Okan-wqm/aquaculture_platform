"""Stdlib HTTP ingress: HMAC-verified GitHub webhooks, bearer-gated Alertmanager
and operator posts, a read-only status page. Binds 127.0.0.1 — nginx fronts it."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping

from .inbox import inbox_summary, record_event, record_rejection, seen_delivery
from .normalize import normalize_alertmanager, normalize_github, normalize_operator

GITHUB_SECRET_ENV = "ARIA_GITHUB_WEBHOOK_SECRET"
ALERTMANAGER_BEARER_ENV = "ARIA_ALERTMANAGER_BEARER"
OPERATOR_BEARER_ENV = "ARIA_OPERATOR_BEARER"
ACTOR_ALLOWLIST_ENV = "ARIA_GATEWAY_ACTOR_ALLOWLIST"
ROUTES: tuple[str, ...] = ("/aria/webhook/github", "/aria/webhook/alertmanager", "/aria/webhook/operator", "/aria/status")
HEARTBEAT_RELPATH: tuple[str, ...] = ("gateway", "heartbeat.json")


@dataclass
class GatewayConfig:
    host: str = "127.0.0.1"
    port: int = 8787
    max_body_bytes: int = 1_048_576
    replay_window_seconds: int = 600
    # names only — values are read from the environment at verification time
    github_secret_env: str = GITHUB_SECRET_ENV
    alertmanager_bearer_env: str = ALERTMANAGER_BEARER_ENV
    operator_bearer_env: str = OPERATOR_BEARER_ENV
    actor_allowlist_env: str = ACTOR_ALLOWLIST_ENV
    route_inline: bool = False
    environ: Mapping[str, str] | None = None
    rate_limit_per_minute: int = 120
    recent_seen: dict[str, float] = field(default_factory=dict)

    def env(self) -> Mapping[str, str]:
        return os.environ if self.environ is None else self.environ

    def actor_allowlist(self) -> frozenset[str]:
        return frozenset(a.strip() for a in str(self.env().get(self.actor_allowlist_env) or "").split(",") if a.strip())


def verify_github_signature(*, secret: str | None, body: bytes, signature_header: str | None) -> bool:
    if not secret or not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip())


def verify_bearer(*, expected: str | None, authorization_header: str | None) -> bool:
    if not expected or not authorization_header:
        return False
    scheme, _, token = authorization_header.strip().partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(expected, token.strip())


class GatewayState:
    def __init__(self, *, config: GatewayConfig, base_dir: Path, workspace_root: Path) -> None:
        self.config = config
        self.base_dir = base_dir
        self.workspace_root = workspace_root
        self.started_at = time.time()
        self.handled = 0
        self.rejected = 0
        self._lock = threading.Lock()
        self._minute: tuple[int, int] = (0, 0)

    def rate_limited(self) -> bool:
        with self._lock:
            now_minute = int(time.time() // 60)
            minute, count = self._minute
            if minute != now_minute:
                self._minute = (now_minute, 1)
                return False
            self._minute = (minute, count + 1)
            return count + 1 > self.config.rate_limit_per_minute

    def status(self) -> dict[str, Any]:
        heartbeat = self.base_dir.joinpath(*HEARTBEAT_RELPATH)
        beat: dict[str, Any] | None = None
        if heartbeat.exists():
            try:
                beat = json.loads(heartbeat.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                beat = None
        return {
            "schema_version": 1, "uptime_seconds": int(time.time() - self.started_at), "handled": self.handled,
            "rejected": self.rejected, "inbox": inbox_summary(self.base_dir), "heartbeat": beat, "routes": list(ROUTES),
        }


def _handler_factory(state: GatewayState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "aria-gateway/1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — BaseHTTPRequestHandler signature
            return  # the inbox is the log; stdout stays quiet

        def _send(self, code: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _reject(self, code: int, source: str, reason: str, detail: dict[str, Any] | None = None) -> None:
            state.rejected += 1
            try:
                record_rejection(base_dir=state.base_dir, source=source, reason=reason, detail=detail)
            except Exception:  # noqa: BLE001 — a rejection must still be answered
                pass
            self._send(code, {"ok": False, "reason": reason})

        def do_GET(self) -> None:  # noqa: N802 — http.server API
            if self.path.split("?", 1)[0] != "/aria/status":
                self._send(404, {"ok": False, "reason": "not_found"})
                return
            self._send(200, state.status())

        def _read_body(self) -> bytes | None:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > state.config.max_body_bytes:
                return None
            return self.rfile.read(length)

        def do_POST(self) -> None:  # noqa: N802 — http.server API
            path = self.path.split("?", 1)[0]
            if path not in ROUTES or path == "/aria/status":
                self._send(404, {"ok": False, "reason": "not_found"})
                return
            source = path.rsplit("/", 1)[-1]
            if state.rate_limited():
                self._reject(429, source, "rate_limited")
                return
            body = self._read_body()
            if body is None:
                self._reject(413, source, "body_missing_or_too_large")
                return
            env = state.config.env()
            if source == "github":
                if not verify_github_signature(secret=env.get(state.config.github_secret_env), body=body,
                                               signature_header=self.headers.get("X-Hub-Signature-256")):
                    self._reject(401, source, "signature_invalid")
                    return
            elif source == "alertmanager":
                if not verify_bearer(expected=env.get(state.config.alertmanager_bearer_env), authorization_header=self.headers.get("Authorization")):
                    self._reject(401, source, "bearer_invalid")
                    return
            elif source == "operator":
                if not verify_bearer(expected=env.get(state.config.operator_bearer_env), authorization_header=self.headers.get("Authorization")):
                    self._reject(401, source, "bearer_invalid")
                    return
            try:
                payload = json.loads(body.decode("utf-8"))
            except ValueError:
                self._reject(400, source, "body_not_json")
                return
            if not isinstance(payload, dict):
                self._reject(400, source, "body_not_object")
                return
            events = []
            if source == "github":
                delivery = str(self.headers.get("X-GitHub-Delivery") or "").strip()
                if not delivery:
                    self._reject(400, source, "delivery_id_missing")
                    return
                if seen_delivery(delivery, state.base_dir):
                    self._reject(409, source, "replayed_delivery", {"delivery_id": delivery})
                    return
                event = normalize_github(str(self.headers.get("X-GitHub-Event") or ""), delivery, payload)
                events = [event] if event is not None else []
            elif source == "alertmanager":
                delivery = str(payload.get("groupKey") or payload.get("externalURL") or "") + ":" + hashlib.sha256(body).hexdigest()[:16]
                events = normalize_alertmanager(delivery, payload)
            else:
                actor = str(self.headers.get("X-Aria-Actor") or "").strip()
                allow = state.config.actor_allowlist()
                if not actor or (allow and actor not in allow):
                    self._reject(403, source, "actor_not_allowed", {"actor": actor})
                    return
                delivery = f"operator:{hashlib.sha256(body).hexdigest()[:24]}"
                if seen_delivery(delivery, state.base_dir):
                    self._reject(409, source, "replayed_delivery", {"delivery_id": delivery})
                    return
                try:
                    events = [normalize_operator(delivery, payload, actor=actor)]
                except ValueError as exc:
                    self._reject(400, source, f"normalize_failed:{exc}")
                    return
            accepted = []
            for event in events:
                row = record_event(event, base_dir=state.base_dir)
                if row is not None:
                    accepted.append(event.delivery_id)
                    if state.config.route_inline:
                        from .router import route_event

                        route_event(event, base_dir=state.base_dir, workspace_root=state.workspace_root)
            state.handled += 1
            self._send(202, {"ok": True, "accepted": accepted, "ignored": len(events) - len(accepted)})

    return Handler


def build_server(*, config: GatewayConfig, base_dir: str | Path, workspace_root: str | Path) -> tuple[ThreadingHTTPServer, GatewayState]:
    state = GatewayState(config=config, base_dir=Path(base_dir), workspace_root=Path(workspace_root))
    server = ThreadingHTTPServer((config.host, config.port), _handler_factory(state))
    server.daemon_threads = True
    return server, state


def serve(*, config: GatewayConfig, base_dir: str | Path, workspace_root: str | Path, max_requests: int | None = None,
          ready: Callable[[int], None] | None = None) -> GatewayState:
    """Blocking serve; `max_requests` bounds it for tests and `--once` probes."""
    server, state = build_server(config=config, base_dir=base_dir, workspace_root=workspace_root)
    if ready is not None:
        ready(server.server_address[1])
    try:
        if max_requests is None:
            server.serve_forever(poll_interval=0.5)
        else:
            for _ in range(max_requests):
                server.handle_request()
    finally:
        server.server_close()
    return state


__all__ = ["ACTOR_ALLOWLIST_ENV", "ALERTMANAGER_BEARER_ENV", "GITHUB_SECRET_ENV", "HEARTBEAT_RELPATH", "OPERATOR_BEARER_ENV",
           "ROUTES", "GatewayConfig", "GatewayState", "build_server", "serve", "verify_bearer", "verify_github_signature"]
