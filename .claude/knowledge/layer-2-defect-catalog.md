# Layer-2 — Real-Defect Catalog (SSoT)

The **generic** real-world defect classes every code-review agent must hunt — the bugs, typos,
duplication, and security holes that actually occur when reading/writing code in this repo. This is
the SSoT: agents `@`-reference this file (reader-bookmark; Read at invocation) instead of
re-listing generic classes. **Domain-specific** defects live in each agent's own *Domain-specific
invariants* section; this file is only the cross-cutting baseline.

No brittle live counts here (they drift) — each class names how to DETECT it and the repo's
ENFORCING rule where one exists. Raw scan with counts/top-offenders:
`docs/reviews/_audit/2026-04-W16-anti-patterns.md`.

## Security (highest priority)

- **Cross-tenant isolation leak** — bare `getRepository()` instead of `getScopedRepository()`
  (`libs/backend-common/src/database/tenant-scoped-repository.ts`); a tenant table missing
  `FORCE ROW LEVEL SECURITY` (`libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`);
  a cache key without a `tenant`/`tenant_` prefix (`createTenantQueryKey` on the web side,
  `validateTenantKeyPattern` in `cacheable.decorator.ts` — note it only **warns**, so a tenant-less
  key still ships → flag it). Enforced: `no-direct-getrepository-call.spec.ts`, `no-bare-tenant-query-key`
  eslint rule. **CRITICAL.**
- **Authz / guard gaps** — missing guard on a mutation; object-level auth absent on a fetch-by-id
  (IDOR); `@Public()` misuse; role check by `>=` level vs explicit membership (privilege escalation);
  fail-OPEN `catch` in a guard that returns allow-on-error. **CRITICAL.**
- **Injection** — string-interpolated `search_path`/SQL without the `TENANT_SCHEMA_REGEX` validate-first
  guard; `SET search_path` session-scoped outside the connection factory (pool contamination); log
  injection; unbounded user regex (ReDoS). **CRITICAL/HIGH.**
- **Secret handling** — long-lived secret from `process.env` instead of a secret file/KMS; direct
  `JWT_SECRET` access; secret in a log line (must route through `maskPii()`,
  `libs/backend-common/src/utils/pii-mask.util.ts`). **CRITICAL.**
- **Crypto** — `===` instead of `crypto.timingSafeEqual` on tokens/HMAC; `Math.random()` for
  security values; AES-GCM nonce reuse; any HS256 / `DEV_JWT_SECRET` fallback (RS256-only,
  `jwt-rs256-only.spec.ts`); gateway→subgraph HMAC that drops a v2 canonical field or accepts the
  legacy v1 form (`libs/backend-common/src/utils/service-identity.util.ts`). **CRITICAL.**
- **SSRF** — server-side fetch (`signedFetch`, preview/import, webhook-supplied URL) without
  host/scheme allowlisting. **HIGH.**
- **XSS / unsafe markup** — `dangerouslySetInnerHTML` / raw SVG without DOMPurify + TrustedTypes
  (incl. the SCADA surface `web/modules/sensor-module/.../CustomSvgRenderer.tsx` + expression-engine
  / Web-Worker script executor — a sandbox-escape RCE class). **HIGH.**
- **PII / GDPR** — PII written into an immutable event/audit row; predictable (reversible)
  anonymization; crypto-shred without key-destruction verification. **HIGH.**
- **Webhook ingress** — signature verified on parsed (not raw) body; missing freshness/replay/dedup;
  tenant taken from the payload instead of the verified context. **CRITICAL.**

## Correctness / bugs

- **Floating promises** — an un-`await`ed async call, or a `.catch(() => {})` no-op escape hatch.
  Enforced: `@typescript-eslint/no-floating-promises: 'error'` **globally** (`eslint.config.mjs`;
  `off` ONLY inside test-file override blocks) + `no-misused-promises` + `await-thenable`.
- **Empty / swallowing catch** — `catch {}` or `catch { return null/true }` that hides the failure
  (fail-open in a guard = CRITICAL). **HIGH.**
- **Null / undefined deref**, **wrong operator** (`=`/`==`/`&&`), **copy-paste / identifier typo**
  (a renamed-but-not-everywhere symbol, a wrong field on a near-identical object).
- **Enum / string mismatch** — a string literal that no longer matches its enum/const (e.g. a
  GraphQL/event `eventType`, a renamed config key like `cacheTime`→`gcTime`).
- **Off-by-one** — loop/range bounds, inclusive-vs-exclusive date ranges, month/year rollover
  arithmetic.
- **Concurrency** — non-atomic read-compute-write (use atomic increment / `FOR UPDATE`),
  check-then-insert TOCTOU (use a unique constraint / advisory lock), ack-before-work (lost event).
- **Money / time** — `parseFloat`/`Number` on currency (precision loss; use the decimal/bigint
  contract); naive `Date` math across DST/timezones.
- **Stale closure** — a captured value (token, callback) that goes stale across renders/retries.

## Type-system erosion (FORBIDDEN per CLAUDE.md)

`as any`; `as unknown as X`; `// @ts-ignore` / `// @ts-expect-error`. Each hides a real type
mismatch — fix the type or write a generic, never cast around it.

## Architecture / contract drift

- **Inline event construction** instead of `createBaseEvent()` (branded `EventId`).
- **Direct `eventBus.publish` / `natsClient.publish`** outside `@platform/outbox` (outbox-only;
  `no-direct-event-publish` eslint rule).
- **`@Entity()` schema discipline** — per-table rule (per-tenant tables omit `schema:`; cross-tenant
  + platform-level declare it). Enforced: `require-entity-schema` eslint rule +
  `entity-schema-declaration.spec.ts`.
- **Nested `payload`/`metadata` event wrappers** (flat objects only, ADR-006).
- **Root-barrel import** of `@aquaculture/backend-common` instead of a sub-path
  (`no-root-barrel-import.spec.ts`).
- **High-cardinality metric label** (`tenant_id`/`user_id`/`request_id` banned;
  `no-high-cardinality-metric-label` eslint rule).
- **Bare `gql\`…\`` query string** instead of a generated TypedDocumentNode
  (`no-bare-graphql-query-string` eslint rule); **raw `@anthropic-ai/sdk` call** outside the wrapper
  (`no-claude-sdk-raw-call` eslint rule).

## Duplication / DRY

Copy-pasted logic blocks that should be a shared util; a generic rule restated across multiple
agents/files that belongs in an SSoT (this file, `layer-2-patterns.md`, or `.claude/shared/`);
the same constant/list maintained in two places (drift risk — point both at one source).

## Hygiene

`console.*` in non-test code (`no-console: error` → use NestJS `Logger`); `TODO`/`FIXME`/`XXX`
without a tracked finding + owner; `throw new Error('not implemented')` on a reachable path;
file-level `/* eslint-disable */` without an `auditor-override:` tag + tracked finding.
