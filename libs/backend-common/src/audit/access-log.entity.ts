import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * AccessLogEntity — low-level HTTP access log row (AUDITTRAIL-HIGH-004).
 *
 * # Why this is distinct from AuditLogEntity
 *
 * The platform deliberately exposes TWO distinct audit streams:
 *
 *   - **Semantic-action stream** (`shared.audit_logs`, AuditLogEntity).
 *     One row per business action (`CREATE_FARM`, `IMPERSONATION_START`).
 *     Forensic horizon: 7 years per SOC 2 CC4. Carries the
 *     22-column mandatory shape (actorHomeTenantId, method, result,
 *     preStateHash/postStateHash, etc.).
 *
 *   - **Low-level HTTP access stream** (`shared.access_logs`, this
 *     entity). One row per HTTP/GraphQL request. Forensic horizon:
 *     90 days. Carries method/path/status/duration_ms/userId/tenantId/
 *     requestId/ip — the request-level forensic primitives needed for
 *     non-mutation read traceability (PII field reads, GDPR data
 *     exports, admin dashboard query forensics).
 *
 * # Why one-row-per-request and not one-row-per-mutation
 *
 * The audit-trail-completeness-auditor agent's invariant is explicit:
 *
 *     "every HTTP request emits low-level access log to access_logs
 *      (separate stream, lower retention, includes
 *      method+path+status). Distinct from audit_logs which is
 *      semantic-action level."
 *
 * Without the low-level stream, request-level forensics for
 * non-mutation reads (PII field reads via background jobs, admin
 * dashboard queries, GDPR data exports) is unavailable. The
 * semantic-action stream cannot fill the gap because non-mutation
 * reads do not carry an `@AuditedOperation()` decorator.
 *
 * # Schema placement (`shared` schema)
 *
 * `shared.access_logs` is one of the cross-tenant tables admitted by
 * ADR-011's SHARED_SCHEMA_TABLES list. Adding a 5th shared table is
 * normally an ADR-required architectural decision per W5 BLOCKER-15.
 * The table is added here under the explicit AUDITTRAIL-HIGH-004
 * cure mandate; the SHARED_SCHEMA_TABLES invariant is updated in the
 * companion change.
 *
 * # Why not a per-tenant table
 *
 * Access logs SURVIVE tenant deletion — operators must retain access
 * patterns for forensic / compliance investigation even after a
 * tenant offboards. Same rationale as `shared.audit_logs`. Tenant
 * isolation is enforced via the `tenantId` column + composite
 * index.
 *
 * # Why varchar(2048) on `path`
 *
 * GraphQL requests POST to a single path but expose query/operation
 * via the body — for those rows we capture the operationName as the
 * path discriminator. REST URL path lengths cap at common 2KB
 * implementation limits. 2048 covers both without introducing TEXT
 * (which is 1MB by default in Postgres and pollutes index size).
 *
 * # Indexes (CONCURRENTLY-built in the migration)
 *
 *   - (tenantId, createdAt DESC) — per-tenant request timeline
 *   - (userId, createdAt DESC) — per-user request timeline
 *   - (path, createdAt DESC) — endpoint-volume / abuse detection
 *   - (status, createdAt DESC) — error-spike detection
 */
@Entity('access_logs', { schema: 'shared' })
@Index('IDX_access_log_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_access_log_user_created', ['userId', 'createdAt'])
@Index('IDX_access_log_path_created', ['path', 'createdAt'])
@Index('IDX_access_log_status_created', ['status', 'createdAt'])
export class AccessLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * HTTP method — GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS.
   * Stored as varchar(8) (longest is OPTIONS, 7 chars). NOT NULL —
   * every request has a method.
   */
  @Column({ type: 'varchar', length: 8 })
  method!: string;

  /**
   * Request path / GraphQL operation name. See class docstring for
   * the 2048-char rationale.
   */
  @Column({ type: 'varchar', length: 2048 })
  path!: string;

  /**
   * HTTP status code, 100-599 range. NOT NULL — middleware emits
   * after response is sent so status is always known.
   */
  @Column({ type: 'integer' })
  status!: number;

  /**
   * Wall-clock duration of the request in milliseconds. Computed by
   * middleware as `Date.now() - requestStartTimestamp`. Useful for
   * P95/P99 latency forensics joined against semantic events.
   */
  @Column({ type: 'integer' })
  durationMs!: number;

  /**
   * Authenticated user ID (JWT sub claim). Null for anonymous /
   * pre-auth requests.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userId!: string | null;

  /**
   * Authenticated tenant ID (JWT tenantId claim). Null for
   * cross-tenant admin paths or anonymous requests.
   *
   * # Type: uuid (matches AuditLogEntity.tenantId)
   *
   * Same canonical-uuid rationale as AuditLogEntity.tenantId — every
   * tenant-scoped entity uses uuid; varchar drift breaks RLS
   * `current_setting('app.current_tenant')::uuid` casts.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /**
   * Request correlation ID. Same `x-correlation-id` value carried by
   * AuditLogEntity.correlationId — the bridging key for joining
   * semantic-action and access-log streams in forensic queries.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId!: string | null;

  /**
   * Client IP (inet). Routed through the same region-gated
   * `hashIpForGdpr` helper as audit_logs.ip when the JWT residency
   * claim says EU — same SSoT for GDPR Art 6 / Art 32 compliance.
   * See `libs/backend-common/src/audit/ip-hash.util.ts`.
   */
  @Column({ type: 'inet', nullable: true })
  ip!: string | null;

  /**
   * User-Agent header value. 500-char cap matches AuditLogEntity.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  /**
   * Request timestamp (immutable). Same @CreateDateColumn convention
   * as AuditLogEntity.createdAt — uses Postgres NOW() at INSERT.
   */
  @CreateDateColumn()
  createdAt!: Date;
}
