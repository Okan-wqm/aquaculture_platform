import type {
  AccountAccessSpec,
  CompanyAccessSpec,
  MemberAccessSpec,
  ModuleAccessSpec,
  OwnerModuleCode,
  ScopedAccessSpec,
  ScopedKind,
  SelfAccessSpec,
  TenantCapability,
} from '@aquaculture/shared-contracts';
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/**
 * `@Access(...)` — what a handler (or every handler of a class) demands, as an ADR-051 access spec
 * (RBAC-HIGH-030, RBAC-HIGH-031).
 *
 * WHY: `@Roles` names a role but no module, so a requirement written for one module was met by a
 * manager of any other (RBAC-HIGH-031), and a handler with no annotation answered every member
 * (RBAC-HIGH-030). In a `module-access` service (security/access-enrolment.ts) every root field and
 * REST handler carries `@Access` or `@Public()`; AccessClassificationGuard denies the rest, and
 * RolesGuard and `@AccessCaller()` decide the spec through `decideAccess`, with `@Roles` checked by
 * kind. The handler's spec overrides the class's.
 *
 * WHAT: one builder per member kind of `AccessSpec` (libs/shared-contracts/src/access):
 *   - `Access.module(m)`: module-private data of owner module m;
 *   - `Access.scoped(k)`: a register several modules share (`common-registry`, `workforce`,
 *     `alerts`), answered with the caller's ModuleScope;
 *   - `Access.company()`: the Company projections, read-only;
 *   - `Access.self()`: the caller's own records;
 *   - `Access.account(capability)`: tenant account administration.
 * The `service` kind is a NATS request no member stands behind; no GraphQL or REST handler
 * declares it.
 */
export const ACCESS_SPEC_KEY = 'access:spec';

function accessSpec(spec: MemberAccessSpec): CustomDecorator<string> {
  return SetMetadata(ACCESS_SPEC_KEY, Object.freeze(spec));
}

function moduleSpec(module: OwnerModuleCode): ModuleAccessSpec {
  return { kind: 'module', module };
}

function scopedSpec(scope: ScopedKind): ScopedAccessSpec {
  return { kind: 'scoped', scope };
}

const COMPANY_SPEC: CompanyAccessSpec = { kind: 'company' };
const SELF_SPEC: SelfAccessSpec = { kind: 'self' };

function accountSpec(capability: TenantCapability): AccountAccessSpec {
  return { kind: 'account', capability };
}

export const Access = Object.freeze({
  module: (module: OwnerModuleCode): CustomDecorator<string> => accessSpec(moduleSpec(module)),
  scoped: (scope: ScopedKind): CustomDecorator<string> => accessSpec(scopedSpec(scope)),
  company: (): CustomDecorator<string> => accessSpec(COMPANY_SPEC),
  self: (): CustomDecorator<string> => accessSpec(SELF_SPEC),
  account: (capability: TenantCapability): CustomDecorator<string> =>
    accessSpec(accountSpec(capability)),
});
