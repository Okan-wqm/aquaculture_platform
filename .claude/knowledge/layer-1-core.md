# Layer-1 Core — Cross-cutting tech anchors

**Audience:** every enterprise-v2 agent (CATCHER, TEACHER, WRITER modes).
**Anchor:** TS 5.3.3, Nx 22.3.3, Jest 30, as of 2026-04-16.

This shard is the common base. Every agent reads it; domain-specific agents additionally read their domain shard (nestjs / typeorm / react / rust).

## TypeScript 5.3.3

- **`satisfies` operator** — prefer over type assertion when narrowing a literal. Example: `const modules = { farm: FarmModule, sensor: SensorModule } satisfies Record<string, Type>`. Assertions (`as`) bypass type-checking; `satisfies` preserves it.
- **Branded types** — use for domain IDs (`TenantId`, `UserId`, `EventId`). Confirmed zero-escape in the event-contracts domain (278 call sites). Extend branding to tenant / user / sensor IDs where cross-boundary mixing is a risk.
- **`const` type parameters** — use on generic functions that accept literal tuples / objects to preserve narrowness.
- **`noUncheckedIndexedAccess`** — enable where array/object index access is not already guarded. Opportunity count per slice audit: ~40 non-compliant access sites in `apps/**`.
- **Discriminated unions** — prefer over optional fields when "state X has field Y, state Z does not". Event contracts use this well; DTOs still have optional-to-hide-nullability anti-pattern in places.

## Nx 22.3.3

- **`nx affected --target=test --target=lint`** — only CI gate for partial-graph runs. Full-graph runs are nightly invariant sweeps.
- **Project references** — declared in per-project `project.json`; transitively resolved by Nx graph.
- **`dependsOn: ["^build"]`** — declared in `nx.json` ensures transitive builds.
- **Graph drift invariant** — `e2e/tests/integration/...` / `scripts/ci/...` validate graph resolution returns the expected project count; drift fails CI.
- **Known gap:** Rust crate `sens-api-gateway/` not represented in Nx graph — ADR-003 flags this; EDGE-CRITICAL-001 is a consequence. Scheduled W2 Day 1 fix + CI path gate.

## Jest 30

- **`projects` array** — multi-project Jest config for invariant sweeps separate from unit tests. `tests/invariants/` is its own project.
- **`describe.each` / `test.each`** — for parameterised invariant sweeps across services (e.g., assert all 13 schema-owning services register SchemaDriftModule).
- **`@platform/testing`** — mock factories for `DataSource`, `EventBus`, `Repository`; prefer these over ad-hoc mocks so tests stay aligned with current contract.

## Cross-cutting disciplines

- **Every public function declares explicit return type** — `explicit-function-return-type` ESLint rule (currently `warn`; progressive rollout to `error`).
- **No floating promises** — `no-floating-promises: error` enforced. Every `async` call either `await`ed or explicitly returned.
- **No `console.*` outside tests** — backend currently 100% clean; frontend has 825 violations (no parallel ESLint rule configured) — W7 to close.
- **No `as any` / `as unknown as X`** — enforced by ESLint `@typescript-eslint/no-explicit-any: error` in domain code; exceptions live in `.claude/allowlists/boundary-files.yaml` with justification + owner + expiry.

## References

- `tsconfig.base.json` — project-wide TS compiler options
- `nx.json` — workspace graph config
- `jest.config.js` — multi-project Jest setup
- `.eslintrc.json` — error-level rules + `no-restricted-syntax` bans
- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-anti-patterns.md` — reconciled anti-pattern counts feeding enforcement priorities
