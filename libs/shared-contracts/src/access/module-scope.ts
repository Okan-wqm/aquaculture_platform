/**
 * ModuleScope — which owner modules a `scoped` read may return (ADR-051 §1; contract rule C2).
 *
 * WHY: a scoped read (the common registry, the workforce, alarm history) serves several modules
 * at once, so "may this caller read it" is not a yes or no but a set of modules. `decideAccess`
 * builds that set on the server from the caller's grants; a client's `module` argument only
 * narrows it. Before this type, the module a list returned was whatever the client asked for.
 *
 * WHAT:
 *   - ALL: every module plus the rows no module owns (unattributed alarm history, for example);
 *     TENANT_ADMIN, SUPER_ADMIN, and an hr grant for the workforce get it.
 *   - modules: a non-empty set of owner modules. An empty scope is never built: it is a deny.
 *   - narrowModuleScope: applies a client's optional module argument. Asking for a module the
 *     scope does not hold raises ScopeWideningError, which the API answers as FORBIDDEN, so an old
 *     client that sends no argument never breaks and no argument can widen.
 *
 * Zero-dependency (see index.ts).
 */
import { OWNER_MODULE_CODES, type OwnerModuleCode } from '../modules/platform-modules';

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type ModuleScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'modules'; readonly modules: NonEmptyReadonlyArray<OwnerModuleCode> };

const ALL: ModuleScope = { kind: 'all' };

export const ALL_MODULES_SCOPE: ModuleScope = Object.freeze(ALL);

/** The scope of exactly these modules, in dictionary order; null when there are none (deny). */
export function moduleScopeOf(modules: readonly OwnerModuleCode[]): ModuleScope | null {
  const [first, ...rest] = OWNER_MODULE_CODES.filter((code) => modules.includes(code));
  if (first === undefined) return null;
  return modulesScope([first, ...rest]);
}

function modulesScope(modules: NonEmptyReadonlyArray<OwnerModuleCode>): ModuleScope {
  const scope: ModuleScope = { kind: 'modules', modules: Object.freeze(modules) };
  return Object.freeze(scope);
}

/** Whether the scope includes the module; `null` stands for the rows no module owns. */
export function moduleScopeIncludes(scope: ModuleScope, module: OwnerModuleCode | null): boolean {
  if (scope.kind === 'all') return true;
  return module !== null && scope.modules.includes(module);
}

/** A client asked for a module outside its server-derived scope (C2). Answered as FORBIDDEN. */
export class ScopeWideningError extends Error {
  constructor(
    readonly requested: OwnerModuleCode,
    readonly scope: ModuleScope,
  ) {
    super(`Module ${requested} is outside the caller's scope`);
    this.name = 'ScopeWideningError';
  }
}

/**
 * Applies a client's optional module argument to a server-derived scope. No argument (undefined
 * or null) leaves the scope as it is; a module inside it narrows to that module; any other module
 * raises ScopeWideningError. The result never holds more than `scope`.
 */
export function narrowModuleScope(
  scope: ModuleScope,
  requested: OwnerModuleCode | null | undefined,
): ModuleScope {
  if (requested === undefined || requested === null) return scope;
  if (!moduleScopeIncludes(scope, requested)) throw new ScopeWideningError(requested, scope);
  return modulesScope([requested]);
}
