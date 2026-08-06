/**
 * INVARIANT: auth-service tenant-module code that WRITES to an RLS-protected
 * `auth` table runs inside a bound tenant context.
 *
 * WHY (first-hand, prod 2026-08-06): tenant provisioning had been dead for
 * months. `TenantProvisioningCommandService.runWithReceipt` opens a
 * `SERIALIZABLE` transaction and `INSERT`s the command receipt into
 * `auth.tenant_command_receipts` — a table that carries `tenantId` and is
 * therefore covered by `tenant_isolation_policy` (auth's RLS exclusion list is
 * only `auth_outbox` / `users` / `tenants`). Nothing in that transaction ever
 * set `app.current_tenant`. The commands arrive over NATS, i.e. OUTSIDE the
 * HTTP request lifecycle, so there is no `TenantContextMiddleware` and no
 * pool-checkout GUC to inherit either: the RLS predicate
 * `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`
 * evaluated to UNKNOWN and the write was refused. All eight provisioning steps
 * therefore never started, which is how prod ended up with an ACTIVE tenant
 * that owns no `tenant_<uuid>` schema at all.
 *
 * Nothing in the build could see it. The two nearest guards are farm-specific
 * (`farm-read-boundary-ssot.spec.ts`,
 * `farm-event-handler-tenant-context-ssot.spec.ts`); auth had no equivalent, so
 * a write with no tenant context was as compilable as one with it. This spec is
 * the auth-side counterpart, at Tier 3 of the architectural hierarchy: the wrong
 * behaviour is now detectable at CI time.
 *
 * WHAT COUNTS AS A BOUND CONTEXT: the write must sit in a file that references
 * `withTenantContext` (the AsyncLocalStorage frame the pool checkout patch
 * reads), or one of the fail-closed boundaries that call it internally
 * (`runInTenantTransaction` / `runInTenantRead`), or the transaction-local
 * binder/asserter pair (`bindTenantRlsContext` /
 * `assertTenantTransactionContext`).
 *
 * A bare `set_config('app.current_tenant', …)` deliberately does NOT count. It
 * writes the GUC without ever reading it back and without forcing
 * `app.bypass_rls` off, so it cannot distinguish "context took effect" from
 * "connection resolved somewhere else" — exactly the silent failure mode
 * `assertTenantTransactionContext` was written to convert into a hard
 * `TenantContextError`. Auth already has one such bare call
 * (`tenant-provisioning-command.service.ts`, the suspend-time refresh-token
 * revoke): unverified, and it is in the same transaction whose receipt INSERT
 * was being RLS-refused.
 *
 * SCOPE: every non-spec `*.ts` under `apps/auth-service/src/modules/tenant/**`
 * that writes to an RLS-protected `auth` table, either by raw SQL
 * (`INSERT INTO` / `UPDATE` / `DELETE FROM auth.<table>`) or through TypeORM
 * (a `save`/`insert`/`update`/`delete`/… call in a file that binds an
 * RLS-protected entity via `@InjectRepository(E)`, `Repository<E>` or
 * `manager.save(E, …)`).
 *
 * NOT COVERED (stated so the guarantee is not read wider than it is): this is a
 * file-level check on DIRECT writes. A NATS entrypoint that establishes no
 * context and delegates the write to a service in another module is invisible
 * to it — `handlers/auth-admin-nats.handler.ts` only names its SQL in comments
 * and therefore does not register here. Auth-service writes outside
 * `modules/tenant` are not examined either. Closing both needs the write side
 * to route through `runInTenantTransaction`, at which point this ratchet
 * empties. Tracked as ORPHAN-MEDIUM-577.
 *
 * The RLS-protected table set is DERIVED, never hand-listed: every `auth`-schema
 * table that carries a `tenantId`/`tenant_id` column — read from the entity
 * decorators and from the raw `CREATE TABLE` migrations, because the incident
 * table (`tenant_command_receipts`) has no entity class at all — MINUS the
 * `AUTH_RLS_EXCLUDE_TABLES` SSoT imported from
 * `libs/backend-common/src/database/schema-manager.service.ts`. That mirrors
 * `applyTenantRlsToSchema`'s own discovery semantics (introspect
 * `information_schema.columns` for a tenant column, skip `excludeTables`), so
 * the invariant cannot drift from the policy that actually gets installed.
 *
 * RATCHET: `UNBOUND_WRITE_ALLOWLIST` records the files that violate this TODAY,
 * each with its reason. A NEW violator fails the build. Shrinking the list is
 * free; the second test keeps it honest by failing on an entry that no longer
 * exists, no longer writes to an RLS-protected table, or has since been fixed.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, normalize, join, sep } from 'node:path';

import { AUTH_RLS_EXCLUDE_TABLES } from '../../libs/backend-common/src/database/schema-manager.service';

const REPO_ROOT = resolve(__dirname, '..', '..');
const AUTH_SRC = resolve(REPO_ROOT, 'apps/auth-service/src');
const AUTH_MIGRATIONS = resolve(AUTH_SRC, 'migrations');
const TENANT_MODULE = resolve(AUTH_SRC, 'modules/tenant');

/**
 * Files under `modules/tenant` that write to an RLS-protected `auth` table
 * WITHOUT establishing a tenant context. Paths are POSIX-relative to
 * `apps/auth-service/src/modules/tenant`. Every entry names the tables it
 * touches and why it is still here — this is a debt ledger, not a permission.
 *
 * The whole list is one finding class (ORPHAN-MEDIUM-577): auth has never had a
 * write-side tenant boundary, so today NO file in the module establishes one.
 * The provisioning receipt path is being repaired on
 * `fix/tenant-provisioning-receipt-rls`; that branch must delete its entry here
 * as part of the fix, which is the ratchet doing its job.
 */
const UNBOUND_WRITE_ALLOWLIST = new Set<string>([
  // The incident itself: SERIALIZABLE receipt transaction INSERT/UPDATEs
  // `auth.tenant_command_receipts` and writes `tenant_modules` / `tenant_roles`
  // / `invitations` / `action_tokens` / `refresh_tokens` from NATS-delivered
  // lifecycle commands — no HTTP request context exists on that path.
  // Repair in flight on fix/tenant-provisioning-receipt-rls.
  'services/tenant-provisioning-command.service.ts',
  // Tenant RBAC writes (`tenant_roles`, `tenant_role_permissions`). Reached
  // from the GraphQL resolvers, so it inherits the request-scoped checkout GUC
  // today — necessary but unverified: nothing asserts the connection it ends up
  // on actually carries this tenant.
  'services/tenant-role.service.ts',
  // `user_role_assignments` + `mobile_user_settings` writes, same
  // request-scoped-only situation as tenant-role.service.ts.
  'services/tenant-user-management.service.ts',
  // `user_role_assignments`, `invitations`, `action_tokens`,
  // `mobile_user_settings` writes on the user lifecycle path, which is reached
  // BOTH from resolvers and from the provisioning command service above.
  'services/user-lifecycle.service.ts',
  // `user_module_assignments` / `user_site_assignments` writes via TypeORM
  // repositories on the tenant-admin path.
  'services/tenant-admin.service.ts',
  // `tenant_modules` writes via the TypeORM repository.
  'services/tenant.service.ts',
  // `mobile_user_settings` upsert via the TypeORM repository.
  'services/mobile-settings.service.ts',
  // Shared credential fence: set-based `refresh_tokens` revocation UPDATE. It
  // takes an `EntityManager` from its caller, so the context has to be
  // established by whoever opens the transaction — including the NATS-driven
  // provisioning/suspend paths above, which do not.
  'services/user-credential-revocation.ts',
]);

/**
 * Tokens that prove the file establishes a tenant routing/RLS context.
 * `withTenantContext` is the canonical AsyncLocalStorage frame;
 * `runInTenantTransaction` / `runInTenantRead` wrap it plus the fail-closed
 * assertion; `bindTenantRlsContext` / `assertTenantTransactionContext` are the
 * transaction-local binder + read-back asserter. Any ONE is sufficient.
 */
const CONTEXT_ESTABLISHING: readonly RegExp[] = [
  /\bwithTenantContext\b/,
  /\brunInTenantTransaction\b/,
  /\brunInTenantRead\b/,
  /\bbindTenantRlsContext\b/,
  /\bassertTenantTransactionContext\b/,
];

/** TypeORM repository/manager mutation calls. */
const ORM_WRITE_CALL =
  /\.(?:save|insert|upsert|update|delete|remove|softRemove|softDelete|recover|increment|decrement)\s*\(/;

/** Raw-SQL mutation against a schema-qualified `auth` table. */
const RAW_SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?auth"?\s*\.\s*"?([a-z0-9_]+)"?/gi;

/** Column names `applyTenantRlsToSchema` discovers a tenant-scoped table by. */
const TENANT_COLUMN = /\btenantId\b|\btenant_id\b/;

function findTsFiles(dir: string, filter: (name: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === '__tests__' ||
        entry.name === 'node_modules' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      files.push(...findTsFiles(fullPath, filter));
      continue;
    }
    if (entry.isFile() && filter(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Strip block + line comments so a docstring that NAMES a table, a write
 * statement, or `withTenantContext` cannot be mistaken for live code in either
 * direction. `tenant-user-count-reconcile.service.ts` documents a
 * `DELETE FROM auth.users` it never performs — without this it would be
 * misread as a write path.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

/** Body of the parenthesised group that starts at `openIndex`. */
function balancedParens(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return '';
}

interface AuthTable {
  readonly table: string;
  /** Entity class bound to the table, when the table has one. */
  readonly entityClass?: string;
  readonly tenantScoped: boolean;
}

/** `auth`-schema tables declared by an `@Entity()` decorator. */
function tablesFromEntities(): AuthTable[] {
  const tables: AuthTable[] = [];
  for (const file of findTsFiles(AUTH_SRC, (name) => name.endsWith('.entity.ts'))) {
    const src = readFileSync(file, 'utf-8');
    const decorator = src.match(/@Entity\(/);
    if (decorator?.index === undefined) continue;
    const args = balancedParens(src, decorator.index + '@Entity'.length);
    if (!/schema:\s*'auth'/.test(args)) continue;
    const table = args.match(/'([a-z0-9_]+)'/)?.[1] ?? args.match(/name:\s*'([a-z0-9_]+)'/)?.[1];
    if (!table) continue;
    const entityClass = src.slice(decorator.index).match(/export class (\w+)/)?.[1];
    tables.push({ table, entityClass, tenantScoped: TENANT_COLUMN.test(src) });
  }
  return tables;
}

/**
 * `auth`-schema tables created by raw SQL migrations. Required, not optional:
 * `tenant_command_receipts` — the table the outage happened on — is
 * migration-only and has no entity class, so an entity-derived table set would
 * have been blind to exactly the write that broke.
 */
function tablesFromMigrations(): AuthTable[] {
  const tables: AuthTable[] = [];
  for (const file of findTsFiles(AUTH_MIGRATIONS, (name) => name.endsWith('.ts'))) {
    const src = readFileSync(file, 'utf-8');
    const create =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?auth"?\s*\.\s*"?([a-z0-9_]+)"?\s*\(/gi;
    let match: RegExpExecArray | null;
    while ((match = create.exec(src)) !== null) {
      const table = match[1];
      if (table === undefined) continue;
      const body = balancedParens(src, match.index + match[0].length - 1);
      tables.push({ table, tenantScoped: TENANT_COLUMN.test(body) });
    }
  }
  return tables;
}

interface RlsSurface {
  /** Table names covered by `tenant_isolation_policy` in the `auth` schema. */
  readonly tables: ReadonlySet<string>;
  /** Entity class -> table, for the RLS-protected tables that have an entity. */
  readonly entityClasses: ReadonlyMap<string, string>;
}

function rlsProtectedSurface(): RlsSurface {
  const excluded = new Set<string>(AUTH_RLS_EXCLUDE_TABLES);
  const tables = new Set<string>();
  const entityClasses = new Map<string, string>();
  for (const candidate of [...tablesFromEntities(), ...tablesFromMigrations()]) {
    if (!candidate.tenantScoped || excluded.has(candidate.table)) continue;
    tables.add(candidate.table);
    if (candidate.entityClass) entityClasses.set(candidate.entityClass, candidate.table);
  }
  return { tables, entityClasses };
}

interface WriteSite {
  readonly relativePath: string;
  readonly code: string;
  readonly tables: readonly string[];
}

/** Tables an RLS-protected entity is bound to in this file, if any. */
function ormWrittenTables(code: string, surface: RlsSurface): string[] {
  if (!ORM_WRITE_CALL.test(code)) return [];
  const written: string[] = [];
  for (const [entityClass, table] of surface.entityClasses) {
    const bound = new RegExp(
      `@InjectRepository\\(\\s*${entityClass}\\s*\\)` +
        `|Repository<\\s*${entityClass}\\s*>` +
        `|\\.(?:save|insert|upsert|update|delete|remove|softRemove|softDelete)\\(\\s*${entityClass}\\b`,
    );
    if (bound.test(code)) written.push(table);
  }
  return written;
}

function rawWrittenTables(code: string, surface: RlsSurface): string[] {
  const written: string[] = [];
  for (const match of code.matchAll(RAW_SQL_WRITE)) {
    const table = match[1];
    if (table !== undefined && surface.tables.has(table)) written.push(table);
  }
  return written;
}

function tenantModuleWriteSites(surface: RlsSurface): WriteSite[] {
  return findTsFiles(
    TENANT_MODULE,
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'),
  )
    .map((file) => {
      const code = stripComments(readFileSync(file, 'utf-8'));
      return {
        relativePath: toPosix(normalize(relative(TENANT_MODULE, file))),
        code,
        tables: [
          ...new Set([...rawWrittenTables(code, surface), ...ormWrittenTables(code, surface)]),
        ].sort(),
      };
    })
    .filter(({ tables }) => tables.length > 0);
}

function establishesContext(code: string): boolean {
  return CONTEXT_ESTABLISHING.some((re) => re.test(code));
}

describe('INVARIANT: the RLS-protected auth table set is derived, not assumed', () => {
  it('derives the tenant-scoped auth tables from entities + migrations minus the exclusion SSoT', () => {
    const { tables } = rlsProtectedSurface();

    // Vacuity guard: an empty/near-empty derivation would make every test below
    // pass by finding nothing, which is how a silently-broken invariant looks.
    expect(tables.size).toBeGreaterThanOrEqual(10);

    // The outage table is migration-only (no entity class) — the derivation
    // MUST see it, or this whole spec would not have caught the original bug.
    expect(tables.has('tenant_command_receipts')).toBe(true);

    // The exclusion SSoT is honoured rather than re-declared here.
    for (const excluded of AUTH_RLS_EXCLUDE_TABLES) {
      expect(tables.has(excluded)).toBe(false);
    }
  });
});

describe('INVARIANT: auth tenant-module writes to RLS-protected tables run in a bound tenant context', () => {
  it('has no file writing an RLS-protected auth table without a tenant context (outside the ratchet)', () => {
    const surface = rlsProtectedSurface();
    const violations = tenantModuleWriteSites(surface)
      .filter(({ relativePath }) => !UNBOUND_WRITE_ALLOWLIST.has(relativePath))
      .filter(({ code }) => !establishesContext(code))
      .map(({ relativePath, tables }) => `${relativePath} (writes: ${tables.join(', ')})`);

    expect(violations).toEqual([]);
  });

  it('keeps the ratchet honest — every entry still exists and still writes unbound', () => {
    const surface = rlsProtectedSurface();
    const sites = new Map(tenantModuleWriteSites(surface).map((site) => [site.relativePath, site]));

    const stale: string[] = [];
    for (const relativePath of UNBOUND_WRITE_ALLOWLIST) {
      if (!existsSync(resolve(TENANT_MODULE, relativePath))) {
        stale.push(`${relativePath} (file no longer exists — remove from allowlist)`);
        continue;
      }
      const site = sites.get(relativePath);
      if (!site) {
        stale.push(
          `${relativePath} (no longer writes an RLS-protected auth table — remove from allowlist)`,
        );
        continue;
      }
      if (establishesContext(site.code)) {
        stale.push(`${relativePath} (now establishes a tenant context — remove from allowlist)`);
      }
    }

    expect(stale).toEqual([]);
  });
});
