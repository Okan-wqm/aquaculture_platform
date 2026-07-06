/**
 * Platform-wide invariant — DEFECT-2 / ADR-011 schema-declaration discipline:
 *
 * Per-service entity declaration policy (CLAUDE.md "@Entity() schema discipline"):
 *
 *   - **Platform-level services** (`auth`, `billing`, `admin-api`, `notification`,
 *     `event-store`, `observability`, `config`, `gateway`) — EVERY `@Entity()`
 *     in `apps/**\/*.entity.ts` MUST declare `schema:` explicitly.
 *
 *   - **Tenant-scoped services** (`farm`, `sensor`, `hr`, `messaging`,
 *     `hydroponics`, `ai`, `alert`) — per-tenant entities OMIT `schema:` so
 *     that search_path tenant routing places them in `tenant_<uuid>` clones
 *     at runtime via `TenantSchemaSyncService`. Cross-tenant entities within
 *     the same service (outbox, audit_logs) MUST declare `schema:` explicitly.
 *
 * # CLASSIFICATION HEURISTIC
 *
 * An entity inside a tenant-scoped service is **per-tenant** if its body
 * contains a `tenantId` (or `tenant_id`) column declaration. Cross-tenant
 * tables (outbox, audit_logs, retention triggers) typically carry tenantId
 * as well — they are distinguished via the explicit allowlist below.
 *
 * # WHY THE FLIP
 *
 * The previous version of this spec required `schema:` on EVERY @Entity().
 * That was incorrect for tenant-scoped services: when an entity declares
 * `schema: 'farm'`, TypeORM hard-codes the schema name into every query,
 * defeating search_path tenant routing. The drift validator then sees
 * `expected='farm'` vs `actual='tenant_<uuid>'` and reports false drift.
 *
 * Faz 1.6 of the day-one baseline reset corrects the spec to match the
 * actual architectural rule from CLAUDE.md.
 *
 * # ALLOWED SHAPES
 *
 *   1. `@Entity()` — abstract base / inheritance helper (no table).
 *   2. `@Entity('table')` — per-tenant entity in tenant-scoped service.
 *   3. `@Entity('table', { schema: 'svc' })` — cross-tenant entity (explicit).
 *   4. `@Entity({ name: 'table' })` — single-object form, per-tenant.
 *   5. `@Entity({ name: 'table', schema: 'svc' })` — single-object form, cross-tenant.
 *
 * # CROSS-TENANT ALLOWLIST (per tenant-scoped service)
 *
 * These entity files DECLARE `schema:` even though they live in a
 * tenant-scoped service, because the underlying tables are cross-tenant
 * within that service (one row applies to all tenants OR rows are tenant-
 * scoped via tenantId column but the table itself is not cloned per
 * tenant — outbox is the canonical example):
 *
 *   - `*-outbox.entity.ts` — service event outbox (cross-tenant pub/sub)
 *   - `*-audit-log.entity.ts` / `*audit-log.entity.ts` — service audit trail
 *   - `*audit*.entity.ts` (broader audit pattern)
 *   - `*retention*.entity.ts` — retention policy bookkeeping
 *   - `*compliance*.entity.ts` — compliance state (legal-hold, etc.)
 *   - `tenant-erasure-audit.entity.ts` — GDPR cascade audit
 *
 * Adding a new cross-tenant entity to a tenant-scoped service requires
 * editing the `CROSS_TENANT_FILENAME_PATTERNS` list below + CODEOWNERS
 * review by database-reviewer.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Tenant-scoped services — per-tenant entities OMIT `schema:`.
 * Mirror of PER_TENANT_SCHEMA_SERVICES in tests/invariants/_constants.ts
 * but inlined here to avoid a cross-spec import chain.
 */
const TENANT_SCOPED_SERVICE_DIRS = new Set<string>([
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'alert-engine',
  'ai-service',
]);

/**
 * Service directory → expected schema name (used when DECLARE is required).
 * Tenant-scoped services use these for their cross-tenant entities.
 * Platform-level services use these for all their entities.
 */
const SERVICE_SCHEMA_MAP: Record<string, string> = {
  'farm-service': 'farm',
  'sensor-service': 'sensor',
  'hr-service': 'hr',
  'messaging-service': 'messaging',
  'hydroponics-service': 'hydroponics',
  'alert-engine': 'alert',
  'ai-service': 'ai',
  'auth-service': 'auth',
  'billing-service': 'billing',
  'admin-api-service': 'admin',
  'notification-service': 'notification',
  'event-store-service': 'event_store',
  'observability-service': 'observability',
  'config-service': 'config',
};

/**
 * Platform services may intentionally declare read/write entities outside
 * their primary schema only when another invariant owns that contract. Today
 * admin-api is the only service with this shape: it owns admin writes, may
 * write auth/shared operational rows, and may read other schemas only through
 * `synchronize: false` read models (covered by admin-api-schema-boundaries).
 */
const ADMIN_API_WRITE_ALLOWED_SCHEMAS = new Set(['admin', 'auth', 'shared']);

/**
 * Filename glob patterns that mark an entity as cross-tenant within a
 * tenant-scoped service. Match is done against the basename (no path).
 */
const CROSS_TENANT_FILENAME_PATTERNS: readonly RegExp[] = [
  /-outbox\.entity\.ts$/i,
  /outbox-.*\.entity\.ts$/i,
  /-audit-log\.entity\.ts$/i,
  /audit-log\.entity\.ts$/i,
  /-audit\.entity\.ts$/i,
  /audit\.entity\.ts$/i,
  /retention.*\.entity\.ts$/i,
  /-compliance\.entity\.ts$/i,
  /compliance.*\.entity\.ts$/i,
  /-legal-hold\.entity\.ts$/i,
  /legal-hold\.entity\.ts$/i,
  /tenant-erasure-audit\.entity\.ts$/i,
  /tool-execution-audit\.entity\.ts$/i,
  /stripe-webhook-event\.entity\.ts$/i,
  /audit-entry\.entity\.ts$/i,
  /embeddings-metadata\.entity\.ts$/i,
  // Send-idempotency ledger (DATA-HIGH-007): cross-tenant unique anchor.
  /message-send-idempotency\.entity\.ts$/i,
  // SENSOR-MEDIUM-009: global VFD vendor reference data (Danfoss/ABB register
  // addresses) — one cross-tenant table pinned to `sensor`, no per-tenant clone.
  /vfd-register-mapping\.entity\.ts$/i,
];

const TENANT_OWNED_FILENAME_OVERRIDES = new Set<string>([
  'apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts',
  'apps/messaging-service/src/compliance/entities/legal-hold.entity.ts',
  'apps/messaging-service/src/compliance/entities/retention-policy.entity.ts',
  'apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts',
]);

interface Violation {
  file: string;
  reason: string;
  line: number;
  excerpt: string;
}

function listEntityFiles(): string[] {
  let out: string;
  try {
    out = execSync(
      `git -C ${REPO_ROOT} grep -lE '@Entity\\(' -- 'apps/*/src/**/*.entity.ts'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return [];
    throw err;
  }
  return out.split('\n').filter(Boolean);
}

function getServiceFromPath(relativePath: string): string | null {
  const m = /^apps\/([^/]+)\//.exec(relativePath);
  return m?.[1] ?? null;
}

function isCrossTenantFilename(relativePath: string): boolean {
  if (TENANT_OWNED_FILENAME_OVERRIDES.has(relativePath)) return false;
  const base = basename(relativePath);
  return CROSS_TENANT_FILENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * Walk every @Entity( call site in the source and report (start, end, args).
 * Uses brace-matching so multi-line decorator args are captured correctly.
 */
function findEntityCalls(
  src: string,
): Array<{ start: number; end: number; args: string }> {
  const calls: Array<{ start: number; end: number; args: string }> = [];
  const callRe = /(^|[^A-Za-z_])@Entity\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(src)) !== null) {
    const openParen = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParen + 1;
    let inString: '"' | "'" | '`' | null = null;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
      } else {
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch as '"' | "'" | '`';
        } else if (ch === '(' || ch === '{' || ch === '[') {
          depth++;
        } else if (ch === ')' || ch === '}' || ch === ']') {
          depth--;
        }
      }
      if (depth === 0) break;
      i++;
    }
    calls.push({
      start: openParen,
      end: i,
      args: src.slice(openParen + 1, i).trim(),
    });
  }
  return calls;
}

function lineNumberAt(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

describe('INVARIANT — entity-schema-declaration (ADR-011)', () => {
  const files = listEntityFiles();

  it('repository contains entity files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every @Entity() respects the per-tenant OMIT / cross-tenant DECLARE rule', () => {
    const violations: Violation[] = [];

    for (const relativePath of files) {
      const service = getServiceFromPath(relativePath);
      if (!service) continue;

      const isTenantScopedService = TENANT_SCOPED_SERVICE_DIRS.has(service);
      const expectedSchema = SERVICE_SCHEMA_MAP[service];
      if (!expectedSchema) continue; // service not in the SSoT map

      const fullPath = resolve(REPO_ROOT, relativePath);
      const src = readFileSync(fullPath, 'utf8');

      const isCrossTenantFile = isCrossTenantFilename(relativePath);

      // Whether THIS entity should DECLARE schema:
      //   - Platform-level service → always DECLARE
      //   - Tenant-scoped service + filename matches cross-tenant pattern → DECLARE
      //   - Tenant-scoped service + per-tenant filename → OMIT
      const shouldDeclareSchema = !isTenantScopedService || isCrossTenantFile;

      for (const call of findEntityCalls(src)) {
        const args = call.args;

        // Parameterless @Entity() is the abstract-base form — always allowed.
        if (args === '') continue;

        const hasSchema = /\bschema\s*:/.test(args);
        const schemaMatch = args.match(
          /\bschema\s*:\s*['"]([a-z_][a-z0-9_]*)['"]/i,
        );
        const declaredSchema = schemaMatch?.[1] ?? null;

        if (shouldDeclareSchema && !hasSchema) {
          violations.push({
            file: relativePath,
            reason: isCrossTenantFile
              ? `cross-tenant entity in tenant-scoped service '${service}' MUST declare schema: '${expectedSchema}'`
              : `platform-level service '${service}' MUST declare schema: '${expectedSchema}'`,
            line: lineNumberAt(src, call.start),
            excerpt: args.slice(0, 100),
          });
          continue;
        }

        if (!shouldDeclareSchema && hasSchema) {
          violations.push({
            file: relativePath,
            reason: `per-tenant entity in tenant-scoped service '${service}' MUST OMIT schema: (search_path tenant routing handles placement)`,
            line: lineNumberAt(src, call.start),
            excerpt: args.slice(0, 100),
          });
          continue;
        }

        if (shouldDeclareSchema && declaredSchema !== null) {
          const adminApiAllowed =
            service === 'admin-api-service' &&
            (ADMIN_API_WRITE_ALLOWED_SCHEMAS.has(declaredSchema) ||
              /\bsynchronize\s*:\s*false\b/.test(args));
          if (adminApiAllowed) continue;
        }

        if (
          shouldDeclareSchema &&
          declaredSchema !== null &&
          declaredSchema !== expectedSchema
        ) {
          violations.push({
            file: relativePath,
            reason: `service '${service}' entity declares schema: '${declaredSchema}' but service-schema-map expects '${expectedSchema}'`,
            line: lineNumberAt(src, call.start),
            excerpt: args.slice(0, 100),
          });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map(
          (v) =>
            `  - ${v.file}:${v.line}\n      ${v.reason}\n      @Entity(${v.excerpt}${v.excerpt.length === 100 ? '…' : ''})`,
        )
        .join('\n');
      throw new Error(
        `entity-schema-declaration invariant VIOLATED — ${violations.length} entity declaration(s) wrong:\n${detail}\n\n` +
          `Rules:\n` +
          `  - Platform-level services (auth, billing, admin-api, notification, event-store, observability, config):\n` +
          `      every @Entity() MUST declare schema: '<svc-schema>'.\n` +
          `  - Tenant-scoped services (farm, sensor, hr, messaging, hydroponics, ai, alert):\n` +
          `      per-tenant entities OMIT schema: (search_path routes to tenant_<uuid>),\n` +
          `      cross-tenant entities (outbox/audit/retention/compliance) DECLARE schema: '<svc-schema>'.\n` +
          `  - Cross-tenant filename patterns: see CROSS_TENANT_FILENAME_PATTERNS in this spec.\n`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
