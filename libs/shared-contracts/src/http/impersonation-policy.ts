import {
  canonicalWireJsonSha256V1,
  containsAsciiControlCharacter,
  createCanonicalJsonDocumentV1,
  type CanonicalHashAuthorityV1,
} from '../canonical-json';

/** Canonical non-ambient credential transported from browser to gateway. */
export const IMPERSONATION_CREDENTIAL_HEADER = 'x-impersonation-token' as const;

/** Browser hand-off session coordinate captured and stripped by the gateway. */
export const IMPERSONATION_SESSION_HEADER = 'x-impersonation-session-id' as const;

/** Internal gateway-to-admin request authorization authority. */
export const IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION =
  'impersonation-authorization-receipt/v1' as const;

export const IMPERSONATION_AUTHORIZATION_HTTP_METHODS = Object.freeze([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
] as const);

export type ImpersonationAuthorizationHttpMethod =
  (typeof IMPERSONATION_AUTHORIZATION_HTTP_METHODS)[number];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const AUTHORIZATION_PATH_PATTERN = /^\/(?:[\x21-\x7e]*)$/;

export interface ImpersonationAuthorizationReceiptCoordinateV1 {
  readonly schemaVersion: typeof IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION;
  readonly authorizationReceiptId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly mfaVerified: true;
  readonly effectiveTenantId: string;
  readonly method: ImpersonationAuthorizationHttpMethod;
  readonly normalizedPath: string;
  readonly normalizedQueryHash: string;
  readonly bodyHash: string;
  readonly clientIp: string;
  readonly clientUserAgent: string;
}

const IMPERSONATION_AUTHORIZATION_REQUEST_DIGEST_AUTHORITY: CanonicalHashAuthorityV1 =
  Object.freeze({
    domain: 'aquaculture.impersonation-request-authorization',
    schemaVersion: IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  });

function assertCanonicalAuthorizationCoordinate(
  coordinate: ImpersonationAuthorizationReceiptCoordinateV1,
): void {
  if (coordinate.schemaVersion !== IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION) {
    throw new TypeError('Impersonation authorization receipt version is not canonical');
  }
  if (
    !isImpersonationContextId(coordinate.authorizationReceiptId) ||
    !isImpersonationContextId(coordinate.sessionId) ||
    !isImpersonationContextId(coordinate.actorId) ||
    !isImpersonationContextId(coordinate.effectiveTenantId)
  ) {
    throw new TypeError('Impersonation authorization identity is not canonical');
  }
  if (coordinate.mfaVerified !== true) {
    throw new TypeError('Impersonation authorization requires a verified MFA assertion');
  }
  if (
    !(IMPERSONATION_AUTHORIZATION_HTTP_METHODS as readonly string[]).includes(coordinate.method)
  ) {
    throw new TypeError('Impersonation authorization HTTP method is not canonical');
  }
  if (
    coordinate.normalizedPath.length > 2_048 ||
    !AUTHORIZATION_PATH_PATTERN.test(coordinate.normalizedPath) ||
    coordinate.normalizedPath.includes('?') ||
    coordinate.normalizedPath.includes('#') ||
    coordinate.normalizedPath.includes('\\') ||
    coordinate.normalizedPath.includes('//') ||
    (coordinate.normalizedPath.length > 1 && coordinate.normalizedPath.endsWith('/'))
  ) {
    throw new TypeError('Impersonation authorization path is not canonical');
  }
  if (
    !SHA256_HEX_PATTERN.test(coordinate.normalizedQueryHash) ||
    !SHA256_HEX_PATTERN.test(coordinate.bodyHash)
  ) {
    throw new TypeError('Impersonation authorization content hash is not canonical');
  }
  if (
    coordinate.clientIp.length === 0 ||
    coordinate.clientIp.length > 64 ||
    coordinate.clientUserAgent.length === 0 ||
    coordinate.clientUserAgent.length > 1_024 ||
    coordinate.clientUserAgent.trim() !== coordinate.clientUserAgent ||
    containsAsciiControlCharacter(coordinate.clientUserAgent)
  ) {
    throw new TypeError('Impersonation authorization network identity is not canonical');
  }
}

/**
 * Content-address the exact gateway request authorization coordinate. The raw
 * impersonation credential and request body are deliberately absent: the
 * credential resolves the session under lock and only the canonical body hash
 * crosses the audit boundary.
 */
export function impersonationAuthorizationRequestDigestV1(
  coordinate: ImpersonationAuthorizationReceiptCoordinateV1,
): string {
  assertCanonicalAuthorizationCoordinate(coordinate);
  return canonicalWireJsonSha256V1(
    IMPERSONATION_AUTHORIZATION_REQUEST_DIGEST_AUTHORITY,
    coordinate,
    { maxDepth: 3, maxNodes: 32, maxBytes: 8 * 1_024 },
  );
}

/**
 * One-time browser hand-off fields. They live in the URL fragment so the raw
 * credential is never sent in the initial navigation request or written to a
 * server/proxy access log.
 */
export const IMPERSONATION_HANDOFF_FRAGMENT_FIELDS = Object.freeze({
  sessionId: 'impersonation_session',
  credential: 'impersonation_token',
  targetTenantId: 'tenant_id',
});

/** 32 random bytes encoded as lower-case hexadecimal by admin-api. */
export const IMPERSONATION_CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/;

/** UUIDs emitted by PostgreSQL for both impersonation sessions and tenants. */
export const IMPERSONATION_CONTEXT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ImpersonationPermissionsContract {
  readonly canViewData: boolean;
  readonly canModifyData: boolean;
  readonly canAccessSettings: boolean;
  readonly canManageUsers: boolean;
  readonly canViewBilling: boolean;
  readonly canExportData: boolean;
  readonly restrictedModules?: readonly ImpersonationModule[];
  readonly allowedModules?: readonly ImpersonationModule[];
}

/**
 * Canonical module vocabulary understood by the impersonation boundary.
 *
 * These values are the Apollo subgraph names, not deployment hostnames or UI
 * labels.  Keeping one exact vocabulary prevents an allow-list entry such as
 * `farm-service` from silently meaning something different at another hop.
 */
export const IMPERSONATION_MODULES = Object.freeze([
  'auth',
  'farm',
  'sensor',
  'hr',
  'hydroponics',
  'messaging',
  'alert',
  'billing',
  'notification',
  'config',
  'ai',
] as const);

export type ImpersonationModule = (typeof IMPERSONATION_MODULES)[number];

export const IMPERSONATION_BOOLEAN_GRANTS = Object.freeze([
  'canViewData',
  'canModifyData',
  'canAccessSettings',
  'canManageUsers',
  'canViewBilling',
  'canExportData',
] as const);

export type ImpersonationBooleanGrant = (typeof IMPERSONATION_BOOLEAN_GRANTS)[number];

export const IMPERSONATION_PERMISSION_FIELDS = Object.freeze([
  ...IMPERSONATION_BOOLEAN_GRANTS,
  'restrictedModules',
  'allowedModules',
] as const);

/**
 * Closed operation-to-grant authority.  Every gateway operation is projected
 * onto one of these keys before it can leave the gateway.  Specialized writes
 * require both their domain grant and the explicit write-mode grant so a
 * read-only session can never mutate users, settings, or billing state.
 */
export const IMPERSONATION_OPERATION_GRANT_MAP = Object.freeze({
  'data.read': Object.freeze(['canViewData'] as const),
  'data.write': Object.freeze(['canModifyData'] as const),
  'billing.read': Object.freeze(['canViewBilling'] as const),
  'billing.write': Object.freeze(['canViewBilling', 'canModifyData'] as const),
  'users.read': Object.freeze(['canManageUsers'] as const),
  'users.write': Object.freeze(['canManageUsers', 'canModifyData'] as const),
  'settings.read': Object.freeze(['canAccessSettings'] as const),
  'settings.write': Object.freeze(['canAccessSettings', 'canModifyData'] as const),
  export: Object.freeze(['canExportData'] as const),
});

export type ImpersonationOperationAuthority = keyof typeof IMPERSONATION_OPERATION_GRANT_MAP;

export interface ImpersonationOperationDescriptor {
  readonly authority: ImpersonationOperationAuthority;
  readonly module: ImpersonationModule;
  /** Exact REST route or GraphQL root field used for forensic correlation. */
  readonly operation: string;
}

export const IMPERSONATION_AUTHORIZATION_OPERATION_LIMIT = 128;

function compareAuthorizationOperation(
  left: ImpersonationOperationDescriptor,
  right: ImpersonationOperationDescriptor,
): number {
  const leftKey = `${left.authority}\u0000${left.module}\u0000${left.operation}`;
  const rightKey = `${right.authority}\u0000${right.module}\u0000${right.operation}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Strictly compile the exact gateway-derived operation set into one order. */
export function compileImpersonationAuthorizationOperationsV1(
  value: unknown,
): readonly ImpersonationOperationDescriptor[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > IMPERSONATION_AUTHORIZATION_OPERATION_LIMIT
  ) {
    return undefined;
  }
  const operations: ImpersonationOperationDescriptor[] = [];
  for (const member of value) {
    if (typeof member !== 'object' || member === null || Array.isArray(member)) return undefined;
    const candidate = member as Readonly<Record<string, unknown>>;
    if (
      Object.keys(candidate).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(candidate, 'authority') ||
      !Object.prototype.hasOwnProperty.call(candidate, 'module') ||
      !Object.prototype.hasOwnProperty.call(candidate, 'operation') ||
      !isImpersonationOperationAuthority(candidate.authority) ||
      !isImpersonationModule(candidate.module) ||
      typeof candidate.operation !== 'string' ||
      candidate.operation.length === 0 ||
      candidate.operation.length > 2_048 ||
      candidate.operation.trim() !== candidate.operation ||
      containsAsciiControlCharacter(candidate.operation)
    ) {
      return undefined;
    }
    operations.push({
      authority: candidate.authority,
      module: candidate.module,
      operation: candidate.operation,
    });
  }
  operations.sort(compareAuthorizationOperation);
  if (
    operations.some((operation, index) => {
      const previous = operations[index - 1];
      return previous !== undefined && compareAuthorizationOperation(previous, operation) === 0;
    }) ||
    new Set(operations.map((operation) => `${operation.module}\u0000${operation.operation}`))
      .size !== operations.length
  ) {
    return undefined;
  }
  return Object.freeze(operations.map((operation) => Object.freeze(operation)));
}

/**
 * Decode a persisted operation array without treating JSON object member order
 * as semantic. PostgreSQL jsonb is allowed to reorder object keys, while the
 * operation array order remains part of the protocol. The compiler establishes
 * the exact member shape and canonical sort; this comparison then proves the
 * stored array already has that sort instead of silently normalizing it.
 */
export function decodeCanonicalImpersonationAuthorizationOperationsV1(
  value: unknown,
): readonly ImpersonationOperationDescriptor[] | undefined {
  const canonical = compileImpersonationAuthorizationOperationsV1(value);
  if (!canonical || !Array.isArray(value) || value.length !== canonical.length) {
    return undefined;
  }
  for (const [index, member] of value.entries()) {
    const candidate = member as Readonly<Record<string, unknown>>;
    const expected = canonical[index];
    if (
      expected === undefined ||
      candidate.authority !== expected.authority ||
      candidate.module !== expected.module ||
      candidate.operation !== expected.operation
    ) {
      return undefined;
    }
  }
  return canonical;
}

const IMPERSONATION_AUTHORIZATION_OPERATION_SET_DIGEST_AUTHORITY: CanonicalHashAuthorityV1 =
  Object.freeze({
    domain: 'aquaculture.impersonation-authorization-operation-set',
    schemaVersion: 'impersonation-authorization-operation-set/v1',
  });

export function impersonationAuthorizationOperationSetDigestV1(value: unknown): string {
  const operations = compileImpersonationAuthorizationOperationsV1(value);
  if (!operations) throw new TypeError('Impersonation authorization operation set is invalid');
  return canonicalWireJsonSha256V1(
    IMPERSONATION_AUTHORIZATION_OPERATION_SET_DIGEST_AUTHORITY,
    operations,
    { maxDepth: 3, maxNodes: 512, maxBytes: 64 * 1_024 },
  );
}

export interface ImpersonationAuthorizationDecision {
  readonly allowed: boolean;
  readonly missingGrants: readonly ImpersonationBooleanGrant[];
  readonly deniedModules: readonly ImpersonationModule[];
}

export const DEFAULT_IMPERSONATION_PERMISSIONS: ImpersonationPermissionsContract = Object.freeze({
  canViewData: true,
  canModifyData: false,
  canAccessSettings: false,
  canManageUsers: false,
  canViewBilling: false,
  canExportData: false,
});

export function isImpersonationCredential(value: unknown): value is string {
  return typeof value === 'string' && IMPERSONATION_CREDENTIAL_PATTERN.test(value);
}

export function isImpersonationContextId(value: unknown): value is string {
  return typeof value === 'string' && IMPERSONATION_CONTEXT_ID_PATTERN.test(value);
}

export function isImpersonationAuthorizationHttpMethod(
  value: unknown,
): value is ImpersonationAuthorizationHttpMethod {
  return (
    typeof value === 'string' &&
    (IMPERSONATION_AUTHORIZATION_HTTP_METHODS as readonly string[]).includes(value)
  );
}

export function isImpersonationModule(value: unknown): value is ImpersonationModule {
  return typeof value === 'string' && (IMPERSONATION_MODULES as readonly string[]).includes(value);
}

export function isImpersonationOperationAuthority(
  value: unknown,
): value is ImpersonationOperationAuthority {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(IMPERSONATION_OPERATION_GRANT_MAP, value)
  );
}

function compileModuleList(
  value: unknown,
  requireCanonicalOrder: boolean,
): readonly ImpersonationModule[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;

  const compiled: ImpersonationModule[] = [];
  let previousIndex = -1;
  for (const member of value) {
    if (!isImpersonationModule(member)) return null;
    const currentIndex = IMPERSONATION_MODULES.indexOf(member);
    if (compiled.includes(member)) return null;
    if (requireCanonicalOrder && currentIndex <= previousIndex) return null;
    previousIndex = currentIndex;
    compiled.push(member);
  }
  if (!requireCanonicalOrder) {
    compiled.sort(
      (left, right) => IMPERSONATION_MODULES.indexOf(left) - IMPERSONATION_MODULES.indexOf(right),
    );
  }
  return Object.freeze(compiled);
}

function buildImpersonationPermissions(
  value: unknown,
  requireCanonicalModuleOrder: boolean,
): ImpersonationPermissionsContract | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(candidate).some(
      (field) => !(IMPERSONATION_PERMISSION_FIELDS as readonly string[]).includes(field),
    ) ||
    IMPERSONATION_BOOLEAN_GRANTS.some((grant) => typeof candidate[grant] !== 'boolean')
  ) {
    return undefined;
  }

  const restrictedModules = compileModuleList(
    candidate.restrictedModules,
    requireCanonicalModuleOrder,
  );
  const allowedModules = compileModuleList(candidate.allowedModules, requireCanonicalModuleOrder);
  if (restrictedModules === null || allowedModules === null) return undefined;
  if (
    restrictedModules !== undefined &&
    allowedModules !== undefined &&
    restrictedModules.some((module) => allowedModules.includes(module))
  ) {
    return undefined;
  }

  return Object.freeze({
    canViewData: candidate.canViewData as boolean,
    canModifyData: candidate.canModifyData as boolean,
    canAccessSettings: candidate.canAccessSettings as boolean,
    canManageUsers: candidate.canManageUsers as boolean,
    canViewBilling: candidate.canViewBilling as boolean,
    canExportData: candidate.canExportData as boolean,
    ...(restrictedModules !== undefined ? { restrictedModules } : {}),
    ...(allowedModules !== undefined ? { allowedModules } : {}),
  });
}

/**
 * Producer compiler. Valid module members may arrive in any order; the output
 * is normalized to the frozen authority order. Duplicates, overlap, unknown
 * fields, missing grants, and invalid types fail closed.
 */
export function compileImpersonationPermissionsV1(
  value: unknown,
): ImpersonationPermissionsContract | undefined {
  try {
    return buildImpersonationPermissions(
      createCanonicalJsonDocumentV1(value, {
        maxDepth: 4,
        maxNodes: 64,
        maxBytes: 8 * 1024,
      }).value,
      false,
    );
  } catch {
    return undefined;
  }
}

/**
 * Wire decoder. Signed/stored snapshots must already use the canonical module
 * order; a decoder never repairs non-canonical bytes into a trusted grant.
 */
export function decodeCanonicalImpersonationPermissionsV1(
  value: unknown,
): ImpersonationPermissionsContract | undefined {
  try {
    return buildImpersonationPermissions(
      createCanonicalJsonDocumentV1(value, {
        maxDepth: 4,
        maxNodes: 64,
        maxBytes: 8 * 1024,
      }).value,
      true,
    );
  } catch {
    return undefined;
  }
}

/** Strict decoder shared by admin-api, gateway, and downstream assertions. */
export function isImpersonationPermissionsContract(
  value: unknown,
): value is ImpersonationPermissionsContract {
  return decodeCanonicalImpersonationPermissionsV1(value) !== undefined;
}

/**
 * Evaluate every operation and module restriction without a permissive
 * fallback.  A present-but-empty allowedModules list intentionally denies all
 * modules; restrictedModules always wins over allowedModules.
 */
export function evaluateImpersonationAuthorization(
  permissions: ImpersonationPermissionsContract,
  operations: readonly ImpersonationOperationDescriptor[],
): ImpersonationAuthorizationDecision {
  const missingGrants: ImpersonationBooleanGrant[] = [];
  const deniedModules: ImpersonationModule[] = [];

  for (const operation of operations) {
    for (const grant of IMPERSONATION_OPERATION_GRANT_MAP[operation.authority]) {
      if (!permissions[grant] && !missingGrants.includes(grant)) missingGrants.push(grant);
    }

    const explicitlyRestricted = permissions.restrictedModules?.includes(operation.module) === true;
    const excludedByAllowList =
      permissions.allowedModules !== undefined &&
      !permissions.allowedModules.includes(operation.module);
    if (explicitlyRestricted || excludedByAllowList) {
      if (!deniedModules.includes(operation.module)) deniedModules.push(operation.module);
    }
  }

  return Object.freeze({
    allowed: missingGrants.length === 0 && deniedModules.length === 0,
    missingGrants: Object.freeze(missingGrants),
    deniedModules: Object.freeze(deniedModules),
  });
}
