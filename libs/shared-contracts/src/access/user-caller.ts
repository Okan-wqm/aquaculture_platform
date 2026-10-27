/**
 * The member caller and the `moduleAccess` claim (ADR-051 §1, §2; RBAC-MEDIUM-024).
 *
 * WHY a class with an ES private brand: a UserCaller must come only from a gateway-verified
 * identity (ADR-051 §1). A brand stored under a symbol key is an own enumerable property, so
 * `{ ...real, accountRole: 'TENANT_ADMIN' }` copied it: the compiler accepted the copy as a
 * UserCaller and decideAccess allowed it. An ES private field is no property: object spread, an
 * object literal and JSON cannot carry it. The compiler therefore rejects such an object as a
 * UserCaller (TS2741 "Property '#verified' is missing"), and `isUserCaller`, which decideAccess
 * asks before it decides, refuses it at run time. The class is exported as a type only, so
 * `userCaller` is the one way to build one. A copy of this library loaded twice in one process
 * would refuse the other copy's callers, which fails closed.
 *
 * WHY validate here: the claims arrive as JSON (the verified JWT, the gateway assertion, the
 * member caller a NATS request carries), so their static type proves nothing. ADR-051 §2 answers
 * a malformed claim with 400; `userCaller` throws MalformedCallerError, which the middleware and
 * guards (PKG-04, PKG-05) answer as 400 and the NATS responders (PKG-09) as INVALID_REQUEST,
 * instead of building a caller whose garbage grant or string `roles` decideAccess would read.
 *
 * WHAT:
 *   - ModuleAccess: the claim, `{ ownerModule → MODULE_MANAGER | MODULE_USER }`, and
 *     isModuleAccess, its guard.
 *   - VerifiedMemberIdentity: what `userCaller` reads; the claims are `unknown` until checked.
 *   - userCaller: validates the claims, keeps only the account role of `roles`, and returns a
 *     frozen UserCaller holding frozen copies. A missing `moduleAccess` means no grants, a missing
 *     `capabilities` none.
 *   - isUserCaller: true only for a caller `userCaller` built.
 *
 * Zero-dependency (see index.ts).
 */
import { isOwnerModuleCode, type OwnerModuleCode } from '../modules/platform-modules';

import { accountRoleOf, isModuleRole, type AccountRole, type ModuleRole } from './platform-roles';

/** The `moduleAccess` claim (ADR-051 §2). Absent or `{}` both mean no grants. */
export type ModuleAccess = Readonly<Partial<Record<OwnerModuleCode, ModuleRole>>>;

/**
 * True when `value` is a well-formed claim: an object whose every key is an owner module and
 * every value a module role. Alert, ai and unknown codes, account roles and missing values are
 * malformed (the receiving middleware answers 400, ADR-051 §2).
 */
export function isModuleAccess(value: unknown): value is ModuleAccess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([code, role]) => isOwnerModuleCode(code) && isModuleRole(role),
  );
}

/** What a gateway-verified identity carries, as `userCaller` reads it. */
export interface VerifiedMemberIdentity {
  readonly userId: string;
  /** Null only for SUPER_ADMIN, who acts on the platform. */
  readonly tenantId: string | null;
  /** `users.role` and `roles[]` exactly as verified: an array of strings, else malformed. */
  readonly roles: unknown;
  /** The `moduleAccess` claim; absent on a token minted before it existed, meaning no grants. */
  readonly moduleAccess?: unknown;
  /** The `resourcePermissions` claim, an array of strings; absent means none. */
  readonly capabilities?: unknown;
}

/** The claims `userCaller` validates, named by the error it throws. */
export type CallerClaim = 'roles' | 'moduleAccess' | 'capabilities';

/** A verified identity carried a malformed claim: answered as 400 (ADR-051 §2). */
export class MalformedCallerError extends Error {
  constructor(readonly claim: CallerClaim) {
    // The message names the claim only: claim values stay out of logs.
    super(`The ${claim} claim of the member identity is malformed`);
    this.name = 'MalformedCallerError';
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function rolesClaim(value: unknown): readonly string[] {
  if (!isStringArray(value)) throw new MalformedCallerError('roles');
  return value;
}

function moduleAccessClaim(value: unknown): ModuleAccess {
  if (value === undefined) return Object.freeze({});
  if (!isModuleAccess(value)) throw new MalformedCallerError('moduleAccess');
  return Object.freeze({ ...value });
}

function capabilitiesClaim(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!isStringArray(value)) throw new MalformedCallerError('capabilities');
  return Object.freeze([...value]);
}

/** A member of a tenant (or SUPER_ADMIN), as a gateway-verified identity describes them. */
class UserCaller {
  /** The brand: only this constructor sets it, and no copy of the object carries it. */
  readonly #verified = true;
  readonly kind = 'user' as const;
  readonly userId: string;
  /** Null only for SUPER_ADMIN, who acts on the platform. */
  readonly tenantId: string | null;
  /** TENANT_ADMIN or SUPER_ADMIN; null for every other member, whatever `users.role` says. */
  readonly accountRole: AccountRole | null;
  readonly moduleAccess: ModuleAccess;
  /** The `resourcePermissions` claim. */
  readonly capabilities: readonly string[];

  constructor(identity: VerifiedMemberIdentity) {
    this.userId = identity.userId;
    this.tenantId = identity.tenantId;
    this.accountRole = accountRoleOf(rolesClaim(identity.roles));
    this.moduleAccess = moduleAccessClaim(identity.moduleAccess);
    this.capabilities = capabilitiesClaim(identity.capabilities);
    Object.freeze(this);
  }

  static carriesBrand(value: object): boolean {
    return #verified in value;
  }
}

export type { UserCaller };

/**
 * The only constructor of a UserCaller. It validates the claims (MalformedCallerError) and copies
 * and freezes what it reads, so a later change to the identity object cannot change a decision
 * already made with the caller.
 */
export function userCaller(identity: VerifiedMemberIdentity): UserCaller {
  return new UserCaller(identity);
}

/** True only for a caller `userCaller` built; a spread, literal or JSON copy of one is not. */
export function isUserCaller(value: unknown): value is UserCaller {
  return typeof value === 'object' && value !== null && UserCaller.carriesBrand(value);
}
