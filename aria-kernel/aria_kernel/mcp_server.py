"""Plan 032 Faz 032g — `aria-kernel mcp serve`: a dependency-free stdio MCP server over the store.

Newline-delimited JSON-RPC 2.0 on stdin/stdout (the transport Claude Code
uses for stdio servers). Read-only tools answer from the ledgers; the two
write tools exist for OPERATORS and are excluded from agent profiles by the
registry. Every call lands on `mcp/tool-calls.jsonl` with side=server.

ARIA-HIGH-270 / ADR-0023 — a write needs `--allow-writes` AND an
`operator_approval` that `aria-kernel mcp approve` signed in the
`aria-operator-request` namespace over the tool, the digest of the call's
exact arguments, audience, actor class and an expiry inside the registry's
bound, verified against the allowed-signers anchor committed on main. The
gate used to accept any six-character string as the operator's approval.
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, IO, TextIO

from .mcp_client import record_mcp_call
from .operator_request_signature import (
    SIGNATURE_NAMESPACE,
    AllowedSigners,
    allowed_signers_for_checkout,
    operator_act_terms_reason,
    request_subject_digest,
    sign_operator_subject,
    verify_operator_signature,
)
from .operator_request_terms import request_audience, utc_iso
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "aria"
SERVER_VERSION = "032g"
READ_TOOLS: tuple[str, ...] = (
    "aria_status", "missions_list", "findings_query", "pressure_top", "governance_tail", "handoff_read",
    "daily_report", "search", "delivery_status", "progress_tail", "plan_verify",
)
WRITE_TOOLS: tuple[str, ...] = ("human_required_resolve", "runtime_signal_ingest")
MCP_WRITE_TOOL_EVENT = "mcp_write_tool_used"
# One write's signed subject: its own row kind inside the request namespace,
# so a write approval never passes as a plan request (ingestion requires the
# request row kind) and a request never passes as a write approval (the gate
# rebuilds the subject from the call itself).
MCP_WRITE_ROW_KIND = "mcp_write"
MCP_WRITE_SCHEMA_VERSION = 1
APPROVAL_ARGUMENT = "operator_approval"
APPROVAL_FIELDS: tuple[str, ...] = ("actor_class", "audience", "expires_at", "signer_principal", "signature")


def _schema(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


_APPROVAL_SCHEMA = _schema({field: {"type": "string"} for field in APPROVAL_FIELDS}, list(APPROVAL_FIELDS))


def mcp_write_subject(tool: str, arguments: dict[str, Any], approval: dict[str, Any]) -> dict[str, Any]:
    """The subject an operator signs to admit exactly this write: tool, argument digest, terms."""
    payload = {key: value for key, value in arguments.items() if key != APPROVAL_ARGUMENT}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    subject: dict[str, Any] = {
        "schema_version": MCP_WRITE_SCHEMA_VERSION, "row_kind": MCP_WRITE_ROW_KIND, "tool": tool,
        "args_digest": "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }
    subject.update({field: approval[field] for field in APPROVAL_FIELDS if field in approval})
    return subject


def judge_mcp_write(subject: dict[str, Any], anchor: AllowedSigners, *, now: datetime) -> str | None:
    """Why the signed write is refused against ``anchor`` at ``now``, or None: terms, then signature."""
    reason = operator_act_terms_reason(
        subject, entry=anchor.namespaces.get(SIGNATURE_NAMESPACE), audience=request_audience(), now=now,
    )
    if reason is not None:
        return reason
    return verify_operator_signature(
        subject, namespace=SIGNATURE_NAMESPACE, allowed_signers=anchor.content, namespaces=anchor.namespaces,
    ).reason


def sign_mcp_write_approval(
    tool: str, arguments: dict[str, Any], *, signing_key: str | Path, signer_principal: str,
    actor_class: str, expires_in_hours: int, workspace_root: str | Path, subject_stream: TextIO | None = None,
) -> dict[str, Any]:
    """The operator half of the gate: sign one write, and refuse what the gate would refuse."""
    if tool not in WRITE_TOOLS:
        raise GovernanceError(f"mcp_write_tool_unknown: {tool!r}")
    if not isinstance(arguments, dict) or APPROVAL_ARGUMENT in arguments:
        raise GovernanceError("mcp_write_arguments_must_be_an_object_without_an_approval")
    anchor, anchor_reason = allowed_signers_for_checkout(workspace_root)
    if anchor is None:
        raise GovernanceError(f"mcp_write_anchor_unavailable: {anchor_reason}")
    entry = anchor.namespaces[SIGNATURE_NAMESPACE]
    now = datetime.now(timezone.utc).replace(microsecond=0)
    terms = {"actor_class": actor_class, "audience": request_audience(),
             "expires_at": utc_iso(now + timedelta(hours=expires_in_hours))}
    signed = sign_operator_subject(
        mcp_write_subject(tool, arguments, terms), namespace=entry.namespace, domain_tag=str(entry.domain_tag),
        signing_key=signing_key, signer_principal=signer_principal,
        subject_stream=subject_stream if subject_stream is not None else sys.stderr,
    )
    reason = judge_mcp_write(signed, anchor, now=now)
    if reason is not None:
        raise GovernanceError(f"mcp_write_approval_refused: {reason}")
    return {field: signed[field] for field in APPROVAL_FIELDS}


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
    # ARIA-HIGH-147 — the implementer's first obligation (the converged
    # plan's authenticity) answered by the kernel from its own ledger: the
    # sandbox's command policy has no interpreter for a hand recomputation,
    # and two live spawns spent their whole budgets attempting one.
    "plan_verify": {"description": "Verify a CONVERGED plan's authenticity: the kernel recomputes plan_convergence.content_hash from its own hash-verified ledger body and compares it with the hash the envelope names (must_satisfy authenticity item). Returns verdict verified|mismatch, the revision id and the FULL plan body (the envelope's inline copy may be truncated). Call this instead of recomputing by hand.", "inputSchema": _schema({"plan_id": {"type": "string"}, "content_hash": {"type": "string"}}, ["plan_id", "content_hash"])},
    "human_required_resolve": {"description": "OPERATOR: resolve a HUMAN_REQUIRED request (needs --allow-writes and an operator_approval from `aria-kernel mcp approve` over these exact arguments).", "inputSchema": _schema({"request_id": {"type": "string"}, "resolution_note": {"type": "string"}, "verdict": {"type": "string"}, APPROVAL_ARGUMENT: _APPROVAL_SCHEMA}, ["request_id", "resolution_note", APPROVAL_ARGUMENT])},
    "runtime_signal_ingest": {"description": "OPERATOR: record a runtime signal lead (needs --allow-writes and an operator_approval from `aria-kernel mcp approve` over these exact arguments).", "inputSchema": _schema({"source": {"type": "string"}, "service": {"type": "string"}, "summary": {"type": "string"}, "code_refs": {"type": "array", "items": {"type": "string"}}, "severity": {"type": "string"}, APPROVAL_ARGUMENT: _APPROVAL_SCHEMA}, ["source", "service", "summary", "code_refs", APPROVAL_ARGUMENT])},
}


class AriaMcpServer:
    def __init__(
        self, *, base_dir: str | Path | None, workspace_root: str | Path, allow_writes: bool = False,
        request_id: str | None = None,
    ) -> None:
        self.root = ensure_tools_dir(base_dir)
        self.workspace = Path(workspace_root).resolve()
        self.allow_writes = allow_writes
        # ARIA-HIGH-124 (round 4) — the request this view is served FOR
        # (the executor's broker names it): every `mcp/tool-calls.jsonl` row
        # this server records carries it, so a call can be attributed to
        # the request whose sandbox made it. None for an operator's own
        # `mcp serve`.
        self.request_id = request_id
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

        return rank_pressure_sources(base_dir=self.root)[: int(args.get("limit") or 20)]

    def _governance_tail(self, args: dict[str, Any]) -> Any:
        # ARIA-HIGH-124 — the bounded seek-to-end reader (V3.1-C-1), with
        # the kind filter applied before the parse. The previous body asked
        # `read_governance_rows` for `on_corruption="skip"`, a mode the
        # reader refuses at entry (`strict` / `tolerant` only), so this
        # tool answered every call with an error — invisible while the
        # server ran inside the sandbox against a phantom store, measured
        # the moment it was served against the real one.
        from .governance_reader import read_governance_rows_reverse

        kind = args.get("kind")
        rows = read_governance_rows_reverse(
            base_dir=self.root, limit=int(args.get("limit") or 50),
            kind_filter=(str(kind),) if kind else None,
        )
        return [
            {"recorded_at": row.get("recorded_at") or row.get("timestamp"), "kind": row.get("kind"), "details": row.get("details")}
            for row in rows
        ]

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

    def _plan_verify(self, args: dict[str, Any]) -> Any:
        from .plan_convergence import converged_plan_body, fold_plan_state

        plan_id = str(args["plan_id"])
        claimed = str(args["content_hash"]).strip()
        state = fold_plan_state(plan_id=plan_id, base_dir=self.root)
        # The ledger's own hash-verified body (ORPHAN-CRITICAL-728): a body
        # that does not reproduce the recorded hash is never returned.
        body = converged_plan_body(plan_id=plan_id, base_dir=self.root)
        recorded = str(body["content_hash"])
        return {
            "plan_id": plan_id, "state": state.get("state"), "revision_id": body["revision_id"],
            "content_hash": recorded, "claimed_content_hash": claimed,
            "verdict": "verified" if recorded == claimed else "mismatch",
            "plan_content": body["plan_content"],
        }

    # ---- tool implementations (write, operator-only) ----
    def _write_gate(self, tool: str, args: dict[str, Any]) -> None:
        if not self.allow_writes:
            raise PermissionError(f"{tool} is an operator tool; start the server with --allow-writes")
        approval = args.get(APPROVAL_ARGUMENT)
        if not isinstance(approval, dict):
            raise PermissionError(f"{APPROVAL_ARGUMENT} (signed with `aria-kernel mcp approve`) is required for a write tool")
        anchor, anchor_reason = allowed_signers_for_checkout(self.workspace)
        if anchor is None:
            raise PermissionError(f"mcp_write_anchor_unavailable: {anchor_reason}")
        subject = mcp_write_subject(tool, args, approval)
        reason = judge_mcp_write(subject, anchor, now=datetime.now(timezone.utc))
        if reason is not None:
            raise PermissionError(f"mcp_write_approval_refused: {reason}")
        approved = {key: subject[key] for key in ("signer_principal", "actor_class", "expires_at")}
        append_tools_governance(self.root, MCP_WRITE_TOOL_EVENT, {
            "tool": tool, "args": {k: v for k, v in args.items() if k != APPROVAL_ARGUMENT},
            "operator_approval": {**approved, "anchor_commit": anchor.commit, "subject_digest": request_subject_digest(subject)},
        })

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
            record_mcp_call(tool_name=f"{SERVER_NAME}/{name}", ok=False, base_dir=self.root, side="server",
                            request_id=self.request_id, error_class="UnknownTool")
            return {"content": [{"type": "text", "text": f"unknown tool {name!r}"}], "isError": True}
        try:
            result = self._impl(name)(args)
            text = json.dumps(result, sort_keys=True, default=str)
            record_mcp_call(tool_name=f"{SERVER_NAME}/{name}", ok=True, base_dir=self.root, side="server",
                            request_id=self.request_id, duration_ms=int((time.monotonic() - started) * 1000))
            return {"content": [{"type": "text", "text": text}], "isError": False}
        except Exception as exc:  # noqa: BLE001 — a tool failure is an error result, never a dead server
            record_mcp_call(tool_name=f"{SERVER_NAME}/{name}", ok=False, base_dir=self.root, side="server",
                            request_id=self.request_id, duration_ms=int((time.monotonic() - started) * 1000),
                            error_class=type(exc).__name__)
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


__all__ = ["APPROVAL_ARGUMENT", "MCP_WRITE_ROW_KIND", "MCP_WRITE_TOOL_EVENT", "PROTOCOL_VERSION", "READ_TOOLS", "SERVER_NAME",
           "SERVER_VERSION", "TOOL_MANIFEST", "WRITE_TOOLS", "AriaMcpServer", "judge_mcp_write", "mcp_write_subject",
           "sign_mcp_write_approval"]
