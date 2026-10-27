/**
 * decideAccess — the one answer to "may this caller do this" (ADR-051 §1; RBAC-MEDIUM-024).
 *
 * WHY: no function answered it on the server. farm-service decided by the global role alone, a
 * global MODULE_MANAGER read payroll, and the only module rule lived in the web client. Guards
 * (PKG-05), NATS responders (PKG-09), socket joins (PKG-10, PKG-11), notification fan-out
 * (PKG-44) and the nav (PKG-34) call this function, so they cannot disagree. It is pure: no I/O,
 * no clock, no state; the same caller and request always get the same decision.
 *
 * THE DECISION TABLE (ADR-051 §1)
 *
 * | Kind                | Passes when                                 | Result                  |
 * | ------------------- | ------------------------------------------- | ----------------------- |
 * | module(m)           | a member's moduleAccess[m] satisfies @Roles | allow or deny           |
 * | scoped(k)           | a member with a grant satisfying @Roles     | ModuleScope of those    |
 * |                     |                                             | grants (ALL for the     |
 * |                     |                                             | workforce with an hr    |
 * |                     |                                             | grant); empty denies    |
 * | company             | a member holding company:view, read intent  | allow; a write denies   |
 * | self                | an authenticated member                     | allow, filtered to them |
 * | account(capability) | a member holding the capability             | allow or deny           |
 * | service             | a service caller among the subject's        | allow or deny           |
 * |                     | declared senders, with its (read) intent    |                         |
 *
 * What each kind protects: module(m) the module-private data of m (HR pay and finance under hr);
 * scoped(common-registry | workforce | alerts) the registry kinds, employees and HR reads, alarm
 * history; company the Company projections only (PKG-33); self the caller's own records (my*,
 * DMs); account tenant account administration; service a NATS request no member stands behind.
 *
 * Callers and roles:
 *   - A member (UserCaller) fails `service`; a service caller (ServiceCaller) fails every other
 *     kind. A member caller `userCaller` did not build (a spread, literal or JSON copy of one)
 *     fails every kind, so no caller passes on claims nobody validated (user-caller.ts).
 *   - @Roles is checked by kind, within the one hierarchy: MODULE_MANAGER and MODULE_USER only by
 *     the caller's role in the spec's module; TENANT_ADMIN and SUPER_ADMIN only by the caller's
 *     account role. So a farm MODULE_MANAGER fails a farm operation gated to TENANT_ADMIN.
 *     company, self and account read no @Roles: a request for them that names roles is denied,
 *     never decided as though the roles were absent.
 *   - Only a module role counts as a grant: a claim value that is none grants nothing.
 *   - A missing claim means no grants. The global role never grants module access: a member's
 *     `users.role` of MODULE_MANAGER or MODULE_USER counts for nothing here.
 *   - TENANT_ADMIN keeps full access: its claim lists every module enabled for the tenant (the
 *     module-access reader, PKG-04), so it passes module(m) for those and no other; it gets ALL
 *     for every scoped kind and holds every capability, company:view included.
 *   - SUPER_ADMIN keeps the platform pass on every member kind. Nobody passes a Company write.
 */
import { OWNER_MODULE_CODES, type OwnerModuleCode } from '../modules/platform-modules';

import type {
  AccessIntent,
  AccessKind,
  AccessRequest,
  Caller,
  NatsServiceName,
  ScopedKind,
  ServiceAccessSpec,
  ServiceCaller,
  ServiceIntent,
  SubjectAccess,
} from './access-spec';
import { ALL_MODULES_SCOPE, moduleScopeOf, type ModuleScope } from './module-scope';
import {
  isAccountRole,
  isModuleRole,
  platformRoleSatisfies,
  type ModuleRole,
  type PlatformRole,
} from './platform-roles';
import { COMPANY_VIEW_CAPABILITY, holdsTenantCapabilities } from './tenant-capabilities';
import { isUserCaller, type ModuleAccess, type UserCaller } from './user-caller';

/** Why a decision denied. The deny metric is labelled by kind; reasons serve tests and logs. */
export type AccessDenyReason =
  /** A service caller on a member kind, or a member on `service`. */
  | 'caller-kind'
  /** A member caller `userCaller` did not build. */
  | 'unverified-caller'
  /** module(m): the caller holds no grant in m. */
  | 'no-grant'
  /**
   * module(m): the grant or the account role does not satisfy @Roles; company, self, account: the
   * request names @Roles, which these kinds do not read.
   */
  | 'roles'
  /** scoped: no grant satisfies @Roles. */
  | 'empty-scope'
  /** company: a write. */
  | 'company-write'
  /** company or account: the caller lacks the capability. */
  | 'capability'
  /** service: the caller is not a declared sender of the subject. */
  | 'not-a-sender'
  /** service: the request's intent is not the subject's. */
  | 'intent';

export type AccessDecision =
  | { readonly allowed: true; readonly kind: Exclude<AccessKind, 'scoped'> }
  | { readonly allowed: true; readonly kind: 'scoped'; readonly scope: ModuleScope }
  | { readonly allowed: false; readonly kind: AccessKind; readonly reason: AccessDenyReason };

function deny(kind: AccessKind, reason: AccessDenyReason): AccessDecision {
  const decision: AccessDecision = { allowed: false, kind, reason };
  return Object.freeze(decision);
}

function allow(kind: Exclude<AccessKind, 'scoped'>): AccessDecision {
  const decision: AccessDecision = { allowed: true, kind };
  return Object.freeze(decision);
}

function allowScope(scope: ModuleScope): AccessDecision {
  const decision: AccessDecision = { allowed: true, kind: 'scoped', scope };
  return Object.freeze(decision);
}

export function decideAccess(caller: Caller, request: AccessRequest): AccessDecision {
  if (request.spec.kind === 'service') {
    return caller.kind === 'service'
      ? decideService(caller, request.spec, request.intent)
      : deny('service', 'caller-kind');
  }
  if (caller.kind === 'service') return deny(request.spec.kind, 'caller-kind');
  if (!isUserCaller(caller)) return deny(request.spec.kind, 'unverified-caller');
  return decideMember(caller, request);
}

/** The kinds whose decision reads @Roles (see AccessRequest). */
function readsRoles(kind: AccessKind): boolean {
  return kind === 'module' || kind === 'scoped';
}

function decideMember(caller: UserCaller, request: AccessRequest): AccessDecision {
  const { spec } = request;
  if (!readsRoles(spec.kind) && rolesOf(request).length > 0) return deny(spec.kind, 'roles');
  switch (spec.kind) {
    case 'module':
      return decideModule(caller, spec.module, rolesOf(request));
    case 'scoped':
      return decideScoped(caller, spec.scope, rolesOf(request));
    case 'company':
      if (request.intent === 'write') return deny('company', 'company-write');
      return holdsTenantCapabilities(caller, [COMPANY_VIEW_CAPABILITY])
        ? allow('company')
        : deny('company', 'capability');
    case 'self':
      return allow('self');
    case 'account':
      return holdsTenantCapabilities(caller, [spec.capability])
        ? allow('account')
        : deny('account', 'capability');
    case 'service':
      return deny('service', 'caller-kind');
  }
}

/** The request's @Roles; `[]` when it names none. */
function rolesOf(request: AccessRequest): readonly PlatformRole[] {
  return request.roles ?? [];
}

/**
 * @Roles checked by kind: an account requirement by the account role only, a module requirement
 * by `moduleRole` (the caller's role in the module being decided) only. No roles: satisfied.
 */
function rolesSatisfied(
  caller: UserCaller,
  roles: readonly PlatformRole[],
  moduleRole: ModuleRole | undefined,
): boolean {
  if (roles.length === 0) return true;
  return roles.some((required) => {
    if (isAccountRole(required)) {
      return caller.accountRole !== null && platformRoleSatisfies(caller.accountRole, required);
    }
    return moduleRole !== undefined && platformRoleSatisfies(moduleRole, required);
  });
}

/** The caller's role in `module`; a value that is no module role is no grant (fail closed). */
function grantIn(moduleAccess: ModuleAccess, module: OwnerModuleCode): ModuleRole | undefined {
  const grant: unknown = moduleAccess[module];
  return isModuleRole(grant) ? grant : undefined;
}

function decideModule(
  caller: UserCaller,
  module: OwnerModuleCode,
  roles: readonly PlatformRole[],
): AccessDecision {
  if (caller.accountRole === 'SUPER_ADMIN') return allow('module');
  const grant = grantIn(caller.moduleAccess, module);
  if (grant === undefined) return deny('module', 'no-grant');
  return rolesSatisfied(caller, roles, grant) ? allow('module') : deny('module', 'roles');
}

function decideScoped(
  caller: UserCaller,
  scope: ScopedKind,
  roles: readonly PlatformRole[],
): AccessDecision {
  if (caller.accountRole === 'SUPER_ADMIN') return allowScope(ALL_MODULES_SCOPE);
  const granted = OWNER_MODULE_CODES.filter((module) => {
    const grant = grantIn(caller.moduleAccess, module);
    return grant !== undefined && rolesSatisfied(caller, roles, grant);
  });
  if (caller.accountRole === 'TENANT_ADMIN') {
    return granted.length > 0 || rolesSatisfied(caller, roles, undefined)
      ? allowScope(ALL_MODULES_SCOPE)
      : deny('scoped', 'empty-scope');
  }
  if (scope === 'workforce' && granted.includes('hr')) return allowScope(ALL_MODULES_SCOPE);
  const modules = moduleScopeOf(granted);
  return modules === null ? deny('scoped', 'empty-scope') : allowScope(modules);
}

function decideService(
  caller: ServiceCaller,
  spec: ServiceAccessSpec,
  intent: AccessIntent,
): AccessDecision {
  if (!spec.entry.senders.includes(caller.service)) return deny('service', 'not-a-sender');
  return intent === spec.entry.intent ? allow('service') : deny('service', 'intent');
}

/**
 * SERVICE_GRANTS: service → subject → intent, for every subject a service caller decides. It is
 * derived from the subject entries (REQUEST_ACCESS, libs/event-contracts, PKG-09) and never
 * written by hand, so the grant table and the entries cannot disagree (ADR-051 §3).
 */
export type ServiceGrants<Subject extends string> = {
  readonly [Service in NatsServiceName]?: { readonly [S in Subject]?: ServiceIntent };
};

export function deriveServiceGrants<Subject extends string>(entries: {
  readonly [S in Subject]: SubjectAccess;
}): ServiceGrants<Subject> {
  const grants = new Map<NatsServiceName, Map<Subject, ServiceIntent>>();
  for (const subject of Object.keys(entries).filter((key): key is Subject => key in entries)) {
    const entry = entries[subject];
    if (entry.caller !== 'service') continue;
    for (const sender of entry.senders) {
      const subjects = grants.get(sender) ?? new Map<Subject, ServiceIntent>();
      subjects.set(subject, entry.intent);
      grants.set(sender, subjects);
    }
  }
  const result: { [Service in NatsServiceName]?: { readonly [S in Subject]?: ServiceIntent } } = {};
  for (const [sender, subjects] of grants) {
    const bySubject: { [S in Subject]?: ServiceIntent } = {};
    for (const [subject, intent] of subjects) bySubject[subject] = intent;
    result[sender] = Object.freeze(bySubject);
  }
  return Object.freeze(result);
}
