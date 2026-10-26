/**
 * The access vocabulary — what an operation demands and who asks (ADR-051 §1, §2, §3;
 * RBAC-MEDIUM-024). `decideAccess` (decide-access.ts) answers from these types and nothing else.
 *
 * WHAT:
 *   - AccessSpec: the six access kinds — `module(m)`, `scoped(common-registry | workforce |
 *     alerts)`, `company`, `self`, `account(capability)` and `service` — and AccessRequest, a spec
 *     with the operation's intent and, for the role-gated kinds, its `@Roles`.
 *   - ModuleAccess: the `moduleAccess` claim, `{ ownerModule → MODULE_MANAGER | MODULE_USER }`
 *     (ADR-051 §2), and its guard for a value crossing a trust boundary.
 *   - Caller = UserCaller | ServiceCaller. A UserCaller is branded and built only by `userCaller`
 *     from a gateway-verified identity (the verified JWT and assertion, `@AccessCaller()`, or the
 *     member caller a service received), never from model output or a stored row. A missing claim
 *     means no grants, and `users.role` counts only as an account role. A ServiceCaller names one
 *     NATS identity of `infrastructure/nats/services.yaml` (ADR-015), whose names
 *     NATS_SERVICE_NAMES lists (tests/invariants/access-service-caller-names.spec.ts).
 *   - SubjectAccess: how one gated NATS request subject is decided — by a member caller with a
 *     spec, or by a service caller among declared senders, read-only. REQUEST_ACCESS
 *     (libs/event-contracts, PKG-09) holds one per subject; it sits beside the subject constants
 *     because this library cannot import event-contracts, and SERVICE_GRANTS derives from it
 *     through `deriveServiceGrants` (decide-access.ts).
 *
 * Zero-dependency (see index.ts).
 */
import { isOwnerModuleCode, type OwnerModuleCode } from '../modules/platform-modules';

import type { NonEmptyReadonlyArray } from './module-scope';
import {
  accountRoleOf,
  isModuleRole,
  type AccountRole,
  type ModuleRole,
  type PlatformRole,
} from './platform-roles';
import type { TenantCapability } from './tenant-capabilities';

/** Mutation, POST and the other writing verbs are `write`; Query, GET and HEAD are `read`. */
export type AccessIntent = 'read' | 'write';

/** No service subject writes (ADR-051 §3). */
export type ServiceIntent = Extract<AccessIntent, 'read'>;

/** The three registers a `scoped` read serves several modules from. */
export type ScopedKind = 'common-registry' | 'workforce' | 'alerts';

/** Module-private data: requires a grant in `module`. */
export interface ModuleAccessSpec {
  readonly kind: 'module';
  readonly module: OwnerModuleCode;
}

/** A register several modules share: returns the caller's ModuleScope. */
export interface ScopedAccessSpec {
  readonly kind: 'scoped';
  readonly scope: ScopedKind;
}

/** The Company projections: read-only, requires `company:view`. */
export interface CompanyAccessSpec {
  readonly kind: 'company';
}

/** The caller's own records (`my*`, DMs). */
export interface SelfAccessSpec {
  readonly kind: 'self';
}

/** Tenant account administration: requires the capability. */
export interface AccountAccessSpec {
  readonly kind: 'account';
  readonly capability: TenantCapability;
}

/** A NATS request no member stands behind: passes a declared sender of the subject only. */
export interface ServiceAccessSpec {
  readonly kind: 'service';
  readonly entry: ServiceSubjectAccess;
}

/** The kinds a member caller can pass. */
export type MemberAccessSpec =
  | ModuleAccessSpec
  | ScopedAccessSpec
  | CompanyAccessSpec
  | SelfAccessSpec
  | AccountAccessSpec;

export type AccessSpec = MemberAccessSpec | ServiceAccessSpec;

export type AccessKind = AccessSpec['kind'];

/**
 * One decision's input. `@Roles` is part of the request only for the kinds that read it,
 * `module` and `scoped` (ADR-051 §1 "passes when"); `[]` means the handler names no role. The
 * other kinds cannot carry roles, so no caller can expect them to be checked there.
 */
export type AccessRequest =
  | {
      readonly spec: ModuleAccessSpec | ScopedAccessSpec;
      readonly intent: AccessIntent;
      readonly roles: readonly PlatformRole[];
    }
  | {
      readonly spec: CompanyAccessSpec | SelfAccessSpec | AccountAccessSpec | ServiceAccessSpec;
      readonly intent: AccessIntent;
    };

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

/** The NATS identities of infrastructure/nats/services.yaml, in its order. */
export const NATS_SERVICE_NAMES = Object.freeze([
  'auth_service',
  'farm_service',
  'sensor_service',
  'sensor-ingestion',
  'admin_api_service',
  'gateway_service',
  'notification_service',
  'ai_service',
  'billing_service',
  'alert_engine',
  'hr_service',
  'messaging_service',
  'hydroponics_service',
  'observability_service',
  'config_service',
  'event_store_service',
  'dlq_replayer',
] as const);

export type NatsServiceName = (typeof NATS_SERVICE_NAMES)[number];

/** Private to this module, so `userCaller` is the only way to make a UserCaller. */
const USER_CALLER: unique symbol = Symbol('UserCaller');

/** A member of a tenant (or SUPER_ADMIN), as a gateway-verified identity describes them. */
export interface UserCaller {
  readonly kind: 'user';
  readonly userId: string;
  /** Null only for SUPER_ADMIN, who acts on the platform. */
  readonly tenantId: string | null;
  /** TENANT_ADMIN or SUPER_ADMIN; null for every other member, whatever `users.role` says. */
  readonly accountRole: AccountRole | null;
  readonly moduleAccess: ModuleAccess;
  /** The `resourcePermissions` claim. */
  readonly capabilities: readonly string[];
  readonly [USER_CALLER]: true;
}

/** A service sending a NATS request in its own name. */
export interface ServiceCaller {
  readonly kind: 'service';
  readonly service: NatsServiceName;
}

export type Caller = UserCaller | ServiceCaller;

/** What a gateway-verified identity carries, as `userCaller` reads it. */
export interface VerifiedMemberIdentity {
  readonly userId: string;
  readonly tenantId: string | null;
  /** `users.role` and `roles[]` exactly as verified; only an account role among them counts. */
  readonly roles: readonly string[];
  /** The `moduleAccess` claim; absent on a token minted before it existed, meaning no grants. */
  readonly moduleAccess?: ModuleAccess;
  /** The `resourcePermissions` claim; absent means none. */
  readonly capabilities?: readonly string[];
}

/**
 * The only constructor of a UserCaller. It copies and freezes what it reads, so a later change to
 * the identity object cannot change a decision already made with the caller.
 */
export function userCaller(identity: VerifiedMemberIdentity): UserCaller {
  const caller: UserCaller = {
    kind: 'user',
    userId: identity.userId,
    tenantId: identity.tenantId,
    accountRole: accountRoleOf(identity.roles),
    moduleAccess: Object.freeze({ ...identity.moduleAccess }),
    capabilities: Object.freeze([...(identity.capabilities ?? [])]),
    [USER_CALLER]: true,
  };
  return Object.freeze(caller);
}

export function serviceCaller(service: NatsServiceName): ServiceCaller {
  return Object.freeze({ kind: 'service', service });
}

/** A gated subject a member stands behind: the spec and intent its responder decides them by. */
export interface UserSubjectAccess {
  readonly caller: 'user';
  readonly spec: MemberAccessSpec;
  readonly intent: AccessIntent;
  readonly senders: NonEmptyReadonlyArray<NatsServiceName>;
}

/** A gated subject only a declared sender may ask, in its own name, read-only. */
export interface ServiceSubjectAccess {
  readonly caller: 'service';
  readonly intent: ServiceIntent;
  readonly senders: NonEmptyReadonlyArray<NatsServiceName>;
}

/** How one gated request subject is decided (ADR-051 §3): one caller kind per subject. */
export type SubjectAccess = UserSubjectAccess | ServiceSubjectAccess;
