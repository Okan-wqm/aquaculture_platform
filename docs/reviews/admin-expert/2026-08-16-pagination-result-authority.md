# 2026-08-16 - Paginated results have no versioned shape authority

## ADMIN-HIGH-003 - every tier declares its own paginated result shape

**Severity:** HIGH. **Owner:** admin-expert. **State:** IN-PROGRESS — the
authority lands with this finding's first commit, the consumer migration
and its ratchet follow in the second.

### What is wrong

A paginated list result is declared independently in at least four places:
`apps/admin-api-service` producers, the `web/modules/admin-panel` HTTP
layer, `apps/farm-service` resolvers, and `web/modules/farm-module` hooks.
Each declares its own field set, and they disagree.

The disagreement is not cosmetic. `apps/admin-api-service/src/shared/response.interceptor.ts`
duck-types the envelope with `'data' in data && 'total' in data` behind four
`as` casts, while the real producers emit `{ items, ... }`. The interceptor
therefore never recognises them, and the shape that reaches the browser is
whatever each controller happened to build.

`totalPages` is the sharpest example: with zero rows, some producers emit
`0` and some emit `1`, and a consumer cannot tell which contract it is
holding.

### Why a shared type is not enough

A type alias in one library would still let each tier construct the object
by hand, so the fields could drift again the moment a producer adds one.
The authority has to own **construction**, not just the type, and it has to
be versioned so a shape change is a visible edit rather than a silent
widening.

### What lands in the first commit

`platform/libs/pagination-contracts` — a versioned result authority with a
single constructor, plus `libs/backend-common/src/pagination` as the
NestJS-side bridge. `expectedTotalPages` fixes the zero-row disagreement in
one place: `Math.max(1, Math.ceil(total / limit))`, so an empty page is
page 1 of 1 rather than page 1 of 0.

Nothing consumes it yet. That is deliberate: the lib is reviewable on its
own, and a 56-file producer migration reviewed in the same diff would hide
it.

### What remains, and the gate that will close it

The producer migration across the four consumer roots, landing together
with `tests/invariants/admin-pagination-ssot.spec.ts`. That invariant scans
every production file under those roots and fails on a local result-shape
declaration or a hand-written result object, so it can only pass once the
migration is complete — which is why it is not in the first commit.

One stale expectation must be corrected in that second commit rather than
carried:
`apps/admin-api-service/src/tenant/__tests__/performance/list-tenants-pagination.spec.ts`
asserts `totalPages` is `0` for zero rows. The canonical authority returns
`1`; the assertion is the old duplicate contract and gets bound to the
authority, not relaxed.

**Owner:** admin-expert. **Deadline:** 2026-09-15.

### Provenance

Recovered from a codex worktree stopped on 2026-08-16. The lib exists
nowhere on `main`; `git ls-tree origin/main -- platform/libs/pagination-contracts`
is empty. The worktree also created the lib without the ADR-028 inventory
row its own rubric requires — added here.
