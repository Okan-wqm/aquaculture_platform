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
});
