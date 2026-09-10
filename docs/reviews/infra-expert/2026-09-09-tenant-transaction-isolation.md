# The tenant transaction could not say what it needed — infra-expert, 2026-09-09

## INFRA-HIGH-174 — isolation and the RLS assertion were mutually exclusive

`runInTenantTransaction` (`libs/backend-common/src/database/tenant-transaction.ts`)
is the tenant boundary. It pins `search_path` transaction-locally and then asserts
the RLS GUC actually resolved, so a query inside it cannot silently fall back to the
source schema and return another tenant's rows — or none, which is the failure mode
that reads as "the feature is broken" rather than as a security event.

It called `startTransaction()` with no argument. Every one of its ~60 callers
therefore got READ COMMITTED, with no way to ask for more.

`AllocateToTankHandler` needs SERIALIZABLE — it moves fish between containers and
its counter arithmetic must not interleave. So it hand-rolls the transaction
(`allocate-to-tank.handler.ts:115-117`: `createQueryRunner()` +
`startTransaction('SERIALIZABLE')`), which
`tests/invariants/farm-batch-policy-transaction-ssot.spec.ts:17-23` tolerates as an
exception labelled _"until migrated"_.

**The cost is not untidiness.** That handler is the one farm write path running
without the RLS assertion every other handler gets, because the only way to buy
stronger isolation was to give up the tenant-safety checks. Nobody chose that trade;
the helper simply could not express the requirement, so the requirement went around it.

A second consequence follows from the same gap. Raising isolation makes PostgreSQL
serialization failures a real outcome, and nothing in the repo absorbs them: the only
retry implementation is `apps/sensor-service/src/common/transaction.ts`, which has
**zero importers**. Allocate-to-tank has been running SERIALIZABLE bare-handed, with a
40001 propagating straight to the caller.

**Fix (tier 1).** The helper takes an optional isolation level, so the canonical
mechanism can express what its callers legitimately need and they stop routing around
it. A caller that raises isolation also opts into a bounded retry of the whole unit —
sound only because the transaction is already rolled back when the retry begins, which
the docblock states as a requirement on the callback rather than a guarantee. READ
COMMITTED gets no retry: sixty existing callers did not ask for their function to run
twice. The serialization classifier moves into `backend-common` so there is one answer
to "is this safe to retry" instead of two.

Owner @okan-wqm, deadline 2026-10-31.
