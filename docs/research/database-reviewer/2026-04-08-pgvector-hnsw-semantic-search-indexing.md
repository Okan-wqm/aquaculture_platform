# Research: pgvector HNSW Indexing for Semantic Search — Parameters, Dimensions, Recall, IVFFlat Comparison

**Topic:** Production configuration of pgvector HNSW indexes for multi-tenant semantic search — parameter tuning, dimension choice, recall vs latency, IVFFlat vs HNSW, planner cooperation.
**Date:** 2026-04-08
**Agent:** database-reviewer

## Sources
- [pgvector README (GitHub master)](https://github.com/pgvector/pgvector/blob/master/README.md)
- [pgvector: HNSW max dimension issue #461](https://github.com/pgvector/pgvector/issues/461)
- [pgvector v0.5.0: Faster semantic search with HNSW indexes (Supabase)](https://supabase.com/blog/increase-performance-pgvector-hnsw)
- [Crunchy Data: HNSW Indexes with Postgres and pgvector](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- [Crunchy Data: Performance Tips Using Postgres and pgvector](https://www.crunchydata.com/blog/pgvector-performance-for-developers)
- [AWS: Accelerate HNSW indexing and searching with pgvector on Aurora PostgreSQL](https://aws.amazon.com/blogs/database/accelerate-hnsw-indexing-and-searching-with-pgvector-on-amazon-aurora-postgresql-and-amazon-rds-for-postgresql/)
- [AWS: Optimize generative AI applications with pgvector indexing (IVFFlat and HNSW)](https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/)
- [AWS: Supercharging vector search performance with pgvector 0.8.0 on Aurora PostgreSQL](https://aws.amazon.com/blogs/database/supercharging-vector-search-performance-and-relevance-with-pgvector-0-8-0-on-amazon-aurora-postgresql/)
- [Tiger Data: Vector Database Basics: HNSW](https://www.tigerdata.com/blog/vector-database-basics-hnsw)
- [Tiger Data: Nearest Neighbor Indexes: What Are IVFFlat Indexes in pgvector](https://www.tigerdata.com/blog/nearest-neighbor-indexes-what-are-ivfflat-indexes-in-pgvector-and-how-do-they-work)
- [AWS: Self-managed multi-tenant vector search with Amazon Aurora PostgreSQL](https://aws.amazon.com/blogs/database/self-managed-multi-tenant-vector-search-with-amazon-aurora-postgresql/)

## Key Findings

1. **pgvector provides two ANN index types:** IVFFlat and HNSW. By default, pgvector performs exact nearest-neighbor search (perfect recall, O(n)). Indexes trade recall for speed.
2. **HNSW is the recommended default in modern deployments.** It offers better speed-recall tradeoff than IVFFlat, does not require pre-populated training data, and is robust against evolving data distributions. IVFFlat is only preferable when index-build speed and lower memory are critical.
3. **HNSW parameters (build time):**
   - `m` — maximum number of connections per layer in the graph. Default 16. Typical range 8-48. Higher `m` = better recall + more memory + larger index.
   - `ef_construction` — size of the dynamic candidate list during graph building. Default 64. Typical range 40-200. Higher = better recall, slower build.
4. **HNSW parameter (query time):**
   - `hnsw.ef_search` — size of the dynamic candidate list during query. Default 40. Typical range 20-500. Higher = better recall, slower queries. Set per-session via `SET LOCAL hnsw.ef_search = 100` inside the transaction for query-specific tuning.
5. **IVFFlat parameters:**
   - `lists` — number of k-means cluster centroids to partition vectors into. Recommendation: `rows/1000` for ≤1M rows, `sqrt(rows)` for >1M rows.
   - `ivfflat.probes` — how many clusters to search at query time. Default 1. Higher = better recall, slower.
6. **IVFFlat requires populated data to train on.** Building an IVFFlat index on an empty or small table produces poor cluster centroids and degraded recall forever — unless rebuilt. HNSW has no such requirement.
7. **Dimension limits:**
   - `vector` — up to **16,000 dimensions**, but HNSW/IVFFlat indexes support only up to **2,000 dimensions**.
   - `halfvec` (half-precision, pgvector 0.7+) — up to 4,000 dimensions with index support.
   - `bit` — up to 64,000 dimensions (Hamming/Jaccard).
   - `sparsevec` — up to 1,000 non-zero elements.
8. **Dimension choice is model-dictated, not freely chosen.** OpenAI `text-embedding-3-small` = 1536, `text-embedding-3-large` = 3072 (exceeds HNSW index limit — must use `halfvec` or dimension reduction), `ada-002` = 1536, `all-MiniLM-L6-v2` = 384, multilingual models often 768 or 1024. Choice drives storage (`4 * dim + 8` bytes per vector for `vector` type) and index memory.
9. **Operator classes map distance metric to index type.** Must match the query operator:
   - `vector_l2_ops` — Euclidean distance (`<->`)
   - `vector_cosine_ops` — cosine distance (`<=>`)
   - `vector_ip_ops` — inner product (`<#>`)
   - `vector_l1_ops` — Manhattan / L1
   - `bit_hamming_ops`, `bit_jaccard_ops` — bit vectors
   An HNSW index built with `vector_l2_ops` will NOT be used for a query using `<=>` (cosine). Mismatch = CRITICAL (silent sequential scan).
10. **Normalize vectors if using cosine OR inner product.** Cosine distance on non-normalized vectors gives different results from on normalized vectors. Inner product on normalized vectors is equivalent to cosine and faster. Normalization at ingest time = correct pattern.
11. **Query planner cooperation is fragile.** The planner may prefer a sequential scan over the HNSW index when:
    - Row estimate is low (small table or misleading statistics).
    - LIMIT is large relative to table size.
    - Additional `WHERE` predicates reduce selectivity below the index's effective threshold.
    - `ANALYZE` has not run since index creation.
    Monitor `EXPLAIN (ANALYZE, BUFFERS)` on production queries; `Seq Scan` where `Index Scan using hnsw_idx` was expected = HIGH.
12. **ANALYZE is mandatory after bulk load.** Planner statistics drive the decision to use or bypass the HNSW index. Missing ANALYZE after large inserts = HIGH (silent fallback to sequential scan).
13. **Vacuum on HNSW indexes is slow.** Crunchy Data recommends `REINDEX INDEX CONCURRENTLY idx_name; VACUUM table_name;` rather than vacuuming directly on very-large HNSW indexes — faster and reclaims space more effectively.
14. **HNSW index builds consume maintenance_work_mem aggressively.** Set `maintenance_work_mem` high (2-8 GB) before building on large tables. Undersized = very slow build. Also parallelize with `max_parallel_maintenance_workers` (pgvector 0.5.1+).
15. **Multi-tenant vector search has two models:**
    - **Schema-per-tenant:** each tenant gets its own HNSW index. Isolation is structural. Downside: N indexes to maintain.
    - **Shared table with tenant_id filter:** one HNSW index; queries filter by tenant. Cheap to maintain but the planner may skip the index when tenant_id is highly selective. Mitigation: partial HNSW indexes per tenant (`WHERE tenant_id = 'xxx'`) for hot tenants, or iterative index scans (pgvector 0.8+).
16. **pgvector 0.8.0 introduced iterative index scans**, which improve behavior when combining an HNSW scan with additional filters — the scan continues past the initial candidate set if the post-filter eliminates too many hits.
17. **Filter-vs-reorder tradeoff.** The classic mistake is `WHERE tenant_id = $1 ORDER BY embedding <=> $2 LIMIT 10` — the planner may run the vector scan first, return 10 rows, then discover none match `tenant_id`. Fix: use a partial index, or use pgvector 0.8's iterative scan, or use a CTE that pre-filters then reorders.
18. **synchronize: false for pgvector tables.** TypeORM's auto-sync does not understand `vector(n)` columns correctly — use migrations only.

## Security Concerns
- Operator-class mismatch between index build and query distance metric = HIGH (silent fallback to Seq Scan, latency spike).
- Shared-table multi-tenant vector search without tenant filter in the query = CRITICAL (cross-tenant semantic leak — an embedding from tenant A might be the nearest neighbor to tenant B's query).
- Embeddings derived from PII (customer messages, health records) stored without encryption = HIGH — embeddings are themselves reversible to ~original meaning by nearest-neighbor inversion attacks.
- `ANALYZE` not run after bulk load = HIGH (silent performance cliff, masks isolation audit signals).

## Performance Concerns
- HNSW build time on large tables with low `maintenance_work_mem` = HIGH (hours instead of minutes).
- HNSW `ef_search` too low = HIGH (low recall — wrong answers, looks like a correctness bug).
- HNSW `ef_search` too high = HIGH (p99 latency balloon under load).
- Missing ANALYZE after bulk load = HIGH (planner skips index, seq scan).
- Vacuum on large HNSW index = MEDIUM — use REINDEX CONCURRENTLY then VACUUM instead.
- Per-query `SET hnsw.ef_search` at session level under PgBouncer transaction pooling = CRITICAL (leaks to other tenants/queries). MUST use `SET LOCAL`.
- IVFFlat index built on empty or tiny table = HIGH (poor cluster centroids, permanent recall degradation until REINDEX).
- Shared-table vector search where planner picks Seq Scan due to LIMIT / selectivity = HIGH; diagnose with EXPLAIN.

## Architectural Implications for database-reviewer

- Every pgvector column declaration MUST specify dimension: `vector(1536)`. Unbounded = reject.
- Every pgvector index MUST declare operator class: `USING hnsw (embedding vector_cosine_ops)`. Omitted = reject.
- The application's query operator (`<=>`, `<->`, `<#>`) MUST match the index operator class. Mismatch = CRITICAL.
- `hnsw.ef_search` MUST be set with `SET LOCAL` inside the transaction, never session-level under PgBouncer.
- ANALYZE MUST run after bulk embedding loads; CI / migration scripts should include it.
- Multi-tenant vector search MUST document the isolation model (schema-per-tenant vs shared table). Shared table without per-tenant WHERE filter = CRITICAL.
- Embeddings of PII MUST be treated as PII — encryption at rest or schema-per-tenant isolation is required, not optional.
- TypeORM synchronize: false for all entities with vector columns.

## Domain Rule Additions for database-reviewer

Add to `## Domain Rules → Vector & Semantic Search (Critical)`:

- pgvector column MUST declare dimension (`vector(1536)` not `vector`). Unbounded = reject.
- pgvector HNSW / IVFFlat index MUST declare operator class matching the query distance metric (`vector_cosine_ops` for `<=>`, `vector_l2_ops` for `<->`, `vector_ip_ops` for `<#>`). Mismatch = CRITICAL (silent Seq Scan).
- Vector dimension > 2000 on an HNSW index = CRITICAL — pgvector rejects; flag in review before it reaches the DB.
- IVFFlat index built on an empty or small (<1000 rows) table = HIGH (permanent recall degradation until REINDEX).
- `ANALYZE` MUST be run after bulk embedding load. Missing = HIGH.
- `SET hnsw.ef_search` at session level under PgBouncer = CRITICAL. Use `SET LOCAL` inside transaction.
- Multi-tenant shared vector table without explicit tenant_id filter in every query = CRITICAL.
- Multi-tenant shared vector table should use either partial HNSW indexes per hot tenant, schema-per-tenant indexes, or pgvector 0.8+ iterative scans — document the choice.
- Embeddings derived from PII MUST be isolated per tenant or encrypted — nearest-neighbor inversion attack is a real threat.
- TypeORM `synchronize: true` on entities with `vector` columns = CRITICAL (schema corruption — TypeORM does not model vector types correctly).
- Vacuum on large HNSW indexes SHOULD be via `REINDEX INDEX CONCURRENTLY` then `VACUUM` — plain VACUUM is slow.
