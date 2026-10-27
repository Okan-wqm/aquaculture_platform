import { OWNER_MODULE_CODES, type OwnerModuleCode } from '../../modules/platform-modules';
import {
  ALL_MODULES_SCOPE,
  ScopeWideningError,
  moduleScopeIncludes,
  moduleScopeOf,
  narrowModuleScope,
  type ModuleScope,
} from '../module-scope';

/**
 * ModuleScope (ADR-051 §1 `scoped`, contract rule C2): the modules a scoped read may return, built
 * on the server from the caller's grants. A client `module` argument only narrows it; asking for
 * more raises ScopeWideningError, which the API answers as FORBIDDEN.
 */

/** Every non-empty subset of the owner modules, as a scope, plus ALL. */
function everyScope(): ModuleScope[] {
  const scopes: ModuleScope[] = [ALL_MODULES_SCOPE];
  for (let mask = 1; mask < 1 << OWNER_MODULE_CODES.length; mask += 1) {
    const modules = OWNER_MODULE_CODES.filter((_, index) => (mask & (1 << index)) !== 0);
    const scope = moduleScopeOf(modules);
    if (scope === null) throw new Error('a non-empty subset must build a scope');
    scopes.push(scope);
  }
  return scopes;
}

const REQUESTS: ReadonlyArray<OwnerModuleCode | null | undefined> = [
  undefined,
  null,
  ...OWNER_MODULE_CODES,
];

describe('moduleScopeOf', () => {
  it('builds a scope of the given modules, deduplicated in dictionary order', () => {
    expect(moduleScopeOf(['sensor', 'farm', 'sensor'])).toEqual({
      kind: 'modules',
      modules: ['farm', 'sensor'],
    });
  });

  it('builds no scope from no modules: an empty scope is a deny, never "everything"', () => {
    expect(moduleScopeOf([])).toBeNull();
  });

  it('freezes what it builds', () => {
    const scope = moduleScopeOf(['farm']);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(scope?.kind === 'modules' && Object.isFrozen(scope.modules)).toBe(true);
    expect(Object.isFrozen(ALL_MODULES_SCOPE)).toBe(true);
  });
});

describe('moduleScopeIncludes', () => {
  it('ALL includes every module and the unattributed rows (null)', () => {
    for (const module of OWNER_MODULE_CODES) {
      expect(moduleScopeIncludes(ALL_MODULES_SCOPE, module)).toBe(true);
    }
    expect(moduleScopeIncludes(ALL_MODULES_SCOPE, null)).toBe(true);
  });

  it('a module scope includes its modules only, never unattributed rows', () => {
    const scope = moduleScopeOf(['farm']);
    if (scope === null) throw new Error('scope expected');
    expect(moduleScopeIncludes(scope, 'farm')).toBe(true);
    expect(moduleScopeIncludes(scope, 'sensor')).toBe(false);
    expect(moduleScopeIncludes(scope, null)).toBe(false);
  });
});

describe('narrowModuleScope (C2: narrowing never widens)', () => {
  it('leaves the scope as it is when the client names no module', () => {
    const farm = moduleScopeOf(['farm']);
    expect(narrowModuleScope(ALL_MODULES_SCOPE, undefined)).toBe(ALL_MODULES_SCOPE);
    expect(narrowModuleScope(ALL_MODULES_SCOPE, null)).toBe(ALL_MODULES_SCOPE);
    if (farm === null) throw new Error('scope expected');
    expect(narrowModuleScope(farm, null)).toBe(farm);
  });

  it('narrows to the one module asked for when the scope holds it', () => {
    const scope = moduleScopeOf(['farm', 'sensor']);
    if (scope === null) throw new Error('scope expected');
    expect(narrowModuleScope(scope, 'sensor')).toEqual({ kind: 'modules', modules: ['sensor'] });
    expect(narrowModuleScope(ALL_MODULES_SCOPE, 'hr')).toEqual({
      kind: 'modules',
      modules: ['hr'],
    });
  });

  it('raises ScopeWideningError for a module outside the scope (role A passing SENSOR)', () => {
    const roleA = moduleScopeOf(['farm']);
    if (roleA === null) throw new Error('scope expected');
    expect(() => narrowModuleScope(roleA, 'sensor')).toThrow(ScopeWideningError);
    try {
      narrowModuleScope(roleA, 'sensor');
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeWideningError);
      expect(error).toMatchObject({
        name: 'ScopeWideningError',
        requested: 'sensor',
        scope: roleA,
      });
    }
  });

  it.each(
    everyScope().flatMap((scope) => REQUESTS.map((requested) => [scope, requested] as const)),
  )('never returns more than %j holds (request %s)', (scope, requested) => {
    let narrowed: ModuleScope;
    try {
      narrowed = narrowModuleScope(scope, requested);
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeWideningError);
      expect(
        requested !== undefined && requested !== null && !moduleScopeIncludes(scope, requested),
      ).toBe(true);
      return;
    }
    for (const module of [...OWNER_MODULE_CODES, null]) {
      if (moduleScopeIncludes(narrowed, module)) {
        expect(moduleScopeIncludes(scope, module)).toBe(true);
      }
    }
  });
});
