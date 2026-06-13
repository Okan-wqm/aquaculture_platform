# A3 — nats.js v2 → @nats-io/* v3 migration (PR-A: event bus + direct clients)

**Date:** 2026-06-13
**Agent:** platform-kernel-expert (lead-verified; migration fan-out orchestrated via workflow)
**Wave:** A3 (S3). Track A — Security / Supply-Chain / Runtime client migrations.
**Branch:** `remediation/nats-v3-migration`

---

## PLAT-HIGH-002 — The platform's NATS client is nats.js v2, in maintenance mode; the v3 client (`@nats-io/*`) is a hard-split package and cannot be adopted by a single alias swap

**Problem.** The 2026-06 technology audit flagged `nats@2.x` as a maintenance-mode
dependency (no new features; the maintained line is `@nats-io/*` 3.x). The platform
has **12 files importing directly from `nats`** — the 1002-line transactional event
bus (`@platform/event-bus`), the request/reply helper, four gateway WebSocket
bridges, two sensor-service responders, and one admin policy service.

A naive `nats` → `@nats-io/*` npm-alias swap is **impossible**: firsthand
verification (recorded in the A3 precondition) shows `@nestjs/microservices@11.1.19`
calls `require('nats').JSONCodec()` at runtime in its serializer + both
deserializers — and v3 **removed** `JSONCodec`. An alias swap would crash every
`Transport.NATS` service. The migration therefore must be **staged**: move the
direct importers to v3 first while v2 stays installed for `@nestjs/microservices`,
then replace the Nest transport (PR-B), then remove v2 (PR-C).

## v3 API verification (firsthand, against the real types)

`@nats-io/*` 3.x splits the monolithic `nats` package into `@nats-io/transport-node`
(`connect`), `@nats-io/nats-core` (connection + `Msg` primitives + error classes),
and `@nats-io/jetstream` (JS client/manager + policy enums). The v3 `.d.ts` were
extracted and read directly; the non-obvious changes that drove the migration:

- **`StringCodec`/`JSONCodec` removed.** Encode by passing a `string` to
  `publish`/`respond`/`request` (the lib UTF-8-encodes → **byte-identical wire**, so
  v2 and v3 producers/consumers interoperate during a rolling deploy); decode via
  `msg.string()` / `msg.json<T>()`.
- **`jetstream()` / `jetstreamManager()` are now top-level functions** taking the
  connection (`jetstream(nc)`), not methods on it.
- **`ErrorCode` + `NatsError` removed** → discrete error classes
  (`TimeoutError`, `NoRespondersError`, …). `e instanceof NatsError && e.code === ErrorCode.Timeout`
  becomes `e instanceof TimeoutError`.
- **`JsMsg.info.redeliveryCount` removed → `deliveryCount`** (a pure rename — v2 already
  marked `redeliveryCount` `@deprecated: use deliveryCount`; identical value). The event
  bus's exponential-backoff `2^count` math is preserved exactly. **This one was caught
  by a type-checked smoke-test, not by reading — see Validation.**
- The JetStream consumer API (`jsm.streams.add`, `jsm.consumers.add`,
  `js.consumers.get`, `consumer.consume()`, `msg.ack/nak/working/term`) is otherwise
  UNCHANGED (v2.29 already shipped it; v3 kept it).

`buildNatsConnectionOptions()` (the ADR-015 cert-is-identity anchor) is
client-agnostic and is **not touched**.

---

## PR-A (this PR) — additive: v3 alongside v2

- Added `@nats-io/{transport-node,nats-core,jetstream}@^3.4.0` to `package.json`
  (lockfile regenerated); `nats@2.x` stays for `@nestjs/microservices`.
- Migrated all 12 direct importers (9 source + 3 test) to `@nats-io/*`. Import
  remapping, `StringCodec` removal, the `jetstream()` function form, error-class
  swaps, and the `deliveryCount` rename — applied per file; behavior otherwise
  byte-identical.
- The migration fan-out was orchestrated as a workflow (one agent per file +
  an independent adversarial verify per file); the event bus + the
  `deliveryCount` semantic were hand-migrated and smoke-test-verified by the lead.

### Validation
- **v3 API smoke-test** — a standalone TS file exercising every migration pattern,
  type-checked (`tsc --noEmit`) against the extracted real v3.4.0 `.d.ts`: **EXIT 0**.
  This is what caught the `redeliveryCount → deliveryCount` removal (a latent 2×
  backoff regression had it been renamed naively) and confirmed the
  `TimeoutError()` / `NoRespondersError(subject)` constructor signatures.
- No `from 'nats'` / `StringCodec` / `ErrorCode` / `NatsError` / `.jetstream()`
  method-form references remain in code across the 12 files.
- `@nats-io/*` not installed in the worktree's shared node_modules (like
  `@nestjs/apollo` for R0) → the full per-file compile is delegated to GitHub CI
  (`npm ci` installs v3); the smoke-test + adversarial per-file verify substitute
  for the local in-place type-check.
- Wire-compat is by construction: durable names, queue groups, stream configs, and
  the UTF-8 JSON payload bytes are unchanged → mixed v2/v3 pods interoperate; rollback
  is an image redeploy (no broker migration).

## NOT done here (Track A continuation, separate PRs)
- **PR-B** — platform-owned `CustomTransportStrategy` + `ClientProxy` (Nest
  NATS-envelope wire-compatible) cutover of the **~14 `ClientsModule.register`
  sites** + `create-service-app.ts`, with golden-envelope fixtures captured BEFORE
  v2 removal. This is the architecturally-required step the JSONCodec blocker forces.
- **PR-C** — remove `nats@2.x`, add a `no-restricted-imports` ban + dependency
  invariant so the bifurcation cannot return.
