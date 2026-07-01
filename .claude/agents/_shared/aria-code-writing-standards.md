# ARIA Code-Writing Standards Contract

Canonical repository coding standards for every ARIA agent that holds Edit/Write
tools and emits code, tests, fixtures, or migrations. Consumed by
`aria-implementer`, `aria-acceptance-gap-fixer`, and `aria-drafter` (for drafted
bodies that embed code). CLAUDE.md is the root SSoT; on any conflict CLAUDE.md wins.

## Canonical References (READ via the Read tool before starting)

- @CLAUDE.md
- @.claude/knowledge/layer-2-defect-catalog.md
- @libs/backend-common/src/database/schema-manager.service.ts (`MODULE_SCHEMAS` — cross-tenant table SSoT)
- @aria-kernel/aria_kernel/draft_intent.py (`BANNED_PHRASES_DEFAULT` — banned-phrase SSoT)

## 1. Root-cause hierarchy (the only accepted fix shape)

Every fix MUST be an architectural root-cause change. Pick the highest tier that
applies: (1) make it **impossible** — the type system/runtime structurally
prevents the wrong behaviour; (2) make it **automatic** — the correct behaviour
becomes the zero-effort default; (3) make it **detectable** — build/test time
catches the wrong behaviour; (4) **document** it — only when 1–3 are genuinely
impossible. The litmus test for every diff: *"If the upstream were correct,
would this code need to exist?"* Defensive `?.` around a broken contract,
compat shims, and JSON-column escapes from the type system are refused shapes —
fix the contract and every caller instead. (CLAUDE.md §Architectural Approach.)

## 2. Type discipline

`as any`, `as unknown as X`, `// @ts-ignore`, and `// @ts-expect-error` are
FORBIDDEN — fix the type or write a generic. Every async call is `await`ed
(floating promises are forbidden). `console.*` is forbidden — use NestJS
`Logger`. Every public function declares an explicit return type. A diff that
needs a suppression to compile is evidence the change is wrong, not the checker.

## 3. Tenant isolation

Use `getScopedRepository()`; `getRepository()` bypasses tenant isolation and is
FORBIDDEN. Tenant identity comes from JWT claims when an authenticated user is
present; the `x-tenant-id` header and request subdomain are accepted only on the
reviewed pre-auth / cross-tenant admin / edge-ingestion paths, fail-closed in
prod. (CLAUDE.md §Security.)

## 4. Entities and schema placement (ADR-011)

`@Entity()` schema discipline is **per-table**: per-tenant tables in
tenant-scoped services (farm, sensor, hr, messaging, hydroponics, ai, alert)
OMIT `schema:` so search_path routes them into `tenant_<uuid>`; cross-tenant
tables inside those services and all platform-level services DECLARE `schema:`.
The authoritative cross-tenant set is `MODULE_SCHEMAS[].infrastructureTables` —
cite it, never copy it. New tables never land in `public`. Domain entities stay
separate from persistence entities; ORM decorators do not belong in the domain
layer.

## 5. Migrations

Never edit an existing migration file — generate a new one (in-place edits drift
live databases; the migration-immutability gate fails the PR). Blue-green safe
sequence: nullable column → backfill → NOT NULL. The migration runner owns
execution (`migrationsRun: false`).

## 6. Events

Construct events with `createBaseEvent()` — inline construction is a
compile-time error (branded `EventId`). Events are flat objects (ADR-006): no
nested `payload`/`metadata` wrappers. A new event needs its interface in
`libs/event-contracts/src/`, an `index.ts` export, a JSON-Schema validator for
trust-boundary crossings, and an upcaster for breaking changes.

## 7. Validation floor

`nx affected --target=test`, `nx affected --target=lint`, and
`npm run type-check` MUST be green before any commit or PR — never subtract
from this floor, only add (mutation testing, diff coverage). New behaviour
ships with a test that fails on regression (London School TDD;
`{domain}/__tests__/*.spec.ts`).

## 8. Git discipline

Commit format `{type}({scope}): {subject}` with a body explaining WHY, plus one
`Closes: docs/reviews/{agent}/{YYYY-MM-DD}-{topic}.md#{finding-id}` line per
finding. Co-Authored-By lines are never added. Force-push, `--no-verify`, and
every other hook-bypass flag are FORBIDDEN. A `BREAKING CHANGE:` footer is
required for event-contract shape changes, column drops, and public API changes.

## 9. Banned phrases in emitted artifacts

Code comments, commit messages, and PR bodies MUST contain zero gating-excuse
phrases. The SSoT list is `draft_intent.BANNED_PHRASES_DEFAULT` (kernel),
mirroring CLAUDE.md §Architectural Approach — quote at most an example or two
(e.g. "for now", "good enough"); never copy the list into prompts or code.

## 10. Suppression patterns

`.skip(...)`, `xit`, `test.todo` standing in for a real test, `@Disabled`,
`continue-on-error: true`, and empty `catch {}` blocks are refused shapes in
any emitted diff — the same discipline reviewers enforce via
`@.claude/knowledge/layer-2-defect-catalog.md`.

## 11. Scope of this contract

These are per-diff rules. Architecture context (service map, NATS
cert-identity, schema-drift machinery, PII masking) lives in CLAUDE.md and the
knowledge layers — Read them on demand; do not restate them in agent bodies.
