/**
 * GraphQL DataLoader tenant-source architecture invariant.
 *
 * WHY: GraphQL context is created before resolver-level guards run. If
 * DataLoaders choose their schema from raw x-tenant-id headers, a spoofed
 * header can create tenant-B loaders inside a tenant-A request. Loader tenant
 * identity must come from authenticated/normalized request context only.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('GraphQL loader tenant source architecture', () => {
  it('does not derive DataLoader tenant identity from raw x-tenant-id headers', () => {
    const appModule = readFileSync(join(__dirname, '../../app.module.ts'), 'utf8');
    const contextBlock = appModule.slice(
      appModule.indexOf('context: ({ req }'),
      appModule.indexOf('buildSchemaOptions:', appModule.indexOf('context: ({ req }')),
    );

    expect(contextBlock).toContain("req.user?.tenantId");
    expect(contextBlock).toContain("req.tenantId");
    expect(contextBlock).not.toContain("req.headers['x-tenant-id']");
    expect(contextBlock).not.toContain('req.headers["x-tenant-id"]');
  });

  // The cache interceptors run as method interceptors (after guards, so
  // req.user is populated) and derive a tenant SEGMENT for the Redis cache key
  // and eviction pattern. Same hazard as the DataLoader: if that segment comes
  // from the raw x-tenant-id header, a forged/absent header diverges the cache
  // key from the tenant the handler runs under. They MUST key off the trusted
  // extractTenantIdSafe (req.user.tenantId / req.tenantId) — never the header.
  it.each([
    'cacheable.interceptor.ts',
    'cache-evict.interceptor.ts',
  ])(
    'common/cache/%s derives the cache tenant from extractTenantIdSafe, not the x-tenant-id header',
    (file) => {
      const src = readFileSync(
        join(__dirname, '../../common/cache', file),
        'utf8',
      );
      expect(src).toContain('extractTenantIdSafe');
      expect(src).not.toContain("headers?.['x-tenant-id']");
      expect(src).not.toContain("headers['x-tenant-id']");
      expect(src).not.toContain('headers["x-tenant-id"]');
    },
  );
});
