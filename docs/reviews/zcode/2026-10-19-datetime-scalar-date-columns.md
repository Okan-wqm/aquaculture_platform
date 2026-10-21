# 2026-10-19 — DateTime scalar / TypeORM date-column serialization crash

## PLAT-CRITICAL-931 — GraphQL queries selecting date-only columns crash in production

- **Severity:** CRITICAL (production data path)
- **Status:** OPEN → fixed by this branch
- **Evidence:** `POST /graphql query { purchaseOrders(filter:{}) { items { expectedDeliveryDate } } }`
  on app.suderra.com returns
  `Expected DateTime.serialize("2026-10-17") to return non-nullable value, returned: null`
  (INTERNAL_SERVER_ERROR). Same failure on `workOrders { items { dueDate } }`.
- **Root cause:** TypeORM's Postgres driver hydrates `type: 'date'` columns to
  date-only strings (`DateUtils.mixedDateToDateString`), while the default
  NestJS `GraphQLISODateTime` serializes only real `Date` instances
  (`value instanceof Date ? value.toISOString() : null`). The string reaches
  the scalar, serialize returns null, the non-nullable field errors and the
  whole selection fails — which is why /sites/storage?tab=purchase-orders and
  the maintenance work-orders table render nothing in production.
- **Fix (architectural, SSoT):** platform `DateTimeScalar` in
  `libs/backend-common/src/graphql/date-time.scalar.ts` (beside DecimalScalar)
  that serializes Date / date-only string / ISO string / epoch; registered once
  per subgraph via `scalarsMap: [{ type: Date, scalar: DateTimeScalar }]`
  (farm-service in this change). No per-entity transformers — one mechanism.

## Verification

- Unit: `date-time.scalar.spec.ts` (date-only string = the prod crash input).
- Live: after deploy, the two prod queries above must return data.
