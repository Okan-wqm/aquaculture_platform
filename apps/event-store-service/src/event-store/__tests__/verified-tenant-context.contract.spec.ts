import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('event-store verified tenant context contract', () => {
  const eventController = readFileSync(
    resolve(__dirname, '../event-store.controller.ts'),
    'utf8',
  );
  const projectionsController = readFileSync(
    resolve(__dirname, '../../projections/projections.controller.ts'),
    'utf8',
  );
  const appModule = readFileSync(resolve(__dirname, '../../app.module.ts'), 'utf8');

  it('keeps controllers on verified request tenant context, not raw tenant headers', () => {
    for (const source of [eventController, projectionsController]) {
      expect(source).toContain('@Req() request: TenantRequest');
      expect(source).toContain('verifiedIdentity?.effectiveTenantId');
      expect(source).not.toContain("@Headers('x-tenant-id')");
      expect(source).not.toContain('@Headers("x-tenant-id")');
      expect(source).not.toMatch(/headers\s*\[\s*['"]x-tenant-id['"]\s*\]/);
    }
  });

  it('installs service identity guard and registers tenant execution context via the SSoT module', () => {
    // Service identity guard is still an APP_GUARD provider.
    expect(appModule).toContain('EventStoreServiceIdentityGuard');
    expect(appModule).toMatch(
      /provide:\s*APP_GUARD,[\s\S]*useClass:\s*EventStoreServiceIdentityGuard/,
    );
    // Tenant execution context is now registered through the shared SSoT module
    // (TenantExecutionContextModule) instead of an inline APP_INTERCEPTOR block.
    // NestJS runs guards BEFORE interceptors, so EventStoreServiceIdentityGuard
    // still executes ahead of the tenant-context interceptor — the original
    // "service identity before tenant execution context" intent is preserved.
    expect(appModule).toContain('TenantExecutionContextModule');
  });
});
