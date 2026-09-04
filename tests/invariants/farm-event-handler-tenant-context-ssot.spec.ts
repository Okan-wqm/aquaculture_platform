/**
 * INVARIANT: every farm-service NATS event handler that touches the database
 * establishes a tenant context before its body runs.
 *
 * WHY: a NATS event handler (implements `IEventHandler` and registers via
 * `eventBus.subscribeWildcard(...)` / `eventBus.subscribe(...)`) runs OUTSIDE the
 * HTTP request lifecycle. There is no `TenantContextMiddleware`, no
 * AsyncLocalStorage request context, and no per-request `SET search_path`. So a
 * raw `@InjectRepository` / `dataSource` / `queryRunner.manager` call inside the
 * handler resolves against the pool-checkout default search_path — the SOURCE
 * `farm` schema — instead of `tenant_<uuid>`, OR it RLS-denies to an empty
 * result. Either way the write/read silently lands in the wrong place, which is
 * the platform's "data appears then disappears / cross-tenant corruption"
 * failure mode.
 *
 * The fix is to wrap all DB work in `withTenantContext(event.tenantId, ...)`
 * (from `@aquaculture/backend-common/context`), or in `runInTenantTransaction` /
 * `runInTenantRead` (which call `withTenantContext` internally), or — for a
 * handler that owns a dedicated QueryRunner — to pin `SET search_path TO
 * "tenant_<uuid>", ..."` on that runner. FARM-CRITICAL-060 (onboarding seeders)
 * and FARM-HIGH-067 (erasure handler) already fixed two; this invariant fails
 * the build if a NEW NATS event handler reintroduces unscoped DB access.
 *
 * Scope: a NATS event handler is a `*.ts` file under `apps/farm-service/src`
 * that BOTH (a) implements `IEventHandler` (or carries an inline
 * `IEventHandler<...>` handler shape) AND (b) registers on the NATS event bus
 * via `subscribeWildcard(` / `subscribe(`. That deliberately EXCLUDES in-process
 * NestJS `@OnEvent` (EventEmitter2) listeners — those can run inside the HTTP
 * request context and are a separate concern gated by farm-service's
 * `dead-onevent-listener.invariant.spec.ts`.
 *
 * "DB access" = the file references a repository/dataSource/queryRunner/manager
 * primitive OR injects a `*Service`/`*Seeder` collaborator that performs the
 * tenant-scoped write (delegation). The two pure-delegation handlers
 * (onboarding, erasure) carry no repository token themselves but call services
 * that do, so they are evaluated by their `withTenantContext` wrapping too.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, normalize, join, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = resolve(REPO_ROOT, 'apps/farm-service/src');

/**
 * NATS event handlers that are LEGITIMATELY context-free (pure ack / no DB
 * access at all). Keep this SMALL — every entry is justified inline. Paths are
 * POSIX-relative to apps/farm-service/src. Currently EMPTY.
 */
const CONTEXT_FREE_ALLOWLIST = new Set<string>([
  // (intentionally empty — see docstring)
]);

/**
 * Handlers whose ONLY DB target is a CROSS-TENANT source-schema ledger,
 * addressed with an explicit `farm.<table>` qualification.
 *
 * There the tenant is a COLUMN, not a schema: `withTenantContext` would pin a
 * search_path the statement never consults — a misleading wrapper, not a
 * safety control. What DOES protect those rows is the tenantId discriminator,
 * so an entry here must (a) qualify every statement with `farm.`, (b) inject
 * no repository token (which would route through search_path), and (c) fail
 * closed on an invalid/absent `event.tenantId`. The staleness test below
 * enforces all three — this is a narrow structural exemption, not a waiver.
 */
const CROSS_TENANT_LEDGER_ALLOWLIST = new Set<string>([
  // W5 tenant-localization projection: the single write is
  // `INSERT INTO farm.tenant_localization ... ON CONFLICT ("tenantId")`, a
  // cross-tenant infrastructure ledger (MODULE_SCHEMAS['farm']
  // .infrastructureTables) that is never cloned into tenant schemas.
  'feeding-protocol/listeners/tenant-localization-projection.listener.ts',
]);

/**
 * Tokens that prove the handler establishes a tenant routing context before its
 * DB work. `withTenantContext` is the canonical helper; `runInTenantTransaction`
 * / `runInTenantRead` wrap it internally; an explicit `SET search_path TO
 * "tenant_...` on a dedicated QueryRunner is the documented alternative for a
 * handler that owns its runner (AutoRuleTriggerService). Any ONE is sufficient.
 */
const CONTEXT_ESTABLISHING = [
  /\bwithTenantContext\b/,
  /\brunInTenantTransaction\b/,
  /\brunInTenantRead\b/,
  // Explicit per-runner pin: `SET search_path TO "<schema>", ...` where the
  // schema is derived from the tenant (getTenantSchemaName / `tenant_`). The
  // pattern is the literal SQL the QueryRunner executes.
  /SET search_path TO\s+["'`]\$\{?\s*schemaName/i,
  /SET search_path TO\s+["'`]?\$\{schema/i,
];

/**
 * Primitives that indicate the handler performs DB access directly (a repository
 * token, a TypeORM DataSource/QueryRunner, or an EntityManager).
 */
const DIRECT_DB_ACCESS = [
  /@InjectRepository\b/,
  /\bRepository</,
  /\bDataSource\b/,
  /\bQueryRunner\b/,
  /\bqueryRunner\b/,
  /\.manager\b/,
];

/**
 * Collaborators a pure-delegation handler injects that DO the tenant-scoped DB
 * write on its behalf (so the handler must still establish the context around
 * the delegated call). A handler that injects one of these and performs no
 * direct DB access is still in scope.
 */
const DELEGATED_DB_ACCESS = [/\b\w+(Service|Seeder)\b/];

function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      files.push(...findTsFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Strip block + line comments so a docstring that NAMES `withTenantContext`,
 * `IEventHandler`, or `subscribeWildcard` (e.g. an explanatory note) is not
 * mistaken for live code in either direction.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

interface EventHandlerFile {
  readonly relativePath: string;
  readonly code: string;
}

/**
 * A NATS event handler: implements `IEventHandler` (or carries an inline
 * `IEventHandler<...>` shape) AND registers on the NATS event bus. The bus
 * registration is what distinguishes it from an in-process `@OnEvent` listener.
 */
function isNatsEventHandler(code: string): boolean {
  const isHandler = /\bimplements\s+[^{]*\bIEventHandler\b/.test(code) || /\bIEventHandler</.test(code);
  const subscribesOnBus = /\.subscribeWildcard\s*\(/.test(code) || /\.subscribe\s*\(/.test(code);
  return isHandler && subscribesOnBus;
}

function natsEventHandlers(): EventHandlerFile[] {
  return findTsFiles(FARM_SRC)
    .map((file) => ({
      relativePath: toPosix(normalize(relative(FARM_SRC, file))),
      code: stripComments(readFileSync(file, 'utf-8')),
    }))
    .filter(({ code }) => isNatsEventHandler(code));
}

function hasDbAccess(code: string): boolean {
  return (
    DIRECT_DB_ACCESS.some((re) => re.test(code)) ||
    DELEGATED_DB_ACCESS.some((re) => re.test(code))
  );
}

function establishesContext(code: string): boolean {
  return CONTEXT_ESTABLISHING.some((re) => re.test(code));
}

describe('INVARIANT: farm NATS event handlers establish a tenant context before DB access', () => {
  it('every DB-touching NATS event handler references withTenantContext (or runInTenant*/explicit search_path pin)', () => {
    const violations = natsEventHandlers()
      .filter(({ relativePath }) => !CONTEXT_FREE_ALLOWLIST.has(relativePath))
      .filter(({ relativePath }) => !CROSS_TENANT_LEDGER_ALLOWLIST.has(relativePath))
      .filter(({ code }) => hasDbAccess(code))
      .filter(({ code }) => !establishesContext(code))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });

  it('keeps the context-free allowlist honest — every entry still exists and is still a context-free NATS event handler', () => {
    const stale: string[] = [];
    for (const relativePath of CONTEXT_FREE_ALLOWLIST) {
      const absolute = resolve(FARM_SRC, relativePath);
      if (!existsSync(absolute)) {
        stale.push(`${relativePath} (file no longer exists)`);
        continue;
      }
      const code = stripComments(readFileSync(absolute, 'utf-8'));
      if (!isNatsEventHandler(code)) {
        stale.push(`${relativePath} (no longer a NATS event handler)`);
        continue;
      }
      if (hasDbAccess(code)) {
        stale.push(
          `${relativePath} (now performs DB access — it must establish a tenant context; remove from allowlist)`,
        );
      }
    }

    expect(stale).toEqual([]);
  });

  it('keeps the cross-tenant-ledger allowlist honest — schema-qualified, repository-free, tenantId fail-closed', () => {
    const stale: string[] = [];
    for (const relativePath of CROSS_TENANT_LEDGER_ALLOWLIST) {
      const absolute = resolve(FARM_SRC, relativePath);
      if (!existsSync(absolute)) {
        stale.push(`${relativePath} (file no longer exists)`);
        continue;
      }
      const raw = readFileSync(absolute, 'utf-8');
      const code = stripComments(raw);
      if (!isNatsEventHandler(code)) {
        stale.push(`${relativePath} (no longer a NATS event handler)`);
        continue;
      }
      // (a) every statement qualified into the source schema.
      if (!/\bfarm\.[a-z_]+/.test(code)) {
        stale.push(`${relativePath} (no farm.<table> qualification — it now depends on search_path)`);
      }
      // (b) no repository token (repositories route through search_path).
      if (/@InjectRepository\b/.test(code)) {
        stale.push(`${relativePath} (injects a repository — must establish a tenant context)`);
      }
      // (c) fail-closed tenant identity.
      if (!/isValidUUID\(\s*event\.tenantId\s*\)/.test(code)) {
        stale.push(`${relativePath} (does not validate event.tenantId — cross-tenant row corruption vector)`);
      }
    }

    expect(stale).toEqual([]);
  });
});
