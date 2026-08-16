import { Role } from '@platform/identity';

import {
  adminResponse,
  createAdminRequestContract,
  createAdminRouteAuthorizationV1,
  createAdminRouteDefinition,
} from './index';

function defineRouteWith(authorization: unknown): unknown {
  const request = createAdminRequestContract(
    adminResponse.object({}),
    adminResponse.object({}),
    {},
    adminResponse.object({}),
    adminResponse.void(),
    null,
  );
  return Reflect.apply(createAdminRouteDefinition, undefined, [
    'GET',
    '/admin/test',
    request,
    authorization,
    200,
    adminResponse.object({ ok: adminResponse.boolean() }),
  ]);
}

describe('admin route authorization authority', () => {
  it('seals a canonical bearer-session requirement', () => {
    const authorization = createAdminRouteAuthorizationV1(
      'bearer-session',
      [Role.SUPER_ADMIN],
      ['users:view'],
    );

    expect(authorization).toEqual({
      authentication: 'bearer-session',
      requiredRoles: [Role.SUPER_ADMIN],
      requiredPermissions: ['users:view'],
      permissionMode: 'all',
    });
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.requiredRoles)).toBe(true);
    expect(Object.isFrozen(authorization.requiredPermissions)).toBe(true);
  });

  it('allows public routes only when they carry no authorization claims', () => {
    expect(createAdminRouteAuthorizationV1('public', [], [])).toEqual({
      authentication: 'public',
      requiredRoles: [],
      requiredPermissions: [],
      permissionMode: 'all',
    });
    expect(() => createAdminRouteAuthorizationV1('public', [Role.SUPER_ADMIN], [])).toThrow(
      'public admin routes cannot declare',
    );
  });

  it('fails closed for empty or duplicate bearer-session requirements', () => {
    expect(() => createAdminRouteAuthorizationV1('bearer-session', [], [])).toThrow(
      'require at least one canonical role',
    );
    expect(() =>
      createAdminRouteAuthorizationV1('bearer-session', [Role.SUPER_ADMIN, Role.SUPER_ADMIN], []),
    ).toThrow('duplicate roles');
    expect(() =>
      createAdminRouteAuthorizationV1(
        'bearer-session',
        [Role.SUPER_ADMIN],
        ['users:view', 'users:view'],
      ),
    ).toThrow('duplicate permissions');
  });

  it('rejects unknown role and permission strings at JavaScript boundaries', () => {
    expect(() =>
      Reflect.apply(createAdminRouteAuthorizationV1, undefined, ['cookie', [], []]),
    ).toThrow('unknown authentication mode');
    expect(() =>
      Reflect.apply(createAdminRouteAuthorizationV1, undefined, ['bearer-session', ['ROOT'], []]),
    ).toThrow('unknown role');
    expect(() =>
      Reflect.apply(createAdminRouteAuthorizationV1, undefined, [
        'bearer-session',
        [Role.SUPER_ADMIN],
        ['users:root'],
      ]),
    ).toThrow('unknown tenant capability');
  });

  it('brands canonical authorization and rejects malformed route-factory inputs', () => {
    const canonical = createAdminRouteAuthorizationV1(
      'bearer-session',
      [Role.SUPER_ADMIN],
      [],
    );
    expect(defineRouteWith(canonical)).toBeDefined();

    expect(() => defineRouteWith('bearer-session')).toThrow('canonical object');
    expect(() =>
      defineRouteWith({
        authentication: 'bearer-session',
        requiredRoles: [Role.SUPER_ADMIN],
        requiredPermissions: [],
        permissionMode: 'any',
      }),
    ).toThrow('unknown permission mode');
    expect(() =>
      defineRouteWith({
        authentication: 'public',
        requiredRoles: [Role.SUPER_ADMIN],
        requiredPermissions: [],
        permissionMode: 'all',
      }),
    ).toThrow('public admin routes cannot declare');
  });
});
