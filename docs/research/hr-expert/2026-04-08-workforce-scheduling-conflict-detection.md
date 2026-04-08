# Research: Workforce Scheduling Conflict Detection

**Topic:** Shift overlap detection algorithms, overtime calculation per labor law thresholds, availability and certification validation
**Date:** 2026-04-08
**Agent:** hr-expert

## Sources
- [Interval scheduling - Wikipedia](https://en.wikipedia.org/wiki/Interval_scheduling)
- [Interval Tree - GeeksforGeeks](https://www.geeksforgeeks.org/dsa/interval-tree/)
- [DOL - Fact Sheet #23: Overtime Pay Requirements of the FLSA](https://www.dol.gov/agencies/whd/fact-sheets/23-flsa-overtime-pay)
- [TCP Software - Employee Scheduling and Labor Law Compliance](https://tcpsoftware.com/articles/labor-law-compliance-and-employee-scheduling/)
- [TCP Humanity - Compliance & Conflict Management](https://tcpsoftware.com/products/humanity/compliance/)
- [PostgreSQL - SELECT FOR UPDATE](https://www.postgresql.org/docs/current/explicit-locking.html)

## Key Findings

1. **Two-interval overlap condition (the only correct formula):** intervals `[a_start, a_end)` and `[b_start, b_end)` overlap iff `a_start < b_end AND b_start < a_end`. Using `<=` produces off-by-one false positives for back-to-back shifts.
2. **Interval-tree query is O(log n + k)** where k is the number of overlapping intervals found, versus O(n) for naive linear scans. For employee schedules with thousands of shifts per month, the difference is decisive.
3. **PostgreSQL has native range types and GiST indexes** (`tstzrange`, `daterange`) plus `&&` overlap operator. A GiST index on `tstzrange` gives interval-tree-equivalent performance without hand-rolled trees. `EXCLUDE USING gist (employee_id WITH =, shift_range WITH &&)` is a declarative constraint that prevents ANY overlap insert at the database level.
4. **Conflict detection must run in the same transaction as the insert,** with either `SELECT ... FOR UPDATE` on the employee row or a Postgres exclusion constraint. Check-then-insert without a lock is a classic race that produces double-booked shifts under concurrent writes.
5. **FLSA overtime:** hours over 40 in a workweek at 1.5 × regular rate (US federal). The "workweek" is a fixed 168-hour period chosen by the employer and must be consistent per employee. Some states (e.g., California) also require daily overtime over 8 hours + double-time over 12 hours.
6. **Rest period / rest-between-shifts rules** vary by jurisdiction: EU Working Time Directive requires 11 consecutive hours rest between shifts and a weekly rest of 24 consecutive hours. Many collective agreements add shorter maximum shifts for night work.
7. **Availability constraints:** employee availability windows are themselves intervals; a proposed shift must be a subset (`<@`) of at least one availability window for that day of week, with exceptions tracked as shift-specific availability overrides.
8. **Certification constraints:** each shift/work area declares required certifications; the scheduler must reject a shift assignment if the employee does not hold every required certification with a not-yet-expired expiration date AT the shift start time.
9. **Qualification mismatch is a major class of scheduling conflicts** per industry research — not just double-booking. A valid scheduler treats qualification mismatch as a first-class conflict type, not a warning.
10. **Compliance checks must be configurable per tenant** because labor laws differ across jurisdictions. A rules engine with tenant-scoped policy (max weekly hours, overtime threshold, min rest, mandatory break) is the correct architecture.

## Security Concerns

- **HIGH:** Race condition on shift insertion without DB-enforced exclusion constraint produces double-booked employees — no amount of application-level validation prevents this under concurrency.
- **HIGH:** Missing certification check at schedule time can put an unqualified worker on a hazardous task, creating life-safety and liability exposure.
- **HIGH:** Tenant-crossed scheduling (employee of tenant A assigned to tenant B site) must be impossible at the DB layer, not validated in the handler.
- **MEDIUM:** Timezone ambiguity — storing shifts as wall-clock `timestamp without time zone` produces silent errors around DST transitions. Use `timestamptz` universally.
- **MEDIUM:** Overtime threshold hard-coded to 40 hours/week ignores California daily OT, EU caps, and union agreements.

## Performance Concerns

- Linear scan of all shifts per employee on every insert is O(N) and degrades as history grows. Use GiST index on `tstzrange` with `&&` operator.
- Conflict detection at the row level should be replaced by a Postgres `EXCLUDE USING gist` constraint for strongly-atomic guarantee.
- Weekly plan generation for an entire site is a constraint-satisfaction problem; a naive O(employees × shifts × certs) nested loop is unusable at scale. Batch-prefetch certifications once per plan-run.
- Overtime calculation replayed from raw punches over a quarter must use window functions (`SUM() OVER (PARTITION BY employee_id, workweek_start)`), not per-row subqueries.

## Architectural Implications for hr-expert reviews

- Shift entity must carry a `tstzrange` column (not separate `start_at` / `end_at`). TypeORM custom column type `tstzrange` with a transformer is required.
- The shifts table must declare `EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, shift_range WITH &&)` — this is a migration-level requirement, not optional.
- `conflict-detection.service.ts` must internally delegate to the DB constraint; application-level detection is an informational pre-flight only, never the sole source of truth.
- `overtime-calculator.service.ts` must be pure, unit-tested against FLSA DOL examples, and accept a `JurisdictionPolicy` argument so CA daily OT, EU caps, union rules can be plugged in.
- Availability constraint: store employee availability as a list of weekly `timerange` windows; validate shift.start/end against those windows plus same-day exceptions.
- Certification constraint: a `ShiftCertificationRequirement` table joins shift-type → required cert type; scheduler joins candidate employee → valid certifications at shift start.
- Schedule change notifications must be published AFTER commit via the outbox (or NATS JetStream acked publish) to guarantee delivery.
- Every scheduler query must be tenant-scoped at the DB layer (search_path + tenant_id predicate).

## Domain Rule Additions for hr-expert

- **[CRITICAL]** Shift entities must store time as `tstzrange` with a GiST exclusion constraint `EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, shift_range WITH &&)`. Application-level overlap checks without this DB constraint are a blocking review failure.
- **[CRITICAL]** Every shift assignment command must validate required certifications at shift start time (not at "now") — an expired cert at shift start disqualifies the employee even if it is still valid today.
- **[CRITICAL]** Tenant isolation for shifts must be enforced at both the GiST constraint (`tenant_id WITH =`) and the query (tenant_id predicate / search_path). Cross-tenant assignment must be impossible at the DB layer.
- **[HIGH]** `overtime-calculator.service.ts` must accept a `JurisdictionPolicy` parameter supporting at minimum: US-federal (weekly 40), California (daily 8/12 + weekly 40), EU-WTD (weekly 48 averaged), and a tenant-override policy. Hard-coded thresholds are a blocking review failure.
- **[HIGH]** Rest-between-shifts validation must run on every shift assignment: configurable minimum (default 11h per EU WTD), violated assignments must be rejected unless an override reason is recorded.
- **[HIGH]** All shift/time columns must be `timestamptz`, never `timestamp without time zone`. Shift ranges must be computed in UTC and rendered per employee timezone on display.
- **[HIGH]** Overtime calculation must use window functions in SQL (`SUM() OVER (PARTITION BY employee_id, workweek_start)`); per-row subqueries over a pay period are a blocking performance review failure.
- **[HIGH]** Availability windows must be stored as weekly `timerange` per employee; shift insertion must validate the shift range is contained within an availability window (minus dated exceptions).
- **[MEDIUM]** The "workweek" start day/time must be configurable per tenant and per employee, persisted, and immutable for historical workweeks (changing it retroactively tampers with overtime audit).
- **[MEDIUM]** Schedule-change notifications must be published through the outbox after commit; direct NATS publish inside the transaction is a blocking review failure.

Research: `docs/research/hr-expert/2026-04-08-workforce-scheduling-conflict-detection.md`
