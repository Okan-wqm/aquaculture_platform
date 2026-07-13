# SCADA Server-Script Sandbox — WebAssembly Isolation

**Date:** 2026-07-13
**Reviewer:** claude (WASM adoption research)
**Scope:** `apps/sensor-service/src/scada-runtime/services/script-engine.service.ts`, `apps/sensor-service/src/process/services/scada-package.service.ts`
**Workstream:** WASM adoption plan — Phase 1 (`docs/plans/2026-07-13-wasm-adoption`)

---

## Summary

Tenant-authored SCADA HMI scripts were executed server-side, in-process, inside a
Node.js `vm` context (`ScriptEngineService.executeInSandbox`). The scheduler
(`scheduler.service.ts`) runs these scripts unattended on interval/cron triggers.
Node's `vm` module is **not a security boundary**: the guest shares the host V8
heap and object graph, and documented escapes (prototype walks, the injected
`Promise` constructor, async work outstripping the synchronous `timeout`) let
untrusted script code reach host objects. The frozen-proxy `SAFE_CONSTRUCTORS`
hardening reduced but did not close this class.

## Findings

| ID | Severity | Statement |
|----|----------|-----------|
| SCADA-SANDBOX-CRITICAL-001 | CRITICAL | Untrusted tenant JS executes in a Node `vm` that is not a real isolate; prototype/`Promise`-constructor escapes and async-timeout evasion are reachable from tenant-supplied script code. |
| SCADA-SANDBOX-HIGH-002 | HIGH | Script source persisted into `ScadaPackage.packageData` had no write-time bound (size, count, mode), permitting oversized/malformed script payloads at rest. |

## Resolution

- **SCADA-SANDBOX-CRITICAL-001** — Execution moved to a QuickJS interpreter
  compiled to WebAssembly (`quickjs-sandbox.ts`). The guest runs in an isolated
  linear-memory heap with its own built-ins and no ambient host reference
  (`process`/`require`/`Buffer`/`global` are structurally unreachable). CPU is
  bounded by an interrupt-handler deadline, async hangs by racing the returned
  guest promise against the same deadline, and memory/stack by explicit limits.
  Each run uses a fresh, disposed-in-`finally` context so no state leaks across
  runs or tenants. The `$`-bridge surface and `ScriptResult` contract are
  preserved; tenant fail-closed semantics (`requireTenant`) are unchanged.
- **SCADA-SANDBOX-HIGH-002** — `ScadaPackageService.validateScripts` rejects (never
  truncates) at the save boundary: per-script `code` ≤ 64 KiB, ≤ 50 scripts per
  package, `mode ∈ {server, client}`.

Tests: `quickjs-sandbox.spec.ts` (isolation/limits/marshalling battery),
`script-engine.service.spec.ts` (contract + bridge wiring),
`scada-package-script-validation.spec.ts` (write-boundary guards).
