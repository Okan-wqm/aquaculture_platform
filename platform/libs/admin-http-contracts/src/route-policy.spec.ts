import {
  ADMIN_HTTP_ROUTE_POLICY,
  adminLogicalRoutePathFromMetadata,
  adminNetworkAliases,
  assertCanonicalAdminRequestTarget,
} from './route-policy';

describe('admin HTTP route policy', () => {
  it('publishes the exact Express matcher semantics used by the compiler', () => {
    expect(ADMIN_HTTP_ROUTE_POLICY.matcher).toEqual({
      caseSensitive: false,
      strictTrailingSlash: false,
      parameterCodec: 'decode-uri-component',
      staticBeforeParameter: true,
      getProvidesImplicitHead: true,
      optionsDiscovery: 'framework-generated',
    });
  });

  it('derives every public network alias from the single prefix/version policy', () => {
    expect(adminNetworkAliases('/tenants/:id')).toEqual([
      '/api/tenants/:id',
      '/api/v1/tenants/:id',
    ]);
    expect(adminNetworkAliases('/health/ready')).toEqual(['/health/ready', '/v1/health/ready']);
  });

  it('derives compiler and runtime route identity from the same Nest metadata authority', () => {
    expect(adminLogicalRoutePathFromMetadata('database/backups', '/')).toBe('/database/backups');
    expect(adminLogicalRoutePathFromMetadata('tenants', ':id')).toBe('/tenants/:id');
    expect(adminLogicalRoutePathFromMetadata('/', '/')).toBe('/');
    expect(() => adminLogicalRoutePathFromMetadata('tenants//shadow', ':id')).toThrow(
      'one canonical relative path',
    );
  });

  it.each(['/tenants//:id', '/tenants/', '/tenants\\:id', '/tenants?active=true'])(
    'rejects non-canonical logical paths instead of normalizing %s',
    (path) => {
      expect(() => adminNetworkAliases(path)).toThrow('one canonical absolute path');
    },
  );

  it.each([
    '/api/users/%73tats',
    '/api/users/%2fstats',
    '/api/users/%2Fstats',
    '/api/users/%2573tats',
    '/api//users',
    '/api/users/',
    '/api\\users',
    '/api/users/%C0%AF',
  ])('rejects alternate route spelling %s', (target) => {
    expect(() => assertCanonicalAdminRequestTarget(target)).toThrow();
  });

  it.each([
    '/api/users/stats',
    '/api/users/tenant-1?page=2',
    '/api/debug/cache/key%20with%20spaces',
    '/api/search/%C3%A7iftlik',
  ])('accepts canonical request target %s', (target) => {
    expect(() => assertCanonicalAdminRequestTarget(target)).not.toThrow();
  });
});
