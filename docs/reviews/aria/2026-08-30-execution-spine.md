# ARIA review — 2026-08-30: the execution identity and session spine

Operator design ("Faz 1A"): every mutating operation in ARIA should carry
a UNIFIED identity. Agent audit (2026-08-30) confirmed the gap: no actor
registry, no ExecutionContext factory, no session lifecycle, no
mission-session binding, no provider-session linkage, no unified audit
block — each surface minted its own partial identity independently.

## ARIA-MEDIUM-029 — execution identity was scattered; the spine unifies it

execution_spine.py provides all seven operator requirements:

1. Service Actor Registry (8 actors, closed set, fail-closed validation)
2. ExecutionContext (frozen, 11 identity fields, factory-generated)
3. Session Ledger (9 lifecycle events, hash-chained)
4. Mission-Session Binding
5. Provider-Session Binding
6. Unified Audit Context (to_audit_fields)
7. State Manifest + 20 invariant tests
