"""Plan 032 Faz 032g — `aria-kernel mcp serve`: a dependency-free stdio MCP server over the store.

Newline-delimited JSON-RPC 2.0 on stdin/stdout (the transport Claude Code
uses for stdio servers). Read-only tools answer from the ledgers; the two
write tools exist for OPERATORS (`--allow-writes` + an approval ref that is
recorded on governance) and are excluded from agent profiles by the
registry. Every call lands on `mcp/tool-calls.jsonl` with side=server.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, IO

from .mcp_client import record_mcp_call
from .tool_registry import append_tools_governance, ensure_tools_dir

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "aria"
SERVER_VERSION = "032g"
READ_TOOLS: tuple[str, ...] = (
    "aria_status", "missions_list", "findings_query", "pressure_top", "governance_tail", "handoff_read",
    "daily_report", "search", "delivery_status", "progress_tail",
)
WRITE_TOOLS: tuple[str, ...] = ("human_required_resolve", "runtime_signal_ingest")
MCP_WRITE_TOOL_EVENT = "mcp_write_tool_used"


def _schema(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


TOOL_MANIFEST: dict[str, dict[str, Any]] = {
    "aria_status": {"description": "Doctor summary of the ARIA store (organ statuses, healthy flag).", "inputSchema": _schema({})},
    "missions_list": {"description": "Open missions (state, source, title, next_action).", "inputSchema": _schema({"limit": {"type": "integer", "minimum": 1, "maximum": 200}})},
    "findings_query": {"description": "Recorded findings, optionally filtered by service.", "inputSchema": _schema({"service": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}})},
    "pressure_top": {"description": "Highest-ranked pressure sources.", "inputSchema": _schema({"limit": {"type": "integer", "minimum": 1, "maximum": 100}})},
    "governance_tail": {"description": "Most recent governance rows (kind + details).", "inputSchema": _schema({"limit": {"type": "integer", "minimum": 1, "maximum": 200}, "kind": {"type": "string"}})},
    "handoff_read": {"description": "Last handoff snapshot for a session id.", "inputSchema": _schema({"session_id": {"type": "string"}}, ["session_id"])},
    "daily_report": {"description": "Daily anchor payload for a UTC date (default today).", "inputSchema": _schema({"date": {"type": "string"}})},
    "search": {"description": "Full-text search over the derived ledger index.", "inputSchema": _schema({"query": {"type": "string"}, "kinds": {"type": "array", "items": {"type": "string"}}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}, ["query"])},
    "delivery_status": {"description": "Delivery closure summary (Faz 032d SLO).", "inputSchema": _schema({})},
    "progress_tail": {"description": "Sanitized progress rows of a request.", "inputSchema": _schema({"request_id": {"type": "string"}, "last": {"type": "integer", "minimum": 1, "maximum": 200}}, ["request_id"])},
    "human_required_resolve": {"description": "OPERATOR: resolve a HUMAN_REQUIRED request (needs --allow-writes and operator_approval_ref).", "inputSchema": _schema({"request_id": {"type": "string"}, "resolution_note": {"type": "string"}, "verdict": {"type": "string"}, "operator_approval_ref": {"type": "string"}}, ["request_id", "resolution_note", "operator_approval_ref"])},
    "runtime_signal_ingest": {"description": "OPERATOR: record a runtime signal lead (needs --allow-writes and operator_approval_ref).", "inputSchema": _schema({"source": {"type": "string"}, "service": {"type": "string"}, "summary": {"type": "string"}, "code_refs": {"type": "array", "items": {"type": "string"}}, "severity": {"type": "string"}, "operator_approval_ref": {"type": "string"}}, ["source", "service", "summary", "code_refs", "operator_approval_ref"])},
}


class AriaMcpServer:
    def __init__(self, *, base_dir: str | Path | None, workspace_root: str | Path, allow_writes: bool = False) -> None:
        self.root = ensure_tools_dir(base_dir)
        self.workspace = Path(workspace_root).resolve()
        self.allow_writes = allow_writes
        self.initialized = False

    # ---- tool implementations (read) ----
    def _aria_status(self, args: dict[str, Any]) -> Any:
        from .doctor import run_doctor

        report = run_doctor(base_dir=self.root, workspace_root=self.workspace)
        return {"healthy": report.healthy, "summary": report.to_dict()["summary"],
                "checks": [{"name": c.name, "status": c.status, "reason": c.reason} for c in report.checks]}

    def _missions_list(self, args: dict[str, Any]) -> Any:
        from .mission import list_open_missions

        rows = list_open_missions(base_dir=self.root)
        return [{k: m.get(k) for k in ("mission_id", "state", "source_kind", "source_id", "title", "next_action", "priority", "updated_at")} for m in rows[: int(args.get("limit") or 50)]]

    def _findings_query(self, args: dict[str, Any]) -> Any:
        from .finding import list_findings

        rows = list_findings(self.workspace, service=args.get("service"))
        return rows[: int(args.get("limit") or 50)]

    def _pressure_top(self, args: dict[str, Any]) -> Any:
        from .knowledge_graph import rank_pressure_sources

        return rank_pressure_sources(workspace_root=self.workspace)[: int(args.get("limit") or 20)]

    def _governance_tail(self, args: dict[str, Any]) -> Any:
        from .governance_reader import read_governance_rows

        path = self.root / "governance.jsonl"
        if not path.exists():
            return []
        rows = read_governance_rows(path, on_corruption="skip", reverse=True, base_dir=self.root)
        kind = args.get("kind")
        out = []
        for row in rows:
            if kind and row.get("kind") != kind:
                continue
            out.append({"recorded_at": row.get("recorded_at") or row.get("timestamp"), "kind": row.get("kind"), "details": row.get("details")})
            if len(out) >= int(args.get("limit") or 50):
                break
        return out

    def _handoff_read(self, args: dict[str, Any]) -> Any:
        from .handoff_ledger import read_handoff

        return read_handoff(session_id=str(args["session_id"]), base_dir=self.root)

    def _daily_report(self, args: dict[str, Any]) -> Any:
        from .report import build_daily_anchor

        date = str(args.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d"))
        return build_daily_anchor(date=date, workspace_root=self.workspace, tools_root=self.root)

    def _search(self, args: dict[str, Any]) -> Any:
        from .search import search

        hits = search(str(args["query"]), workspace_root=self.workspace, kinds=args.get("kinds"), limit=int(args.get("limit") or 20))
        return [h.__dict__ if hasattr(h, "__dict__") else h for h in hits]

    def _delivery_status(self, args: dict[str, Any]) -> Any:
        from .delivery_closure import compute_delivery_closure

        return compute_delivery_closure(base_dir=self.root).summary

    def _progress_tail(self, args: dict[str, Any]) -> Any:
        from .progress import read_progress

        return read_progress(str(args["request_id"]), base_dir=self.root, last=int(args.get("last") or 20))

    # ---- tool implementations (write, operator-only) ----
    def _write_gate(self, tool: str, args: dict[str, Any]) -> None:
        if not self.allow_writes:
            raise PermissionError(f"{tool} is an operator tool; start the server with --allow-writes")
        ref = str(args.get("operator_approval_ref") or "").strip()
        if len(ref) < 6:
            raise PermissionError("operator_approval_ref (>= 6 chars) is required for a write tool")
        append_tools_governance(self.root, MCP_WRITE_TOOL_EVENT, {"tool": tool, "operator_approval_ref": ref,
                                                                    "args": {k: v for k, v in args.items() if k != "operator_approval_ref"}})

    def _human_required_resolve(self, args: dict[str, Any]) -> Any:
        self._write_gate("human_required_resolve", args)
        from .human_required import resolve_human_required

        return resolve_human_required(request_id=str(args["request_id"]), resolution_note=str(args["resolution_note"]),
                                      verdict=args.get("verdict"), base_dir=self.root)

    def _runtime_signal_ingest(self, args: dict[str, Any]) -> Any:
        self._write_gate("runtime_signal_ingest", args)
        from .runtime_signal_bridge import ingest_runtime_signal

        return ingest_runtime_signal(source=str(args["source"]), service=str(args["service"]), summary=str(args["summary"]),
                                     code_refs=[str(c) for c in args.get("code_refs") or []], severity=str(args.get("severity") or "high"),
                                     base_dir=self.root)

    def _impl(self, name: str) -> Callable[[dict[str, Any]], Any]:
        return getattr(self, f"_{name}")

    # ---- JSON-RPC ----
    def tools(self) -> list[dict[str, Any]]:
        names = READ_TOOLS + (WRITE_TOOLS if self.allow_writes else ())
        return [{"name": n, **TOOL_MANIFEST[n]} for n in names]

    def call_tool(self, name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
        args = dict(arguments or {})
        started = time.monotonic()
        if name not in TOOL_MANIFEST or (name in WRITE_TOOLS and not self.allow_writes):
            record_mcp_call(tool_name=f"{SERVER_NAME}/{name}", ok=False, base_dir=self.root, side="server", error_class="UnknownTool")
            return {"content": [{"type": "text", "text": f"unknown tool {name!r}"}], "isError": True}
        try:
            result = self._impl(name)(args)
            text = json.dumps(result, sort_keys=True, default=str)
            record_mcp_call(tool_name=f"{SERVER_NAME}/{name}", ok=True, base_dir=self.root, side="server",
                            duration_ms=int((time.monotonic() - started) * 1000))
            return {"content": [{"type": "text", "text": text}], "isError": False}
        except Exception as exc:  # noqa: BLE001 — a tool failure is an error result, never a dead server
            record_mcp_call(tool_name=f"{SERVER_NAME}/{name}", ok=False, base_dir=self.root, side="server",
                            duration_ms=int((time.monotonic() - started) * 1000), error_class=type(exc).__name__)
            return {"content": [{"type": "text", "text": f"{type(exc).__name__}: {str(exc)[:500]}"}], "isError": True}

    def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        method = str(message.get("method") or "")
        msg_id = message.get("id")
        params = message.get("params") or {}
        if method.startswith("notifications/"):
            if method == "notifications/initialized":
                self.initialized = True
            return None
        if method == "initialize":
            result: Any = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}},
                           "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": self.tools()}
        elif method == "tools/call":
            result = self.call_tool(str(params.get("name") or ""), params.get("arguments"))
        else:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"method not found: {method}"}}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    def serve(self, stdin: IO[str] | None = None, stdout: IO[str] | None = None, *, max_messages: int | None = None) -> int:
        inp = stdin or sys.stdin
        out = stdout or sys.stdout
        handled = 0
        for line in inp:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                out.write(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}) + "\n")
                out.flush()
                continue
            response = self.handle(message) if isinstance(message, dict) else {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
            if response is not None:
                out.write(json.dumps(response, sort_keys=True, default=str) + "\n")
                out.flush()
            handled += 1
            if max_messages is not None and handled >= max_messages:
                break
        return 0


__all__ = ["MCP_WRITE_TOOL_EVENT", "PROTOCOL_VERSION", "READ_TOOLS", "SERVER_NAME", "SERVER_VERSION", "TOOL_MANIFEST", "WRITE_TOOLS", "AriaMcpServer"]
