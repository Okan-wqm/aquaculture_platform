/**
 * INVARIANT: a non-HTTP entry point that writes tenant data establishes tenant
 * context by one of the sanctioned mechanisms.
 *
 * # Why this exists
 *
 * Tenant provisioning was dead in production for months (ORPHAN-CRITICAL-573).
 * The mechanism was not a typo: the commands arrive over **NATS**, outside the
 * HTTP request lifecycle, so `TenantContextMiddleware` never runs, the
 * pool-checkout patch has no AsyncLocalStorage frame to read, and the RLS
 * predicate evaluates against an unset `app.current_tenant`. The write was
 * refused, all eight provisioning steps never started, and production ended up
 * with an ACTIVE tenant that owns no schema.
 *
 * `auth-tenant-context-ssot.spec.ts` closed that for auth's tenant module and
 * said plainly what it did not cover: entry points elsewhere, and entry points
 * that delegate. This spec is the platform-wide half — it looks at the entry
 * points themselves, which is where the context has to be established, and it
 * covers every service whose domain tables live in per-tenant schemas.
 *
 * # What counts as an entry point
 *
 * `@MessagePattern` / `@EventPattern` (NATS) and `@Cron` (scheduler). These are
 * exactly the three ways code runs in this platform with no HTTP request behind
 * it, and therefore the three ways a write can reach the database with no
 * tenant bound.
 *
 * # What counts as establishing context
 *
 * TWO mechanisms are sanctioned, and recognising only one would misjudge forty
 * files:
 *
 *   1. **AsyncLocalStorage + GUC** — `withTenantContext`, `runInTenantTransaction`,
 *      `runInTenantRead`, `bindTenantRlsContext`, `assertTenantTransactionContext`.
 *      The pool-checkout patch reads the frame and sets `app.current_tenant`.
 *   2. **Explicit tenant-schema iteration** — `listTenantSchemas`,
 *      `getTenantSchemaName`, `withTenantSchema`, `setTenantSearchPath`. A cron
 *      that has no single tenant to bind (a monthly accrual across every
 *      tenant, say) walks the schemas and routes each pass by `search_path`.
 *      `hr-service`'s leave accrual is the reference example.
 *
 * A file that shows neither, yet writes, is either working on a cross-tenant
 * table — in which case it belongs in the allowlist WITH THAT REASON — or it is
 * the provisioning bug again somewhere new.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Services whose domain tables OMIT `schema:` and therefore live in
 * `tenant_<uuid>` at runtime (CLAUDE.md's per-tenant list), plus auth: its
 * tenant lifecycle tables carry `tenantId` and are RLS-protected even though
 * the schema is fixed.
 */
const TENANT_SCOPED_SERVICES = [
  'auth-service',
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'ai-service',
  'alert-engine',
] as const;

const ENTRY_POINT = /@(MessagePattern|EventPattern|Cron)\s*\(/;
const ORM_WRITE = /\.(save|insert|update|delete|softDelete|softRemove|remove|upsert)\s*\(/;
const RAW_WRITE = /(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)/i;

const CONTEXT_MECHANISMS = [
  // 1. AsyncLocalStorage frame + transaction-local GUC
  /withTenantContext|runInTenantTransaction|runInTenantRead|bindTenantRlsContext|assertTenantTransactionContext/,
  // 2. explicit per-tenant schema routing
  /listTenantSchemas|withTenantSchema|setTenantSearchPath|getTenantSchemaName|forEachTenantSchema/,
];

/**
 * Entry points that write without either mechanism TODAY, each with the reason
 * it is not a defect — or, for the one that is, the finding tracking it.
 *
 * This list may shrink and may not grow. Every entry was read individually;
 * "it was already there" is not a reason.
 */
const UNBOUND_ENTRYPOINT_ALLOWLIST = new Map<string, string>([
  [
    'apps/auth-service/src/audit/audit-log.service.ts',
    "writes AuditLog, declared @Entity('audit_logs', { schema: 'auth' }) — a cross-tenant infrastructure ledger, one of the tables MODULE_SCHEMAS keeps out of per-tenant routing on purpose",
  ],
  [
    'apps/farm-service/src/feeding-protocol/services/feeding-job-run.service.ts',
    "writes FeedingJobRun, declared @Entity('feeding_job_runs', { schema: 'farm' }) and listed in farm's MODULE_SCHEMAS.infrastructureTables — the same cross-tenant class as the auth audit ledger above. Its raw INSERT is schema-qualified (farm.feeding_job_runs) and its rows are keyed by tenantId, so it is the claim ledger the hourly UTC tick consults BEFORE it has a tenant to bind; binding context here would route a cross-tenant table into tenant_<uuid> and break the uniqueness the claim depends on",
  ],
  [
    'apps/auth-service/src/modules/tenant/handlers/auth-admin-nats.handler.ts',
    'the NATS entry point itself performs no write: it delegates to TenantProvisioningCommandService, whose receipt transaction binds context via bindTenantRlsContext (ORPHAN-CRITICAL-573). It registers here only because it quotes SQL in comments',
  ],
  [
    'apps/auth-service/src/modules/tenant/services/tenant-user-count-reconcile.service.ts',
    "writes auth.tenants, which is on auth's RLS exclusion list (auth_outbox / users / tenants) — login has to resolve a tenant before any tenant is bound, so the table cannot be RLS-scoped",
  ],
  [
    'apps/messaging-service/src/message/services/idempotency-ledger-gc.service.ts',
    'deletes from messaging.message_send_idempotency — schema-qualified, and idempotency ledgers are cross-tenant infrastructure per the ADR-011 split',
  ],
  [
    'apps/messaging-service/src/event-handlers/messaging-admin-nats.handler.ts',
    'admin-plane commands operating on messaging.* cross-tenant tables; the per-tenant path is messaging-nats.handler.ts, which does route by schema',
  ],
]);

function walkTs(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTs(full, acc);
    } else if (entry.endsWith('.ts') && !entry.includes('.spec.')) {
      acc.push(full);
    }
  }
  return acc;
}

interface EntryPointFile {
  readonly path: string;
  readonly bound: boolean;
}

function writingEntryPoints(): EntryPointFile[] {
  const found: EntryPointFile[] = [];
  for (const service of TENANT_SCOPED_SERVICES) {
    for (const file of walkTs(join(REPO_ROOT, 'apps', service, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (!ENTRY_POINT.test(text)) continue;
      if (!ORM_WRITE.test(text) && !RAW_WRITE.test(text)) continue;
      found.push({
        path: relative(REPO_ROOT, file).split(sep).join('/'),
        bound: CONTEXT_MECHANISMS.some((mechanism) => mechanism.test(text)),
      });
    }
  }
  return found;
}

describe('non-HTTP entry points bind tenant context before writing', () => {
  it('finds the entry points at all — a scan that matches nothing proves nothing', () => {
    const found = writingEntryPoints();

    // If a refactor moved every handler out of these paths, the assertion below
    // would pass vacuously. This is the guard against a green that means the
    // scanner broke.
    expect(found.length).toBeGreaterThan(10);
    expect(found.some((f) => f.bound)).toBe(true);
  });

  it('leaves no writing entry point without a context mechanism or a stated reason', () => {
    const unexplained = writingEntryPoints()
      .filter((f) => !f.bound)
      .filter((f) => !UNBOUND_ENTRYPOINT_ALLOWLIST.has(f.path))
      .map((f) => f.path);

    // A new NATS handler or cron that writes tenant data and binds nothing is
    // the provisioning outage happening somewhere else. Either establish
    // context, or add the file here with the reason it does not need to.
    expect(unexplained).toEqual([]);
  });

  it('keeps the allowlist honest — an entry that gained a mechanism must leave', () => {
    // Otherwise a fixed file keeps its exemption and the list stops shrinking,
    // which is how an allowlist turns into a rubber stamp.
    const bound = new Set(
      writingEntryPoints()
        .filter((f) => f.bound)
        .map((f) => f.path),
    );
    const stale = [...UNBOUND_ENTRYPOINT_ALLOWLIST.keys()].filter((p) => bound.has(p));

    expect(stale).toEqual([]);
  });

  it('keeps every allowlist entry pointing at a file that still exists', () => {
    const present = new Set(writingEntryPoints().map((f) => f.path));
    const vanished = [...UNBOUND_ENTRYPOINT_ALLOWLIST.keys()].filter((p) => !present.has(p));

    expect(vanished).toEqual([]);
  });

  it('records a reason for every exemption, not a bare path', () => {
    const empty = [...UNBOUND_ENTRYPOINT_ALLOWLIST.entries()]
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([path]) => path);

    expect(empty).toEqual([]);
  });
});
