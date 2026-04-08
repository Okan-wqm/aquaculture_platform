# Research: Per-Tenant Quotas and Noisy-Neighbor Isolation

**Topic:** Per-tenant rate limits, API quotas, storage quotas, AI budget caps, connection-pool isolation, fair queueing, circuit breaker per tenant
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- AWS Builders' Library, "Fairness in multi-tenant systems": https://aws.amazon.com/builders-library/fairness-in-multi-tenant-systems/ — weighted fair queuing, admission control, bulkheading.
- AWS Compute Blog, "Building resilient multi-tenant systems with Amazon SQS fair queues": https://aws.amazon.com/blogs/compute/building-resilient-multi-tenant-systems-with-amazon-sqs-fair-queues/ — per-tenant virtual queues, noisy-neighbor mitigation.
- AWS Well-Architected SaaS Lens, "Tenant Isolation" chapter — noisy-neighbor guidance.
- Microsoft Learn, "Noisy Neighbor antipattern": https://learn.microsoft.com/en-us/azure/architecture/antipatterns/noisy-neighbor/noisy-neighbor — mitigation patterns.
- Microsoft Learn, "Architectural approaches for compute in multitenant solutions" — dedicated vs pooled compute tradeoffs.
- Gravitee blog, "API Rate Limiting at Scale: Patterns, Failures, and Control Strategies" — token bucket, leaky bucket, sliding window.
- Netflix Tech Blog (Hystrix / resilience4j) — circuit breaker pattern per upstream / per tenant.
- Aqua-saas codebase: `libs/backend-common/src/security/throttler.guard.ts`, `apps/ai-service/` (AI budget cap implementation), `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`.

## Key Findings

1. **Noisy neighbor is the #1 multi-tenant performance failure mode** per Azure Architecture Center and AWS Builders' Library. In 2026, AWS introduced SQS fair queues specifically because every SaaS platform eventually hits this.
2. **Token bucket per tenant** is the canonical rate-limiter primitive. Each tenant has `capacity` tokens refilled at `refill_rate` per second; requests consume tokens; burst is limited by capacity. Parameters set per plan tier: Starter (60/min, burst 120), Professional (300/min, burst 600), Enterprise (3000/min, burst 6000), Custom (negotiated).
3. **Layered quota model**:
   - **API rate limit** (requests per unit time) — token bucket, Redis-backed.
   - **API daily quota** (requests per day) — counter with TTL 24h.
   - **Storage quota** (GB) — tenant metadata, enforced on upload boundary.
   - **Compute quota** (CPU-seconds, queue-seconds) — for long-running jobs.
   - **AI budget cap** ($ per month) — enforced by AI service, tracks token usage × cost, blocks further requests when budget hit.
   - **Connection pool share** — per-tenant connection pool partition or fair scheduling.
4. **Atomic rate-limit increment via Redis Lua** is mandatory. Non-atomic `GET → INCR → SET` has a race window. Reference Lua: `local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return c`.
5. **Fail-closed when Redis is unavailable** on billable/rate-limited endpoints. Fail-open = uncontrolled noisy neighbor. Gateway must reject with 503 on Redis breaker open.
6. **Circuit breaker per upstream × per tenant.** A malformed tenant query that repeatedly times out the DB must trip a tenant-scoped breaker — not a global breaker (which would break every tenant). State: `CLOSED → OPEN → HALF_OPEN`.
7. **Connection pool isolation.** Microsoft guidance: dedicated subset of pool per tier, or fair scheduling weighted by plan. A single tenant exhausting the pool starves all others.
8. **Fair queueing for background jobs.** AWS SQS fair queues (2025) introduce per-tenant virtual queues with round-robin dispatch. Aqua-saas equivalent on NATS JetStream: use per-tenant consumer groups with max-deliver-per-tenant limits, or application-level WFQ.
9. **Bulkheading.** Isolate the resource budget of each tenant so a faulty tenant cannot consume more than its share: dedicated goroutine/thread pool partition, dedicated DB connection budget, dedicated memory budget.
10. **Quota response headers.** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Bucket` (tenant-scoped). Quota exhaustion returns `429` with `Retry-After`.
11. **AI budget cap is a special case.** Because LLM cost is per-token and tokens are only known post-generation, the budget check must reserve a pessimistic upper bound (`max_tokens × price`) BEFORE the call, then reconcile after. Missing reservation = budget overshoot.

## Security Concerns

- **Per-IP-only rate limit bypasses via botnet.** Login rate limit key MUST be `(ip + username)` composite.
- **Per-tenant AI budget bypass** — any code path that calls the LLM without going through the budget reservation = CRITICAL (runaway cost).
- **Tenant-scoped circuit breaker state leak.** If breaker state is keyed by operation only (not `tenantId + operation`), one tenant can trigger a breaker that blocks all tenants.
- **Fair-queueing with starvation.** Pure FIFO queues allow the largest tenant to starve small tenants; fair queueing is a security / availability concern, not just performance.
- **Rate-limit cache miss opens** — if Redis is down and the platform fails open, brute-force and DoS windows open simultaneously.

## Performance Concerns

- **Token bucket overhead** — one Redis Lua call per request; p99 ~1 ms on local cluster. Acceptable for API routes.
- **Quota header computation** — compute lazily only when the limiter runs.
- **Circuit breaker memory** — per-tenant state is O(tenants × operations); cap to active tenants with TTL eviction.
- **Background job fair queueing** — WFQ has O(log N) scheduling cost; acceptable at <10K tenants.
- **Connection pool partitioning** — static partitions waste capacity; dynamic weighting is more efficient but more complex.

## Architectural Implications for multi-tenant-saas-expert reviews

- Every billable / expensive endpoint must have a per-tenant quota check BEFORE the handler runs.
- Rate-limit keys must be tenant-scoped (or tenant+user composite for auth endpoints).
- Rate-limit implementation must be atomic Redis Lua, not read-modify-write.
- Circuit breakers must be keyed `(tenant_id, operation)`, not operation alone.
- AI / LLM callers must reserve budget pessimistically before the call and reconcile after.
- Background job queues must have per-tenant fair scheduling to prevent starvation.
- Connection pool must have per-tenant or per-tier partitioning.

## Domain Rule Additions for multi-tenant-saas-expert

- **Plan-tier rate limit defaults** — Starter 60/min (burst 120), Professional 300/min (burst 600), Enterprise 3000/min (burst 6000), Custom negotiated. Missing per-tenant rate limit on tenant-facing API = HIGH.
- **Atomic rate limit via Redis Lua.** Non-atomic `GET→INCR→SET` or `MULTI/EXEC` without atomic INCR = CRITICAL race window.
- **Fail-closed on Redis outage** for billable / auth endpoints. Fail-open production path = CRITICAL.
- **Per-tenant circuit breaker** keyed `(tenant_id, operation)`. Global-only breaker = HIGH (one tenant trips the breaker for everyone).
- **AI budget cap reservation.** LLM caller reserves pessimistic upper bound (`max_tokens × price`) before the call, reconciles after. Missing reservation = CRITICAL (runaway cost).
- **Storage quota enforced at upload boundary** — the `PUT /upload` handler checks `current_used + size > tenant.storage_quota`, not a background sweeper. Missing = HIGH (silent overrun).
- **Connection pool partitioning** — per-tier or per-tenant partition; missing = MEDIUM (pool exhaustion risk).
- **Fair queueing for background jobs.** NATS consumers must honor per-tenant max-deliver limits or WFQ; pure FIFO = HIGH (starvation risk).
- **Quota response headers** — `X-RateLimit-Limit / Remaining / Reset / Bucket`, `429` + `Retry-After` on exhaustion. Missing headers = LOW to MEDIUM (client retry loop inefficiency).
- **Per-tenant kill switch** that can disable an expensive feature for one tenant without deploy is mandatory (noisy-neighbor ops response). Missing = HIGH.
