import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ROLE_AUTHORITY = 'libs/event-contracts/src/roles.ts';
const PERMISSION_AUTHORITY = 'libs/event-contracts/src/tenant-permissions.ts';
const GENERATOR = 'tools/codegen/admin-contracts/generate.ts';
const SERVER_AUTHORITY =
  'apps/admin-api-service/src/bootstrap/generated/admin-request-contracts.generated.ts';
const BROWSER_AUTHORITY =
  'web/modules/admin-panel/src/services/types/generated/admin-route-contracts.ts';
const GUARD = 'apps/admin-api-service/src/guards/platform-admin.guard.ts';
const PAGE_AUTHORITY = 'web/shared-ui/src/authz/admin-routes.ts';
const PANEL_MODULE = 'web/modules/admin-panel/src/Module.tsx';
const SHELL_LAYOUT = 'web/shell/src/layouts/MainLayout.tsx';

function readRepo(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = resolve(directory, entry);
    if (statSync(absolute).isDirectory()) return sourceFilesBelow(absolute);
    return /\.(?:ts|tsx)$/u.test(entry) ? [absolute] : [];
  });
}

describe('admin role → permission → route authorization graph', () => {
  it('compiles canonical identity into both runtime catalogs', () => {
    const generator = readRepo(GENERATOR);
    const server = readRepo(SERVER_AUTHORITY);
    const browser = readRepo(BROWSER_AUTHORITY);

    expect(generator).toContain('event-contracts/src/roles');
    expect(generator).toContain('event-contracts/src/tenant-permissions');
    expect(generator).toContain('createAdminRouteAuthorizationV1');
    expect(generator).toContain('ADMIN_SERVER_ROUTE_AUTHORIZATION');
    expect(server).toContain('export const ADMIN_SERVER_ROUTE_AUTHORIZATION');
    expect(server).toContain('createAdminRouteAuthorizationV1');
    expect(browser).toContain('createAdminRouteAuthorizationV1');
    expect(readRepo(ROLE_AUTHORITY)).toContain('PLATFORM_ROLE_CODES');
    expect(readRepo(PERMISSION_AUTHORITY)).toContain('TENANT_PERMISSION_CODES');
  });

  it('makes the runtime guard consume the generated catalog without metadata fallback', () => {
    const guard = readRepo(GUARD);

    expect(guard).toContain('ADMIN_SERVER_ROUTE_AUTHORIZATION');
    expect(guard).toContain('adminRouteContractIdFromExecutionContext');
    expect(guard).not.toContain('getAllAndOverride');
    expect(guard).not.toContain('Reflector');
  });

  it('derives panel mounts and shell navigation from one page-route manifest', () => {
    const routeDefinitionFiles = sourceFilesBelow(resolve(REPO_ROOT, 'web'))
      .filter((file) => !file.includes('/generated/') && !file.includes('/__tests__/'))
      .filter((file) => /export\s+const\s+ADMIN_ROUTES\s*=/u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));
    const panel = readRepo(PANEL_MODULE);
    const shell = readRepo(SHELL_LAYOUT);

    expect(routeDefinitionFiles).toEqual([PAGE_AUTHORITY]);
    expect(panel).toContain('ADMIN_ROUTES.map');
    expect(panel).toContain('Record<AdminRouteId, LazyExoticComponent');
    expect(panel).not.toMatch(/<Route\s+path="(?!\*)/u);
    expect(shell).toContain('buildSuperAdminNavigation');
    expect(shell).not.toMatch(/const\s+superAdminNavigation\s*=/u);
    expect(
      existsSync(resolve(REPO_ROOT, 'web/modules/admin-panel/src/routes/adminRoutes.ts')),
    ).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'web/shared-ui/src/authz/admin-billing-routes.ts'))).toBe(
      false,
    );
  });
});
