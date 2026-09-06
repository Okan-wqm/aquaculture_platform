# A measured zero is not missing data — 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `245789e15`.

Generalised from `claude/marine-data-explorer-arch-15y8qq`. Its P0 batch fixed this class in
`weather.resolver.ts`, a file main has since deleted, so there was nothing to port — but the class
itself was never swept, and it survived in fourteen other reads.

## FARM-HIGH-321 — fourteen reads reported a measured zero as no data

**Severity:** HIGH. **Owner:** farm-expert. **State:** IN-PROGRESS.

**Evidence.** `DecimalTransformer.from` returns `number | null`, so a read carries two distinct
values: `null` means nobody measured this, `0` means someone measured zero. Fourteen response
mappings collapsed them with a truthiness guard:

```ts
sgr: batch.sgr ? Number(batch.sgr) : undefined;
```

The collapse is always in the same direction — towards "no data":

| Read                 | A zero means                   | It was reported as          |
| -------------------- | ------------------------------ | --------------------------- |
| `batch.sgr`          | the batch did not grow         | growth unmeasured           |
| `tank.freeboard`     | the tank is filled to the rim  | freeboard unknown           |
| `tank.waterVolume`   | the tank is drained            | volume unknown              |
| `record.feedCost`    | the feed cost nothing          | dropped from the cost total |
| `loc.capacity`       | the location is decommissioned | capacity unbounded          |
| `review.finalRating` | the lowest possible rating     | not yet rated               |

Every column involved is `nullable: true`. The schema therefore already had a representation for
"unset", and zero was never a sentinel for it — which is what makes all fourteen unambiguous
defects rather than a judgement call per field.

The repository had already found this once: `apps/sensor-service/src/process/services/unified-tag.service.ts`
carried a private `numberOrUndefined` and a docblock stating the rule, because the same guard was
dropping a 0-100% sensor's `engMin=0` and low-low alarm limits at 0, which the edge then never
enforced. The fix stayed local to that one file.

**Rule violated.** A nullable numeric column read maps null to absent and keeps zero, because the
schema already has a representation for unset.

**Fix.** `numberOrUndefined` moves next to `DecimalTransformer` in
`libs/backend-common/src/database/decimal-transformer.ts` — the read-side companion of `from`,
which produces exactly the `number | null` it consumes. All fourteen reads call it, and
sensor-service's private copy is deleted in favour of the shared one.

`tests/invariants/nullable-numeric-zero-preserved.spec.ts` closes the pattern. It matches a guarded
**property access** with the same expression on both sides, which is what an entity read looks
like, and deliberately does not match a bare identifier: the 39 remaining occurrences are HTTP
query parameters (`page ? Number(page) : undefined`) where the value is a string, the guard is also
rejecting `''`, and zero is not a measurement. Claiming those would make the gate unlandable for a
reason it cannot defend.

**Closure criterion.** Verified in both directions: reverting `equipment.resolver.ts:381` to the
truthiness guard fails the invariant with that exact `file:line`, and restoring it passes. The
helper has direct unit cases including a round-trip against `DecimalTransformer.from`
(16/16 in `decimal-transformer.spec.ts`). `npm run type-check` green across all 41 projects;
30 farm-service suites (106 tests), 2 hr-service suites (16 tests) and sensor-service's
`discover-tags-zero-limits` all pass — that last one is the guard on the shared-helper delegation.

**Not covered.** `get-performance-summary.handler.ts` has no spec of its own, so the hr-service
change is covered structurally by the invariant and the helper's unit tests rather than by a
behavioural test of that handler.
