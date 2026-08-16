import {
  IMPERSONATION_MODULES,
  IMPERSONATION_PERMISSION_FIELDS,
  compileImpersonationAuthorizationOperationsV1,
  compileImpersonationPermissionsV1,
  decodeCanonicalImpersonationAuthorizationOperationsV1,
  decodeCanonicalImpersonationPermissionsV1,
  evaluateImpersonationAuthorization,
  isImpersonationPermissionsContract,
  isImpersonationContextId,
} from '../http/impersonation-policy';

const basePermissions = (): Record<string, unknown> => ({
  canViewData: true,
  canModifyData: false,
  canAccessSettings: false,
  canManageUsers: false,
  canViewBilling: false,
  canExportData: false,
});

describe('canonical impersonation permission compiler', () => {
  it('requires lower-case canonical UUID text for session and tenant identity', () => {
    expect(isImpersonationContextId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
    expect(isImpersonationContextId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(false);
  });
  it('keeps authority vocabularies and compiled snapshots recursively immutable', () => {
    const originalFields = [...IMPERSONATION_PERMISSION_FIELDS];
    const originalModules = [...IMPERSONATION_MODULES];
    const compiled = compileImpersonationPermissionsV1({
      ...basePermissions(),
      allowedModules: ['farm', 'sensor'],
    });

    expect(Object.isFrozen(IMPERSONATION_PERMISSION_FIELDS)).toBe(true);
    expect(Object.isFrozen(IMPERSONATION_MODULES)).toBe(true);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled?.allowedModules)).toBe(true);
    expect(Reflect.set(IMPERSONATION_PERMISSION_FIELDS, 0, 'forged')).toBe(false);
    expect(() => Reflect.apply(Array.prototype.push, IMPERSONATION_MODULES, ['forged'])).toThrow();
    expect([...IMPERSONATION_PERMISSION_FIELDS]).toEqual(originalFields);
    expect([...IMPERSONATION_MODULES]).toEqual(originalModules);
  });

  it('normalizes equivalent producer module order to one frozen snapshot', () => {
    const first = compileImpersonationPermissionsV1({
      ...basePermissions(),
      allowedModules: ['billing', 'farm'],
      restrictedModules: ['ai', 'sensor'],
    });
    const second = compileImpersonationPermissionsV1({
      ...basePermissions(),
      restrictedModules: ['sensor', 'ai'],
      allowedModules: ['farm', 'billing'],
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      allowedModules: ['farm', 'billing'],
      restrictedModules: ['sensor', 'ai'],
    });
    expect(decodeCanonicalImpersonationPermissionsV1(first)).toEqual(first);
  });

  it('does not normalize reordered wire snapshots at the decoder boundary', () => {
    const reordered = {
      ...basePermissions(),
      allowedModules: ['billing', 'farm'],
    };

    expect(compileImpersonationPermissionsV1(reordered)?.allowedModules).toEqual([
      'farm',
      'billing',
    ]);
    expect(decodeCanonicalImpersonationPermissionsV1(reordered)).toBeUndefined();
    expect(isImpersonationPermissionsContract(reordered)).toBe(false);
  });

  it.each([
    ['duplicate', ['farm', 'farm'], undefined],
    ['overlap', ['farm'], ['farm']],
  ])('rejects %s module authority', (_name, allowedModules, restrictedModules) => {
    const value = {
      ...basePermissions(),
      allowedModules,
      ...(restrictedModules ? { restrictedModules } : {}),
    };
    expect(compileImpersonationPermissionsV1(value)).toBeUndefined();
    expect(decodeCanonicalImpersonationPermissionsV1(value)).toBeUndefined();
    expect(isImpersonationPermissionsContract(value)).toBe(false);
  });

  it('rejects unknown permission fields without mutating the input', () => {
    const value = {
      ...basePermissions(),
      canDeleteAnything: true,
    };
    const before = JSON.stringify(value);

    expect(compileImpersonationPermissionsV1(value)).toBeUndefined();
    expect(decodeCanonicalImpersonationPermissionsV1(value)).toBeUndefined();
    expect(JSON.stringify(value)).toBe(before);
  });

  it('rejects accessors, symbols, class instances, and optional undefined without repair', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty(basePermissions(), 'allowedModules', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return ['farm'];
      },
    });
    const symbol = { ...basePermissions(), [Symbol('forged')]: true };
    class PermissionClass {
      canViewData = true;
      canModifyData = false;
      canAccessSettings = false;
      canManageUsers = false;
      canViewBilling = false;
      canExportData = false;
    }
    const undefinedOptional = { ...basePermissions(), allowedModules: undefined };

    for (const value of [accessor, symbol, new PermissionClass(), undefinedOptional]) {
      expect(compileImpersonationPermissionsV1(value)).toBeUndefined();
      expect(decodeCanonicalImpersonationPermissionsV1(value)).toBeUndefined();
    }
    expect(getterCalls).toBe(0);
  });

  it('freezes the complete authorization decision', () => {
    const permissions = compileImpersonationPermissionsV1({
      ...basePermissions(),
      allowedModules: ['farm'],
    });
    if (!permissions) throw new Error('expected canonical permissions');

    const decision = evaluateImpersonationAuthorization(permissions, [
      { authority: 'data.write', module: 'sensor', operation: 'updateSensor' },
    ]);

    expect(decision).toEqual({
      allowed: false,
      missingGrants: ['canModifyData'],
      deniedModules: ['sensor'],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.missingGrants)).toBe(true);
    expect(Object.isFrozen(decision.deniedModules)).toBe(true);
  });
});

describe('canonical impersonation operation decoder', () => {
  const first = {
    authority: 'data.read' as const,
    module: 'farm' as const,
    operation: 'Query.farms',
  };
  const second = {
    authority: 'data.read' as const,
    module: 'sensor' as const,
    operation: 'Query.sensors',
  };

  it('accepts jsonb-reordered object members without weakening array order', () => {
    const jsonbProjection = [
      { module: first.module, authority: first.authority, operation: first.operation },
      { operation: second.operation, module: second.module, authority: second.authority },
    ];

    expect(decodeCanonicalImpersonationAuthorizationOperationsV1(jsonbProjection)).toEqual([
      first,
      second,
    ]);
  });

  it('rejects a persisted array that would require canonical reordering', () => {
    const reordered = [second, first];

    expect(compileImpersonationAuthorizationOperationsV1(reordered)).toEqual([first, second]);
    expect(decodeCanonicalImpersonationAuthorizationOperationsV1(reordered)).toBeUndefined();
  });
});
