# Review — farm-service + messaging-service strictPropertyInitialization adoption

- **Date:** 2026-07-07
- **Owner agent:** data-expert
- **Cycle:** 2026-07-07-farm-messaging-strict-property-init
- **Trigger:** operator report of `[bootstrap-from-scratch]` TS2564 warnings across ~80 farm-service entity files in CI.

## DATA-HIGH-008 — farm/messaging disabled strictPropertyInitialization; entities authored without `!`, silently dropped by the schema-drift bootstrap test

**Severity:** HIGH · **State:** OPEN · **Layer:** 2 (pattern)

### Symptom
CI job `bootstrap-from-scratch` (`.github/workflows/db-migration-check.yml`) emitted, for ~80 farm-service (and latently messaging-service) entity files:

```
[bootstrap-from-scratch] could not load entity file .../purchase-order-item.entity.ts:
  error TS2564: Property 'tenantId' has no initializer and is not definitely assigned in the constructor.
```

and then failed with `service "farm-service" declared entitiesGlob=… but loadEntityClasses() found ZERO @Entity files`.

### Root cause
`tsconfig.base.json` sets `strictPropertyInitialization: true` (part of `strict: true`). Twelve of the fourteen entity-owning services inherit that and therefore declare every ORM/GraphQL field with a definite-assignment `!` (`tenantId!: string`). **farm-service and messaging-service alone disabled the flag** in their authoring tsconfigs (`tsconfig.app.json` / `tsconfig.spec.json`), so their entities/DTOs were authored **without** `!`.

The platform schema-drift invariant test (`apps/db-migrate/src/__tests__/bootstrap-from-scratch.spec.ts`) `require()`s every `*.entity.ts` through ts-jest under the strict **base** config. The un-`!`'d farm/messaging entities failed TS2564, `loadEntityClasses()` caught the error, **logged a warning and silently `continue`d** (`bootstrap-from-scratch.spec.ts:557`), and the entity was dropped from the entity-surface-vs-DB drift matrix.

### Why HIGH (not just a CI break)
The silent drop is a **detectability hole**: an entity that fails to load never enters the drift matrix, so a genuinely missing table/column would pass the schema-drift check **by omission**. The in-code comment claiming the `@Entity` decorators "ran anyway through getMetadataArgsStorage" was false — a compile failure means the module body never executes, so the entity is fully absent from TypeORM metadata.

### Remediation (this PR)
1. **Tier-1/2 — adopt the platform standard:** added `!` definite-assignment assertions to 1024 entity properties + 1343 DTO/resolver/response properties across farm + messaging (AST codemod driven by the compiler's own TS2564 list; type- and behavior-preserving — `!` emits identical JS). Removed the `strictPropertyInitialization: false` override from farm + messaging `tsconfig.{app,spec,build}.json` so they inherit the base `true` like the other twelve services.
2. **Tier-3 — make the silent drop detectable:** `loadEntityClasses()` now collects every un-loadable entity and throws an aggregated hard failure instead of warn-and-continue.
3. **Tier-1 — prevent recurrence:** new invariant `tests/invariants/strict-property-initialization-ssot.spec.ts` asserts the two services' authoring/build tsconfigs resolve `strictPropertyInitialization` to `true`.

### Verification
- `tsc -p` (app + spec) green for both services (0 TS2564).
- `npm run test:bootstrap` → 70/70, zero "could not load entity file" (the farm/messaging drift matrices now run for real).
- ESLint clean over all 213 changed `.ts` files; new invariant 7/7.

### Scope note (excluded, pre-existing — not addressed here)
- `apps/farm-service/tsconfig.e2e.json` keeps the flag `false`: its e2e suite has pre-existing, strict-init-**unrelated** `TS2349` breakage (supertest default-import not callable in `test/batch.e2e-spec.ts`), so it does not compile regardless of this flag. Re-enable once that typing is fixed.
- `docs/reviews/orphan-findings.md` on `main` carries committed merge-conflict markers (landed via `c4e0f1a80` / PR #911) — a separate pre-existing repo defect, flagged for the owner.
