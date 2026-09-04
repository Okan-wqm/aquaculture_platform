"""Plan 032 Faz 032f — the event gateway: webhook server, normalizer, inbox, router, scheduler, daemon.

Every external event becomes ONE closed-vocabulary row on the inbox ledger
before anything acts on it; routing is deterministic (no LLM in the loop);
the scheduler's actions are a closed vocabulary (never a free prompt); the
daemon holds the autonomous host lease like every other long-running lane.
"""
from __future__ import annotations

__all__ = ["daemon", "inbox", "normalize", "router", "scheduler", "server"]
