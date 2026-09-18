# `as never` — the ungated escape hatch, and what it was hiding

**Cycle:** 2026-07-29-as-never-open-surface-hunt
**Method:** 12-agent workflow over 6 file partitions — classify every occurrence by
intent, then hunt drift (doubles that no longer match the type they stand in for), then an
adversarial verify stage prompted to REFUTE each claim. 27 claims raised, **11 refuted**,
16 confirmed by reading both sides.

---

## The measurement

`as never` appears 403 times at code level (not in prose) across 102 files. **100 of those
files are spec files; only 2 are production.** A naive `rg "as never"` reports 464 — the
English phrase "w**as never**" contains the token, and one of the audit agents caught that
independently, so the corrected figure is what the classification below counts.

| category           | count | what it is                                                   |
| ------------------ | ----- | ------------------------------------------------------------ |
| `partial-double`   | 299   | an object literal standing in for a real class/interface     |
| `jest-mock-return` | 66    | `mockResolvedValue(x as never)` and friends                  |
| `unreachable-arg`  | 44    | a constructor/method argument the exercised path never reads |
| `comment-only`     | 61    | prose, not a cast                                            |
| `type-hole`        | 4     | hides a genuine type mismatch                                |
| `other`            | 16    |                                                              |

By what would replace it: **316 typed partial double, 90 fix-the-real-type, 18 real
collaborator, 65 keep** — and the 65 "keep" are almost entirely the prose matches. There is
**no switch-exhaustiveness `as never` in this repository at all.** It was never a language
idiom here; it was the one cast CLAUDE.md did not name, absorbing the pressure from the
four it did.

## Why it is worse than the casts that were already banned

`as any` keeps property access checkable at the use site. `x as never` asserts the value
has the type with no values, so every subsequent check is vacuous. Applied to a partial
test double it means the double can drift from the real type forever — production renames
a method, adds a collaborator call, changes a union member — and the suite keeps compiling.
The failure surfaces as `TypeError: <method> is not a function`, or it does not surface at
all because the assertion no longer touches the code it names.

## The SSoT

`libs/testing` — the library whose own docblock says its purpose is "centralizes mock
factories that were duplicated across 15+ service test files" — exported no typed
partial-double helper, while **33 spec files hand-declared a byte-identical**
`function mock<T>(impl: Partial<T>): T { return impl as T; }`. That idiom belonged there.

Three exports now live in `libs/testing/src/doubles/typed-double.ts`:

- **`stub<T>(shape)`** — a stand-in VALUE. `Partial<T>` checks the name and type of every
  field the fixture sets; unset fields read `undefined`, which is what a
  partially-populated real value does.
- **`collaborator<T>(shape, label)`** — a stand-in BEHAVIOUR. Same compile-time checking,
  plus a Proxy that throws `MissingDoubleMemberError` naming the double and the member when
  the code under test touches something the double never modelled. Symbol keys and a
  documented list of runtime probes (`then`, `toJSON`, `asymmetricMatch`, …) are answered
  rather than thrown for, so a double stays awaitable and printable — each probe class is
  pinned by a test, because a double that explodes while jest renders a failure diff would
  be worse than the cast it replaces.
- **`stubMember<Fn>(impl)`** — for a member declared as an overload set or a generic
  signature (`Repository.save`, `EntityManager.getRepository`). TypeScript genuinely cannot
  check a single-signature jest mock against an overload set, so the cast lives here once;
  the call site still has to NAME the member type, which keeps two checks a blanket cast
  throws away — the member must exist on the real type, and every other member of the
  double stays checked.

All 33 copies now import `stub`. The gate (`tools/gates/banned-construct.ts`) refuses new
`as never` on added lines, with `\bas` so prose cannot match, and it blocked its own
introducing commit twice on lines the migration touched — both were hiding real mismatches.

---

## Confirmed drift — fixed in this change

### SENSOR-MEDIUM-107 — SCADA roundtrip fixture was a pre-refactor flat shape

`scadaPackageRoundtrip.test.ts` built `automationBindings` with `variableId`, `varName` and
`boundWidgetId` at the top level — those are `VariableBinding`'s fields, not
`AutomationBinding`'s — and omitted BOTH required members, `programName` and
`variableBindings`. `as never` carried the fixture unchanged through the refactor that
nested them, so a test named "serialize → load → serialize is a fixed point with ALL widget
fields" was round-tripping a shape the store's own type cannot hold.

### SEC-MEDIUM-060 — RBAC regression guard drove an invalid actor

`tenant-suspend-revocation.spec.ts` set `actor.type: 'SUPER_ADMIN'`, which
`AuthTenantCommandActor` does not admit (`'user' | 'service' | 'system'`). The RBAC-HIGH-007
suspend/revocation guard was therefore driving the service with a command shape the
contract rejects. Both fixtures are now typed at `SuspendTenantLifecycleCommand` /
`AuthTenantCommandMetadata`.

### FARM-MEDIUM-307 — harvest receipt double returned a non-existent state

`create-harvest-record.handler.spec.ts` had `begin()` resolve `{ mode: 'execute' }`.
`MobileCommandReceiptState` is `{mode:'legacy'} | {mode:'started', receiptId} |
{mode:'replay', …}` — no `'execute'`. No branch of the handler can match it, so every test
in the file went down the unmatched path rather than the receipt path the envelope produces.

### FARM-LOW-308 — two production type holes

`get-daily-feeding-plan.handler.ts` compared an enum-typed column to a bare string via
`p.status === ('active' as never)`. It works only because `FeedingProgramStatus.ACTIVE`'s
value happens to be `'active'`; re-case or re-value it and the filter silently matches
nothing — the P-30 failure shape. Now compared against the enum member.
`emit-subgraph-sdl.ts` collected resolvers as `unknown[]` and cast at the call; the list is
now typed at what it holds, and `GraphQLSchemaFactory.create` accepts it with no cast.

---

## Confirmed drift — still open

Nine confirmed findings are not yet fixed and are tracked under **PLAT-HIGH-908** with
owner and deadline rather than being folded silently into "done": the two
`edge-deploy-transform` cases (required fields the transform is documented to synthesize —
the PRODUCTION type is what is wrong, not the test), `vfd-change-set` (two distinct
`RiskLevel` enums with identical members — a production type duplication), the
`race-conditions` vacuous-assertion case, `sw-replay` (queued payloads missing required
fields the backend would reject), the v11-upgrade `consentType` case, `agent-io-config-v2`,
`vfd-parameter-writer`, `feeding-cron-v2.sweep`, and `day-plan-admin`. Several are
production type defects rather than test defects and want their own change.

The remaining ~395 `as never` sites are likewise open under PLAT-HIGH-908: the gate stops
new ones, the SSoT gives every one of them a replacement, and the sweep across unrelated
services is deliberately not folded into this change.
