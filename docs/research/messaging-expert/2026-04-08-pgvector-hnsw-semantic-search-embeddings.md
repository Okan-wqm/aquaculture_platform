# Research: pgvector HNSW Semantic Search and Embedding Pipeline

**Topic:** HNSW index parameters, embedding dim 384, batch worker, consent gating, invalidation on anonymization
**Date:** 2026-04-08
**Agent:** messaging-expert

## Sources

- [pgvector — Open-source vector similarity search for Postgres (GitHub README)](https://github.com/pgvector/pgvector)
- [HNSW Indexes with Postgres and pgvector — Crunchy Data Blog](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- [Faster similarity search with pgvector indexes — Google Cloud Blog](https://cloud.google.com/blog/products/databases/faster-similarity-search-performance-with-pgvector-indexes/)
- [Accelerate HNSW indexing and searching with pgvector on Aurora — AWS Database Blog](https://aws.amazon.com/blogs/database/accelerate-hnsw-indexing-and-searching-with-pgvector-on-amazon-aurora-postgresql-compatible-edition-and-amazon-rds-for-postgresql/)
- [Understanding vector search and HNSW index with pgvector — Neon](https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector)

## Key Findings

### 1. HNSW index parameters and embedding dim 384
- The three tunables on pgvector HNSW are `m`, `ef_construction`, `ef_search`.
- `m` (default 16, range 5–48): max connections per node in the layered graph. Higher = denser graph = better recall + faster query but more memory and slower build. For 384-dim sentence-transformer embeddings, `m=16` is the right starting default; `m=24` is justified only if recall measurements show > 0.99 is needed.
- `ef_construction` (default 64): build-time candidate list size. Larger = better recall but slower index build. For messaging service with batch ingest, `ef_construction=128` is a reasonable safety margin.
- `ef_search` (default 40, query-time): runtime candidate list size, set per query session via `SET LOCAL hnsw.ef_search = ...`. Larger = better recall, slower query. Tune empirically against a labeled query set.
- 384 dimensions (e.g., `all-MiniLM-L6-v2` sentence-transformer) is well below pgvector's `vector` type max of 2,000 — no need for `halfvec`.
- **Distance operator class must match query operator.** For cosine similarity (typical for sentence embeddings), use `vector_cosine_ops` and the `<=>` query operator. Mismatched ops class -> the index is not used at all and queries fall back to sequential scan.

### 2. Index creation syntax and tenancy
```sql
CREATE INDEX CONCURRENTLY messages_embedding_hnsw_cosine
  ON messages USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);
```
- Use `CONCURRENTLY` (where supported on partitioned tables) to avoid an ACCESS EXCLUSIVE lock during build.
- For partitioned `messages`, the index must be created per-partition then attached, or via a parent-level index that PostgreSQL propagates (the partition-level index attach pattern from PG 15+).
- **Multi-tenant query pattern:** every query against the embedding column MUST include `WHERE tenant_id = $1` AND a `created_at` partition bound. Without these, the HNSW search runs across the global index — both a privacy violation and a performance disaster.
- A composite filter is the source of subtlety: HNSW does not natively support filtered search with high recall. The query `WHERE tenant_id = $1 ORDER BY embedding <=> $2 LIMIT 10` may retrieve from the global graph and then filter, returning fewer than 10 results. Workarounds: (a) use partial HNSW indexes per tenant or per partition; (b) use HNSW post-filter with `iterative_scan = strict_order` (pgvector 0.8+); (c) accept lower recall with `ef_search` boost.

### 3. Index build memory
- `maintenance_work_mem` must be large enough to fit the entire HNSW graph during build, otherwise build time degrades by 10-100x. For 1M vectors at 384 dim with m=16, the graph requires roughly 1M * (384*4 + 16*8) = ~1.6 GB. Set `SET maintenance_work_mem = '4GB'` for safety before bulk index builds.
- `max_parallel_maintenance_workers` should be set to use multiple cores for parallel index build (pgvector 0.6+).

### 4. Batch embedding worker
- Production pattern: cron every 5 minutes selects up to 100 messages with `WHERE embedding IS NULL AND consent_gate_passed = true`, sends them to ai-service via NATS request-reply, writes back the resulting `vector(384)` to the message row.
- **Consent gate is the gatekeeper, not an afterthought.** Both `TenantAiSetting.embeddingsEnabled = true` AND `UserAiConsent.embeddingsConsented = true` must be checked at the SELECT-time (filter the candidate set) AND re-checked at the WRITE-time (defense against race with consent withdrawal).
- Batch size of 100 balances latency and throughput; larger batches risk NATS request-reply timeout (default 30s for embedding model with 384 dim).
- The worker MUST handle partial-failure: if ai-service returns 80 vectors out of 100, write the 80 and re-queue the 20. Do not roll back the whole batch.
- Idempotency: the worker uses `SELECT ... FOR UPDATE SKIP LOCKED` so multiple worker replicas don't double-process.
- **Backpressure:** if NATS request-reply queue depth grows, slow down or pause the embedding worker — never block message INSERT on embedding generation.

### 5. Invalidation on anonymization (CRITICAL coupling)
- When `UserDataAnonymized` fires for a user, **every embedding row sourced from that user's messages must be deleted**, not just the source message anonymized.
- Why: a 384-dim vector is a high-fidelity representation of the original text. Given a candidate text, an attacker can compute its embedding and find the nearest neighbor in the index, recovering the "anonymized" content. This is the embedding inversion attack documented in the literature.
- Deletion must be in the same transaction as message body anonymization. Either:
  - Wrap message-anonymize + embedding-delete in one DB transaction (preferred), OR
  - Use a saga with compensating action: anonymize message, then publish event; embedding deletion is the consumer side; if it fails, alarm and replay.
- The same rule applies to `KnowledgeEntry` rows derived from anonymized messages and to AI-generated summaries persisted as `MessageAnalysis`.

### 6. Dual consent gating
- `TenantAiSetting.embeddingsEnabled` is the tenant-wide kill switch. Off -> no embeddings generated for that tenant.
- `UserAiConsent.embeddingsConsented` is the per-user opt-in. Off -> no embeddings for that user's messages.
- Both must be `true` for any embedding to be generated.
- Withdrawal of either consent at runtime triggers the "invalidation" flow: cron job sweeps existing embeddings for the now-non-consented user/tenant and deletes them. Sweep latency must be < 24 hours to satisfy GDPR Article 17(1)(b) (consent withdrawal triggers erasure).

### 7. Index hygiene
- HNSW indexes degrade slightly under heavy DELETE workload because tombstones accumulate. Periodic `REINDEX CONCURRENTLY` (e.g., monthly) is recommended for high-churn tables.
- Vector column should be NOT NULL only after embedding generation; before that, NULL signals "pending." Partial index `WHERE embedding IS NOT NULL` keeps the HNSW index size aligned with embedded rows only.

## Security Concerns

- **Embedding inversion attack:** as above. Failing to delete embeddings on anonymization is a CRITICAL re-identification vulnerability.
- **Cross-tenant search leak:** if the query forgets to filter on `tenant_id`, the HNSW search returns nearest neighbors from other tenants. Mitigation: query layer enforces `WHERE tenant_id = $currentTenant` AND `created_at` partition bound; consider per-tenant partial indexes for stronger isolation.
- **Consent bypass via stale cache:** if `UserAiConsent` is cached in Redis and the cache is stale, a withdrawn consent may still allow embedding generation. Mitigation: short TTL (60s) and explicit cache invalidation on consent change events.
- **Side-channel via embedding presence:** the existence of an `embedding` value on a row reveals that the user consented to AI processing — a privacy signal in itself. Avoid leaking this in API responses to other users.
- **Model poisoning:** if the ai-service is compromised, malicious embeddings can be written that bias future searches. Mitigation: ai-service is in a separate trust boundary; embeddings are validated for shape (384 dimensions) and bounded magnitude on write.

## Performance Concerns

- **Sequential scan when ops class mismatched.** Always verify with `EXPLAIN` that the query uses `Index Scan using messages_embedding_hnsw_cosine`, not `Seq Scan`.
- **Filtered HNSW recall cliff.** With aggressive WHERE filters, HNSW may return fewer than `LIMIT k` results because the graph traversal hits no matching candidates. Tune `ef_search` upward or use iterative scan.
- **maintenance_work_mem starvation.** First production index build on 1M+ rows with default `maintenance_work_mem=64MB` will take hours. Always raise to multiple GB before bulk build.
- **Embedding worker tail latency.** A single slow ai-service call blocks the batch. Use per-message timeout (5s) and continue with successful items.
- **REINDEX without CONCURRENTLY** locks the table — never run during production hours.
- **HNSW build is single-transaction** by default; use parallel maintenance workers for speedup on multi-core systems.

## Architectural Implications for messaging-expert reviews

When reviewing AI/embedding code, verify:

1. **Embedding deletion is in the same DB transaction as message anonymization** (or via saga with compensating action). Missing -> CRITICAL (re-identification).
2. **Every semantic-search query filters on `tenant_id` AND a `created_at` partition bound.** Missing -> CRITICAL (cross-tenant leak + perf).
3. **HNSW index uses correct ops class** (`vector_cosine_ops` for cosine, `vector_l2_ops` for L2). Mismatch -> HIGH (perf cliff to seq scan).
4. **Dual consent check runs at both worker SELECT-time AND WRITE-time.** Single check -> HIGH (race on consent withdrawal).
5. **Embedding worker uses `SELECT ... FOR UPDATE SKIP LOCKED`** to allow horizontal scaling without double-processing. Missing -> MEDIUM.
6. **Partial failures handled** — write succeeded vectors, requeue failed. All-or-nothing rollback -> MEDIUM.
7. **Per-message timeout** on ai-service call (e.g., 5s) and circuit breaker on embedding subsystem. Missing -> MEDIUM.
8. **Embedding NEVER blocks message INSERT.** Synchronous embedding in the message-send path -> HIGH (latency, availability).
9. **Consent withdrawal triggers a sweep** within 24 hours. Missing -> CRITICAL (GDPR violation).
10. **`maintenance_work_mem` raised before bulk index build** in migration. Missing -> MEDIUM (operational).
11. **Embedding column constrained**: dimension 384, magnitude bound. Missing constraints -> LOW.
12. **No client-facing API exposes the raw embedding vector.** Exposing it is HIGH (model leak + side channel).

## Domain Rule Additions for messaging-expert

- HNSW index on `messages.embedding` MUST use `vector_cosine_ops` with `m=16`, `ef_construction=128` as defaults; deviations require benchmarked justification.
- Every semantic-search query MUST filter on `tenant_id` AND include a `created_at` partition bound.
- The embedding pipeline MUST verify dual consent (`TenantAiSetting.embeddingsEnabled` AND `UserAiConsent.embeddingsConsented`) at SELECT-time (filter candidates) AND re-verify at WRITE-time (race against withdrawal).
- Embedding deletion on `UserDataAnonymized` MUST be in the same transaction as message-body anonymization, or via compensating saga with explicit replay on failure.
- Withdrawal of `UserAiConsent` or `TenantAiSetting.embeddingsEnabled` MUST trigger a sweep job that deletes existing embeddings within 24 hours (GDPR Article 17(1)(b)).
- Embedding generation MUST never block the message INSERT path; the worker is asynchronous, batched (100 max), with `SELECT ... FOR UPDATE SKIP LOCKED`.
- Per-message ai-service timeout MUST be <= 5 seconds with circuit breaker; partial-batch failure MUST write the successful subset and requeue the failures.
- Embedding column dimension MUST be locked at 384 by a CHECK constraint or column type assertion; arbitrary-dimension writes MUST fail loudly.
- The raw embedding vector MUST NEVER be exposed via any client-facing API (federation field, REST endpoint, GraphQL field).
- HNSW indexes on partitioned `messages` table MUST be created per-partition with `CONCURRENTLY` and attached to a parent index — no parent-level blocking builds.
