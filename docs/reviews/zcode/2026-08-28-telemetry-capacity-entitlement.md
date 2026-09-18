# Telemetry Capacity Entitlement — Task 8 Core (100-Tenant Readiness)

Date: 2026-08-28 · Agent: zcode · Branch: `feat/100-tenant-readiness-v3`

## SENSOR-HIGH-102 — no per-tenant telemetry capacity entitlement

The platform envelope is locked (2.000 MQTT msg/s sustained; Task 0
planning constant), but nothing tracks how much of it individual tenants
consume. A new tenant's devices can silently push the platform past the
envelope the 60-minute zero-loss promise is conditioned on — and the
resize decision has no data to rank against.

## Fix (this commit — the Task 8 core)

- **Contract** (`libs/event-contracts/src/billing/telemetry-capacity.ts`):
  the SSoT enum `PENDING_CAPACITY | ACTIVE | SUPERSEDED | RELEASED`, the
  M/R value axes, `TELEMETRY_PLATFORM_ENVELOPE` (2.000 M sustained /
  15.000 M stress-window-only), and the
  `TelemetryCapacityEntitlementChanged` event payload.
- **Entity** (`telemetry-capacity-entitlement.entity.ts`, billing
  platform schema per ADR-011 DECLARE rule): one row per (tenant,
  version). Two PARTIAL unique indexes make the machine structural — one
  ACTIVE per tenant, one PENDING_CAPACITY per tenant.
- **Migration 1802200000000** (after the user-protected 18021): CREATE
  TABLE/INDEX IF NOT EXISTS + a fail-closed `postCondition` on the two
  guards. Billing uses the numeric glob, so no manifest edit.
- **Service** (`telemetry-capacity.service.ts`): every mutation is ONE
  transaction writing the entitlement row AND the `billing_outbox` event
  (idempotency key `tce:{tenant}:{version}:{state}`).
  - `reserve()` — fits the remaining envelope → ACTIVE; else
    PENDING_CAPACITY (observed headroom stored for diagnostics). The
    tenant's previous ACTIVE entitlement is untouched.
  - `activate()` — operator-driven only; refuses while the pending
    values still exceed headroom ("resize proof has not landed");
    supersedes the old ACTIVE row in the same transaction.
  - `release()` — ACTIVE → RELEASED, headroom returns.
- **Tests** (`telemetry-capacity.spec.ts`, 7 cases): the plan's two
  failing scenarios — full-envelope reservation lands PENDING_CAPACITY
  and `activate()` refuses without headroom; a pending resize-up never
  disturbs the previous ACTIVE version — plus atomic supersede,
  same-tx outbox emit, and idempotent retry. 614/614 billing tests green.

## Deliberately out of this core (follow-ups)

- Admin UI (device × interval × fan-out → M/R) and the admin DTO.
- `SENSOR_READINGS` meter reconciliation against actual usage.
- Tier-table defaults — gated on LAW-001 legal sign-off.
