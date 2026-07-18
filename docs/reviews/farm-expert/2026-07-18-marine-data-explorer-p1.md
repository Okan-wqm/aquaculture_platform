# Marine Data Explorer — P1 resilience (2026-07-18)

Phase P1 of the Marine Data Explorer plan (`docs/plans/2026-07-18-marine-data-explorer/PLAN.md`).
Introduces the provider-façade seam by routing every marine upstream call through a single
resilience choke point, closing the missing-circuit-breaker finding before the full provider
port + adapter decomposition and the honest-contract work (P2).

## HIGH — no circuit breaker on marine external calls

`MarineDataService` reached the CMEMS public WMTS and the CDSE Sentinel Process API through
raw `fetch` calls with only a 30 s timeout — no circuit breaker, no retry — violating the
repo's external-call invariant (every external dependency call MUST be wrapped in the canonical
`CircuitBreakerService`; precedent: `apps/farm-service/src/regulatory/mattilsynet-api.service.ts`).
A sustained CMEMS or CDSE outage would keep every marine request hammering a struggling upstream
and tying up request threads.

**Fix** — new `apps/farm-service/src/marine-data/providers/marine-upstream.client.ts`:
a single `MarineUpstreamClient` that owns the deadline, a bounded retry for idempotent CMEMS
GETs (none for Sentinel POSTs, which burn processing units), and the fail-closed breaker.
CMEMS is globally keyed (public upstream, failures are upstream-wide); Sentinel/CDSE is keyed
per tenant (per-tenant credentials + PU quota) so one tenant's failing integration cannot open
the breaker for others. A 5xx is thrown inside the breaker fn so the outage is counted, yet the
original response is still returned so the existing tile/point status handling is unchanged; an
open breaker sheds with a 503. `MarineDataService.fetchCmems`/`fetchSentinelProcess` delegate to
the client, so no marine code path can reach an upstream without the breaker.
