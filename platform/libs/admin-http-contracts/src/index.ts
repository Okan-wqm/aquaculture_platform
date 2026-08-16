/**
 * Browser-safe application and wire contracts for the admin REST boundary.
 *
 * Pagination comes from the neutral platform authority shared with backend
 * GraphQL. The HTTP envelope is independently versioned and decoded
 * fail-closed, so transport evolution cannot silently change the application
 * model.
 */

import {
  createStandardPaginatedResult,
  expectedTotalPages,
  type StandardPaginatedResult,
} from '@platform/pagination-contracts';
import { isPlatformRole, type Role } from '@platform/identity';
import { isTenantPermissionCode, type TenantPermissionCode } from '@platform/tenant-permissions';

import {
  ADMIN_JSON_DECODER_CATALOG,
  ADMIN_SCHEMALESS_JSON_REASONS,
  adminJsonDecoderDefinitionFor,
  type AdminJsonDecoderDefinitionV1,
  type AdminJsonDecoderId,
  type AdminJsonDecoderOwner,
  type AdminSchemalessJsonReason,
} from './json-decoder-catalog';
import { ADMIN_RESERVED_REQUEST_HEADER_NAMES } from './route-policy';

export {
  ADMIN_JSON_CODEC_POLICY_ID,
  ADMIN_JSON_DECODER_CATALOG,
  ADMIN_JSON_DECODER_CATALOG_SCHEMA_VERSION,
  ADMIN_JSON_DECODER_ROOT_POLICIES,
  ADMIN_SCHEMALESS_JSON_REASONS,
  adminJsonDecoderDefinitionFor,
  validateAdminJsonDecoderCatalogV1,
  type AdminJsonDecoderCatalogV1,
  type AdminJsonDecoderDefinitionV1,
  type AdminJsonDecoderId,
  type AdminJsonDecoderOwner,
  type AdminJsonDecoderRootPolicy,
  type AdminSchemalessJsonReason,
} from './json-decoder-catalog';

export {
  ADMIN_HTTP_ROUTE_POLICY,
  ADMIN_RESERVED_REQUEST_HEADER_NAMES,
  adminLogicalRoutePathFromMetadata,
  adminNetworkAliases,
  assertSupportedAdminRoutePathSegment,
  assertCanonicalAdminRequestTarget,
  type AdminHttpRoutePolicy,
} from './route-policy';

export {
  ADMIN_SQL_IDENTIFIER_CATALOG,
  SQL_IDENTIFIER_CATALOG_SCHEMA_VERSION,
  adminSqlIdentifierKeys,
  resolveAdminSqlIdentifier,
  validateSqlIdentifierCatalogV1,
  type AdminSqlIdentifierKey,
  type AdminSqlIdentifierRouteId,
  type SqlIdentifierCatalogEntryV1,
  type SqlIdentifierCatalogV1,
} from './sql-identifier-catalog';

export {
  ADMIN_AUDIT_ACTION_CATALOG,
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_AUTHORITY_SCHEMA_VERSION,
  ADMIN_AUDIT_HTTP_ROUTES,
  ADMIN_AUDIT_LEGACY_PROVENANCE_SCHEMA_VERSION,
  ADMIN_AUDIT_LEGACY_SOURCES,
  ADMIN_AUDIT_LEGACY_SOURCE,
  ADMIN_AUDIT_SEVERITY,
  ADMIN_AUDIT_TRUST_CLASS,
  ADMIN_AUDIT_TRUST_CLASSES,
  ADMIN_AUDIT_WRITE_POLICY,
  adminAuditActionsForPolicy,
  adminAuditDefinition,
  isAdminAuditAction,
  isAdminAuditSeverity,
  type ActiveAdminAuditAction,
  type AdminAuditAction,
  type AdminAuditActionDefinitionV1,
  type AdminAuditActionForPolicy,
  type AdminAuditHttpRoute,
  type AdminAuditLegacyProvenanceV1,
  type AdminAuditLegacySource,
  type AdminAuditSeverity,
  type AdminAuditTrustClass,
  type AdminAuditWritePolicy,
} from './audit-authority';

export {
  createStandardPaginatedResult,
  type StandardPaginatedResult,
} from '@platform/pagination-contracts';

export const ADMIN_HTTP_CONTRACT_VERSION = 'admin-http.v1' as const;
export const ADMIN_HTTP_ERROR_CONTRACT_VERSION = 'admin-http-error.v1' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isJsonValueArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * The single structural resource budget for every admin JSON boundary.
 * Route decoders may narrow semantic shape, but never invent another set of
 * recursion or allocation limits.
 */
export const ADMIN_JSON_CODEC_POLICY = Object.freeze({
  maxWireBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 10_000,
  maxObjectKeys: 256,
  maxArrayItems: 4_096,
  maxStringBytes: 262_144,
  maxKeyBytes: 256,
} as const);

const ADMIN_JSON_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export interface AdminPaginationMetadataV1 {
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
}

export interface AdminHttpMetadataV1 {
  readonly timestamp: string;
  readonly requestId: string;
  readonly pagination?: AdminPaginationMetadataV1;
}

export interface AdminHttpSuccessEnvelopeV1<T extends JsonValue = JsonValue> {
  readonly contractVersion: typeof ADMIN_HTTP_CONTRACT_VERSION;
  readonly success: true;
  readonly data: T;
  readonly meta: AdminHttpMetadataV1;
}

export const ADMIN_HTTP_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'GONE',
  'VALIDATION_FAILED',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMITED',
  'DATABASE_CONFLICT',
  'DATABASE_REFERENCE_MISSING',
  'DATABASE_REQUIRED_VALUE_MISSING',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  'NOT_IMPLEMENTED',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
] as const;

export type AdminHttpErrorCode = (typeof ADMIN_HTTP_ERROR_CODES)[number];

export const ADMIN_HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<AdminHttpErrorCode, number>> =
  Object.freeze({
    BAD_REQUEST: 400,
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    CONFLICT: 409,
    GONE: 410,
    VALIDATION_FAILED: 400,
    UNPROCESSABLE_ENTITY: 422,
    RATE_LIMITED: 429,
    DATABASE_CONFLICT: 409,
    DATABASE_REFERENCE_MISSING: 400,
    DATABASE_REQUIRED_VALUE_MISSING: 400,
    DATABASE_ERROR: 500,
    INTERNAL_ERROR: 500,
    NOT_IMPLEMENTED: 501,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
  });

export const ADMIN_HTTP_DEFAULT_CODE_BY_STATUS: Readonly<
  Partial<Record<number, AdminHttpErrorCode>>
> = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
});

export interface AdminHttpErrorDetailV1 {
  readonly status: number;
  readonly code: AdminHttpErrorCode;
  readonly message: string;
  readonly timestamp: string;
  readonly path: string;
  readonly requestId: string;
  readonly details?: JsonValue;
}

export interface AdminHttpErrorEnvelopeV1 {
  readonly contractVersion: typeof ADMIN_HTTP_ERROR_CONTRACT_VERSION;
  readonly success: false;
  readonly error: AdminHttpErrorDetailV1;
}

export interface WireDecoder<T> {
  readonly contractName: string;
  decode(value: JsonValue, path?: string): T;
}

export type AdminHttpMethod =
  | 'ALL'
  | 'DELETE'
  | 'GET'
  | 'HEAD'
  | 'OPTIONS'
  | 'PATCH'
  | 'POST'
  | 'PUT';

/**
 * Request headers owned by the transport kernel. A route contract may never
 * re-declare them as caller input, because doing so would let encoded data
 * replace authentication, correlation, representation, or browser-origin
 * controls.
 */
export type AdminQueryCodecV1 = 'comma-separated' | 'repeated' | 'scalar';

export type AdminQueryCodecMap<TContract extends AdminRequestObjectContract> = Readonly<{
  [TKey in keyof TContract['fields']]: AdminQueryCodecV1;
}>;

/** Structural object-schema constraint that preserves every concrete field map. */
export interface AdminRequestObjectContract extends AdminResponseContract<unknown, unknown> {
  readonly kind: 'object';
  readonly fields: AdminResponseShape;
}

export interface AdminRouteRequestContract<
  TPath extends AdminRequestObjectContract = AdminRequestObjectContract,
  TQuery extends AdminRequestObjectContract = AdminRequestObjectContract,
  TQueryCodecs extends AdminQueryCodecMap<TQuery> = AdminQueryCodecMap<TQuery>,
  THeaders extends AdminRequestObjectContract = AdminRequestObjectContract,
  TBody extends AdminResponseContract<unknown, unknown> = AdminResponseContract<unknown, unknown>,
> {
  readonly path: TPath;
  readonly query: TQuery;
  readonly queryCodecs: TQueryCodecs;
  readonly headers: THeaders;
  readonly body: TBody;
  readonly contentType: 'application/json' | null;
}

export type AdminServerRequestContractCatalogV1 = Readonly<
  Record<string, AdminRouteRequestContract>
>;

export interface AdminRouteAuthorizationV1 {
  readonly authentication: 'bearer-session' | 'public';
  readonly requiredRoles: readonly Role[];
  readonly requiredPermissions: readonly TenantPermissionCode[];
  readonly permissionMode: 'all';
}

export type AdminServerRouteAuthorizationCatalogV1 = Readonly<
  Record<string, AdminRouteAuthorizationV1>
>;

const ADMIN_ROUTE_AUTHORIZATION_VALUES = new WeakSet<object>();

function isCreatedAdminRouteAuthorizationV1(value: unknown): value is AdminRouteAuthorizationV1 {
  return typeof value === 'object' && value !== null && ADMIN_ROUTE_AUTHORIZATION_VALUES.has(value);
}

export function createAdminRouteAuthorizationV1(
  authentication: AdminRouteAuthorizationV1['authentication'],
  requiredRoles: readonly Role[],
  requiredPermissions: readonly TenantPermissionCode[],
): AdminRouteAuthorizationV1 {
  if (authentication !== 'public' && authentication !== 'bearer-session') {
    throw new TypeError('admin route authorization contains an unknown authentication mode');
  }
  if (authentication === 'public' && (requiredRoles.length > 0 || requiredPermissions.length > 0)) {
    throw new TypeError('public admin routes cannot declare role or permission requirements');
  }
  if (authentication === 'bearer-session' && requiredRoles.length === 0) {
    throw new TypeError('authenticated admin routes require at least one canonical role');
  }
  if (!requiredRoles.every(isPlatformRole)) {
    throw new TypeError('admin route authorization contains an unknown role');
  }
  if (!requiredPermissions.every(isTenantPermissionCode)) {
    throw new TypeError('admin route authorization contains an unknown tenant capability');
  }
  if (new Set(requiredRoles).size !== requiredRoles.length) {
    throw new TypeError('admin route authorization contains duplicate roles');
  }
  if (new Set(requiredPermissions).size !== requiredPermissions.length) {
    throw new TypeError('admin route authorization contains duplicate permissions');
  }
  const authorization = Object.freeze({
    authentication,
    requiredRoles: Object.freeze([...requiredRoles]),
    requiredPermissions: Object.freeze([...requiredPermissions]),
    permissionMode: 'all',
  });
  ADMIN_ROUTE_AUTHORIZATION_VALUES.add(authorization);
  return authorization;
}

function validatedAdminRouteAuthorizationV1(value: unknown): AdminRouteAuthorizationV1 {
  if (isCreatedAdminRouteAuthorizationV1(value)) return value;
  if (!isUnknownRecord(value)) {
    throw new TypeError('admin route authorization must be a canonical object');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ['authentication', 'permissionMode', 'requiredPermissions', 'requiredRoles'];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError('admin route authorization must contain exactly the canonical fields');
  }
  if (value.authentication !== 'public' && value.authentication !== 'bearer-session') {
    throw new TypeError('admin route authorization contains an unknown authentication mode');
  }
  if (value.permissionMode !== 'all') {
    throw new TypeError('admin route authorization contains an unknown permission mode');
  }
  const requiredRoles = value.requiredRoles;
  if (!isUnknownArray(requiredRoles) || !requiredRoles.every(isPlatformRole)) {
    throw new TypeError('admin route authorization contains an unknown role');
  }
  const requiredPermissions = value.requiredPermissions;
  if (!isUnknownArray(requiredPermissions) || !requiredPermissions.every(isTenantPermissionCode)) {
    throw new TypeError('admin route authorization contains an unknown tenant capability');
  }
  return createAdminRouteAuthorizationV1(value.authentication, requiredRoles, requiredPermissions);
}

type RequiredAdminObjectKeys<TContract extends AdminRequestObjectContract> = {
  [TKey in keyof TContract['fields']]: undefined extends AdminResponseOf<TContract['fields'][TKey]>
    ? never
    : TKey;
}[keyof TContract['fields']];

type AdminUriInputOf<TContract extends AdminResponseContract<unknown, unknown>> =
  TContract extends AdminStringResponseContract
    ? string | number | boolean
    : TContract extends AdminNumberResponseContract
      ? number
      : TContract extends AdminBooleanResponseContract
        ? boolean
        : TContract extends AdminDateStringResponseContract
          ? Date | string
          : TContract extends AdminLiteralResponseContract<infer TValue>
            ? TValue
            : TContract extends AdminOptionalResponseContract<infer TValue>
              ? AdminUriInputOf<TValue> | undefined
              : TContract extends AdminNullableResponseContract<infer TValue>
                ? AdminUriInputOf<TValue> | null
                : TContract extends AdminArrayResponseContract<infer TItem>
                  ? readonly AdminUriInputOf<TItem>[]
                  : TContract extends AdminUnionResponseContract<infer TVariants>
                    ? AdminUriInputOf<TVariants[number]>
                    : AdminResponseOf<TContract>;

type AdminUriObjectInput<TContract extends AdminRequestObjectContract> = {
  readonly [TKey in RequiredAdminObjectKeys<TContract>]: AdminUriInputOf<TContract['fields'][TKey]>;
} & {
  readonly [TKey in Exclude<
    keyof TContract['fields'],
    RequiredAdminObjectKeys<TContract>
  >]?: Exclude<AdminUriInputOf<TContract['fields'][TKey]>, undefined>;
};

type AdminQueryInputOf<
  TContract extends AdminResponseContract<unknown, unknown>,
  TCodec extends AdminQueryCodecV1,
> = TCodec extends 'scalar'
  ? AdminUriInputOf<TContract>
  : readonly Exclude<
      AdminUriInputOf<
        TCodec extends 'repeated'
          ? TContract extends AdminOptionalResponseContract<infer TOptional>
            ? TOptional extends AdminArrayResponseContract<infer TItem>
              ? TItem
              : TOptional
            : TContract extends AdminArrayResponseContract<infer TItem>
              ? TItem
              : TContract
          : TContract extends AdminOptionalResponseContract<infer TOptional>
            ? TOptional
            : TContract
      >,
      undefined
    >[];

type AdminQueryObjectInput<
  TContract extends AdminRequestObjectContract,
  TCodecs extends Readonly<Record<string, AdminQueryCodecV1>>,
> = {
  readonly [TKey in RequiredAdminObjectKeys<TContract>]: AdminQueryInputOf<
    TContract['fields'][TKey],
    TCodecs[Extract<TKey, string>]
  >;
} & {
  readonly [TKey in Exclude<
    keyof TContract['fields'],
    RequiredAdminObjectKeys<TContract>
  >]?: Exclude<
    AdminQueryInputOf<TContract['fields'][TKey], TCodecs[Extract<TKey, string>]>,
    undefined
  >;
};

type AdminUriRequestObjectSection<
  TName extends string,
  TContract extends AdminRequestObjectContract,
> = keyof TContract['fields'] extends never
  ? unknown
  : RequiredAdminObjectKeys<TContract> extends never
    ? { readonly [TKey in TName]?: AdminUriObjectInput<TContract> }
    : { readonly [TKey in TName]: AdminUriObjectInput<TContract> };

type AdminQueryRequestSection<
  TContract extends AdminRequestObjectContract,
  TCodecs extends Readonly<Record<string, AdminQueryCodecV1>>,
> = keyof TContract['fields'] extends never
  ? unknown
  : RequiredAdminObjectKeys<TContract> extends never
    ? { readonly query?: AdminQueryObjectInput<TContract, TCodecs> }
    : { readonly query: AdminQueryObjectInput<TContract, TCodecs> };

type AdminHeaderRequestSection<TContract extends AdminRequestObjectContract> =
  keyof TContract['fields'] extends never
    ? unknown
    : RequiredAdminObjectKeys<TContract> extends never
      ? { readonly headers?: AdminResponseOf<TContract> }
      : { readonly headers: AdminResponseOf<TContract> };

type AdminRequestBodySection<TContract extends AdminResponseContract<unknown, unknown>> =
  TContract extends AdminVoidResponseContract
    ? unknown
    : undefined extends AdminResponseOf<TContract>
      ? { readonly body?: Exclude<AdminResponseOf<TContract>, undefined> }
      : { readonly body: AdminResponseOf<TContract> };

/** Route-shaped caller input. Coordinates, headers and body are all inferred from the backend DAG. */
export type AdminRouteRequestInput<TRequest extends AdminRouteRequestContract> =
  AdminUriRequestObjectSection<'path', TRequest['path']> &
    AdminQueryRequestSection<TRequest['query'], TRequest['queryCodecs']> &
    AdminHeaderRequestSection<TRequest['headers']> &
    AdminRequestBodySection<TRequest['body']> & {
      /** Cancellation is an operation signal, never a transport-policy override. */
      readonly signal?: AbortSignal;
    };

export type AdminRouteRequestArguments<TRequest extends AdminRouteRequestContract> =
  Record<string, never> extends AdminRouteRequestInput<TRequest>
    ? readonly [input?: AdminRouteRequestInput<TRequest>]
    : readonly [input: AdminRouteRequestInput<TRequest>];

export interface AdminRouteClientPolicy {
  readonly authentication: 'bearer-session' | 'public';
  readonly requiredRoles: readonly Role[];
  readonly requiredPermissions: readonly TenantPermissionCode[];
  readonly permissionMode: 'all';
  readonly tenantScope: 'platform';
  readonly csrf: 'forbidden' | 'required';
  readonly mediaType: 'application/json' | null;
  readonly successStatusCodes: readonly number[];
  readonly successMediaType: 'application/json' | null;
  readonly deadlineMs: number;
  readonly retry:
    | {
        readonly mode: 'none';
      }
    | {
        readonly mode: 'safe-exponential';
        readonly maxRetries: number;
        readonly baseDelayMs: number;
        readonly maxDelayMs: number;
      };
  readonly callerHeaderNames: readonly string[];
}

export interface EncodedAdminRouteRequest {
  readonly endpoint: string;
  readonly method: AdminHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * Browser-facing route authority emitted from the backend executable contract
 * DAG.  The route identity and decoder travel together so callers cannot pick
 * an arbitrary TypeScript generic for an unrelated endpoint.
 */
export interface AdminRouteDefinition<
  TContract extends AdminResponseContract<unknown, unknown>,
  TMethod extends AdminHttpMethod = AdminHttpMethod,
  TPath extends `/${string}` | '/' = `/${string}` | '/',
  TRequest extends AdminRouteRequestContract = AdminRouteRequestContract,
> {
  readonly transport: 'json-envelope';
  readonly id: `${TMethod} ${TPath}`;
  readonly method: TMethod;
  readonly path: TPath;
  readonly request: TRequest;
  readonly policy: AdminRouteClientPolicy;
  readonly contract: TContract;
  encode(input: AdminRouteRequestInput<TRequest> | undefined): EncodedAdminRouteRequest;
  decode(value: unknown): AdminWireResponseOf<TContract>;
}

/** Closed descriptor for the only non-envelope browser transport. */
export interface AdminBinaryRouteDefinition<
  TProfile extends AdminBinaryResponseProfile = AdminBinaryResponseProfile,
  TMethod extends AdminHttpMethod = AdminHttpMethod,
  TPath extends `/${string}` | '/' = `/${string}` | '/',
  TRequest extends AdminRouteRequestContract = AdminRouteRequestContract,
> {
  readonly transport: 'binary-download';
  readonly id: `${TMethod} ${TPath}`;
  readonly method: TMethod;
  readonly path: TPath;
  readonly request: TRequest;
  readonly policy: AdminRouteClientPolicy;
  readonly profile: TProfile;
  encode(input: AdminRouteRequestInput<TRequest> | undefined): EncodedAdminRouteRequest;
}

export const ADMIN_BINARY_MEDIA_TYPES = [
  'application/json',
  'application/pdf',
  'text/csv',
  'text/csv; charset=utf-8',
] as const;

export type AdminBinaryMediaType = (typeof ADMIN_BINARY_MEDIA_TYPES)[number];

/** Hard ceiling; each binary route must declare a narrower/equal exact budget. */
export const ADMIN_BINARY_ABSOLUTE_MAX_BYTES = 67_108_864 as const;

export const ADMIN_BINARY_MEDIA_TYPE_BY_FORMAT = Object.freeze({
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
} as const);

export type AdminBinaryArtifactFormat = keyof typeof ADMIN_BINARY_MEDIA_TYPE_BY_FORMAT;
export type AdminBinaryArtifactMediaType =
  (typeof ADMIN_BINARY_MEDIA_TYPE_BY_FORMAT)[AdminBinaryArtifactFormat];

export function adminBinaryMediaTypeForFormat<TFormat extends AdminBinaryArtifactFormat>(
  format: TFormat,
): (typeof ADMIN_BINARY_MEDIA_TYPE_BY_FORMAT)[TFormat] {
  return ADMIN_BINARY_MEDIA_TYPE_BY_FORMAT[format];
}

export function decodeAdminBinaryArtifactMediaType(value: unknown): AdminBinaryArtifactMediaType {
  const mediaType = Object.values(ADMIN_BINARY_MEDIA_TYPE_BY_FORMAT).find(
    (candidate) => candidate === value,
  );
  if (mediaType === undefined) {
    throw new AdminHttpContractError(
      '$.mediaType',
      'value is outside the closed admin artifact media catalog',
    );
  }
  return mediaType;
}

export interface AdminHealthResponseProfile<
  TBody extends AdminResponseContract<unknown, unknown> = AdminResponseContract<unknown, unknown>,
> {
  readonly kind: 'health-response';
  readonly transport: 'frontend-external';
  readonly statusCodes: readonly number[];
  readonly body: TBody;
}

export interface AdminBinaryResponseProfile<
  TMediaType extends AdminBinaryMediaType = AdminBinaryMediaType,
  TMaxBytes extends number = number,
> {
  readonly kind: 'binary-download';
  readonly transport: 'binary-download';
  readonly statusCodes: readonly number[];
  readonly mediaTypes: readonly TMediaType[];
  readonly maxBytes: TMaxBytes;
  readonly disposition: 'attachment-with-filename';
}

export type AdminManualResponseProfile = AdminHealthResponseProfile | AdminBinaryResponseProfile;

export class AdminHttpContractError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'AdminHttpContractError';
  }
}

declare const ADMIN_ATTACHMENT_FILENAME_BRAND: unique symbol;
export type AdminAttachmentFilename = string & {
  readonly [ADMIN_ATTACHMENT_FILENAME_BRAND]: true;
};

const ADMIN_ATTACHMENT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;

export function decodeAdminAttachmentFilename(value: unknown): AdminAttachmentFilename {
  if (
    typeof value !== 'string' ||
    !ADMIN_ATTACHMENT_FILENAME_PATTERN.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new AdminHttpContractError(
      '$.filename',
      'expected an ASCII-safe attachment basename (1-180 characters)',
    );
  }
  return value as AdminAttachmentFilename;
}

export function createAdminAttachmentFilename(value: string): AdminAttachmentFilename {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 180);
  return decodeAdminAttachmentFilename(normalized.length === 0 ? 'download' : normalized);
}

export function encodeAdminAttachmentDisposition(filename: AdminAttachmentFilename): string {
  return `attachment; filename="${decodeAdminAttachmentFilename(filename)}"`;
}

export function decodeAdminAttachmentDisposition(value: unknown): AdminAttachmentFilename {
  if (typeof value !== 'string') {
    throw new AdminHttpContractError(
      '$.headers.content-disposition',
      'expected an attachment disposition',
    );
  }
  const match = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,179})"$/.exec(value);
  if (match?.[1] === undefined) {
    throw new AdminHttpContractError(
      '$.headers.content-disposition',
      'expected the canonical quoted attachment disposition without extra parameters',
    );
  }
  return decodeAdminAttachmentFilename(match[1]);
}

function assertInteger(value: number, path: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AdminHttpContractError(path, `expected a safe integer >= ${minimum}`);
  }
}

const STANDARD_PAGE_KEYS = [
  'items',
  'total',
  'page',
  'limit',
  'totalPages',
  'hasNextPage',
  'hasPreviousPage',
] as const;

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeRecord(value: JsonValue, path: string): { readonly [key: string]: JsonValue } {
  if (!isJsonRecord(value)) {
    throw new AdminHttpContractError(path, 'expected an object');
  }
  return value;
}

function assertExactKeys(
  value: { readonly [key: string]: JsonValue },
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new AdminHttpContractError(
      path,
      `expected keys [${canonical.join(', ')}], received [${actual.join(', ')}]`,
    );
  }
}

function decodeString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string') {
    throw new AdminHttpContractError(path, 'expected a string');
  }
  return value;
}

function decodeNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdminHttpContractError(path, 'expected a finite number');
  }
  return value;
}

function decodeBoolean(value: JsonValue | undefined, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AdminHttpContractError(path, 'expected a boolean');
  }
  return value;
}

function decodeTimestamp(value: JsonValue | undefined, path: string): string {
  const timestamp = decodeString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new AdminHttpContractError(path, 'expected an RFC 3339 UTC millisecond timestamp');
  }
  return timestamp;
}

function containsDisallowedControlCharacter(value: string, allowJsonWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    const allowedWhitespace =
      allowJsonWhitespace && (codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d);
    if ((codeUnit <= 0x1f && !allowedWhitespace) || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodedJsonStringByteLength(value: string): number {
  // JSON.stringify on a primitive string cannot invoke application code.
  return utf8ByteLength(JSON.stringify(value));
}

function jsonPathField(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

interface JsonDecodeState {
  readonly activeObjects: WeakSet<object>;
  nodes: number;
  wireBytes: number;
}

function consumeJsonWireBytes(state: JsonDecodeState, bytes: number, path: string): void {
  state.wireBytes += bytes;
  if (state.wireBytes > ADMIN_JSON_CODEC_POLICY.maxWireBytes) {
    throw new AdminHttpContractError(
      path,
      `JSON value exceeds ${ADMIN_JSON_CODEC_POLICY.maxWireBytes} UTF-8 wire bytes`,
    );
  }
}

function visitJsonValue(
  value: unknown,
  path: string,
  depth: number,
  state: JsonDecodeState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > ADMIN_JSON_CODEC_POLICY.maxNodes) {
    throw new AdminHttpContractError(
      path,
      `JSON value exceeds ${ADMIN_JSON_CODEC_POLICY.maxNodes} nodes`,
    );
  }
  if (depth > ADMIN_JSON_CODEC_POLICY.maxDepth) {
    throw new AdminHttpContractError(
      path,
      `JSON value exceeds depth ${ADMIN_JSON_CODEC_POLICY.maxDepth}`,
    );
  }

  if (value === null) {
    consumeJsonWireBytes(state, 4, path);
    return null;
  }
  if (typeof value === 'boolean') {
    consumeJsonWireBytes(state, value ? 4 : 5, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AdminHttpContractError(path, 'JSON numbers must be finite');
    }
    consumeJsonWireBytes(state, utf8ByteLength(String(value)), path);
    return value;
  }
  if (typeof value === 'string') {
    if (hasUnpairedUtf16Surrogate(value)) {
      throw new AdminHttpContractError(path, 'JSON strings may not contain lone UTF-16 surrogates');
    }
    const stringBytes = utf8ByteLength(value);
    if (stringBytes > ADMIN_JSON_CODEC_POLICY.maxStringBytes) {
      throw new AdminHttpContractError(
        path,
        `JSON string exceeds ${ADMIN_JSON_CODEC_POLICY.maxStringBytes} UTF-8 bytes`,
      );
    }
    consumeJsonWireBytes(state, encodedJsonStringByteLength(value), path);
    return value;
  }
  if (typeof value === 'bigint') {
    throw new AdminHttpContractError(path, 'BigInt has no JSON wire representation');
  }
  if (typeof value !== 'object' || value === null) {
    throw new AdminHttpContractError(path, 'value is not JSON-serializable');
  }
  if (state.activeObjects.has(value)) {
    throw new AdminHttpContractError(path, 'cyclic JSON values are forbidden');
  }

  state.activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > ADMIN_JSON_CODEC_POLICY.maxArrayItems) {
        throw new AdminHttpContractError(
          path,
          `JSON array exceeds ${ADMIN_JSON_CODEC_POLICY.maxArrayItems} entries`,
        );
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
          throw new AdminHttpContractError(path, 'JSON arrays may contain only indexed values');
        }
      }
      consumeJsonWireBytes(state, 2 + Math.max(0, value.length - 1), path);
      const decoded: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new AdminHttpContractError(
            `${path}[${index}]`,
            'sparse arrays and accessor elements are forbidden',
          );
        }
        decoded.push(visitJsonValue(descriptor.value, `${path}[${index}]`, depth + 1, state));
      }
      return Object.freeze(decoded);
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AdminHttpContractError(
        path,
        'JSON objects must have Object.prototype or a null prototype',
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new AdminHttpContractError(path, 'JSON objects may not contain symbol keys');
    }
    if (keys.length > ADMIN_JSON_CODEC_POLICY.maxObjectKeys) {
      throw new AdminHttpContractError(
        path,
        `JSON object exceeds ${ADMIN_JSON_CODEC_POLICY.maxObjectKeys} keys`,
      );
    }
    consumeJsonWireBytes(state, 2 + Math.max(0, keys.length - 1), path);
    const decoded = mutableNullPrototypeRecord<JsonValue>();
    for (const key of keys as string[]) {
      const fieldPath = jsonPathField(path, key);
      if (ADMIN_JSON_FORBIDDEN_KEYS.has(key)) {
        throw new AdminHttpContractError(fieldPath, 'prototype-mutating JSON key is forbidden');
      }
      if (hasUnpairedUtf16Surrogate(key)) {
        throw new AdminHttpContractError(
          fieldPath,
          'JSON keys may not contain lone UTF-16 surrogates',
        );
      }
      if (utf8ByteLength(key) > ADMIN_JSON_CODEC_POLICY.maxKeyBytes) {
        throw new AdminHttpContractError(
          fieldPath,
          `JSON key exceeds ${ADMIN_JSON_CODEC_POLICY.maxKeyBytes} UTF-8 bytes`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new AdminHttpContractError(
          fieldPath,
          'JSON fields must be enumerable own data properties',
        );
      }
      consumeJsonWireBytes(state, encodedJsonStringByteLength(key) + 1, fieldPath);
      decoded[key] = visitJsonValue(descriptor.value, fieldPath, depth + 1, state);
    }
    return Object.freeze(decoded);
  } finally {
    state.activeObjects.delete(value);
  }
}

export function decodeJsonValue(value: unknown, path = '$'): JsonValue {
  return visitJsonValue(value, path, 0, {
    activeObjects: new WeakSet<object>(),
    nodes: 0,
    wireBytes: 0,
  });
}

export function parseJsonValue(text: string): JsonValue {
  if (typeof text !== 'string') {
    throw new AdminHttpContractError('$', 'JSON input must be text');
  }
  const wireBytes = utf8ByteLength(text);
  if (wireBytes > ADMIN_JSON_CODEC_POLICY.maxWireBytes) {
    throw new AdminHttpContractError(
      '$',
      `JSON input exceeds ${ADMIN_JSON_CODEC_POLICY.maxWireBytes} UTF-8 wire bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AdminHttpContractError('$', 'malformed JSON input');
  }
  return decodeJsonValue(parsed);
}

export function toJsonValue(value: unknown): JsonValue {
  return decodeJsonValue(value);
}

export function decodeAdminRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) {
    throw new AdminHttpContractError(
      '$.requestId',
      'expected an 8-128 character request identifier',
    );
  }
  return value;
}

export function decodeBoundedAdminErrorDetails(value: unknown): JsonValue {
  return decodeJsonValue(value, '$.error.details');
}

function decodeAdminErrorPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !value.startsWith('/') ||
    value.includes('?') ||
    value.includes('#') ||
    containsDisallowedControlCharacter(value, false)
  ) {
    throw new AdminHttpContractError(
      '$.error.path',
      'expected a sanitized route path without query or fragment data',
    );
  }
  return value;
}

function decodeAdminErrorMessage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    containsDisallowedControlCharacter(value, true)
  ) {
    throw new AdminHttpContractError('$.error.message', 'expected a bounded printable message');
  }
  return value;
}

function decodeAdminErrorDetails(code: AdminHttpErrorCode, value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (code !== 'VALIDATION_FAILED') {
    throw new AdminHttpContractError(
      '$.error.details',
      `details are not defined for error code ${code}`,
    );
  }
  const details = decodeRecord(decodeJsonValue(value), '$.error.details');
  assertExactKeys(details, ['validationMessages'], '$.error.details');
  const messages = details.validationMessages;
  if (
    !isStringArray(messages) ||
    messages.length === 0 ||
    messages.length > 50 ||
    messages.some(
      (message) =>
        message.length === 0 ||
        message.length > 512 ||
        containsDisallowedControlCharacter(message, true),
    )
  ) {
    throw new AdminHttpContractError(
      '$.error.details.validationMessages',
      'expected 1-50 bounded printable validation messages',
    );
  }
  return Object.freeze({ validationMessages: Object.freeze([...messages]) });
}

export function decodeAdminHttpErrorEnvelopeV1(value: unknown): AdminHttpErrorEnvelopeV1 {
  const envelope = decodeRecord(decodeJsonValue(value), '$');
  assertExactKeys(envelope, ['contractVersion', 'success', 'error'], '$');
  if (envelope.contractVersion !== ADMIN_HTTP_ERROR_CONTRACT_VERSION) {
    throw new AdminHttpContractError(
      '$.contractVersion',
      `expected ${ADMIN_HTTP_ERROR_CONTRACT_VERSION}`,
    );
  }
  if (envelope.success !== false) {
    throw new AdminHttpContractError('$.success', 'expected false');
  }
  const error = decodeRecord(envelope.error ?? null, '$.error');
  const allowedKeys = ['status', 'code', 'message', 'timestamp', 'path', 'requestId'];
  if (error.details !== undefined) allowedKeys.push('details');
  assertExactKeys(error, allowedKeys, '$.error');
  const status = decodeNumber(error.status, '$.error.status');
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
    throw new AdminHttpContractError('$.error.status', 'expected an HTTP error status');
  }
  const code = decodeString(error.code, '$.error.code');
  if (!ADMIN_HTTP_ERROR_CODES.includes(code as AdminHttpErrorCode)) {
    throw new AdminHttpContractError('$.error.code', 'unknown stable machine error code');
  }
  const typedCode = code as AdminHttpErrorCode;
  if (ADMIN_HTTP_STATUS_BY_ERROR_CODE[typedCode] !== status) {
    throw new AdminHttpContractError(
      '$.error.status',
      `status ${status} is invalid for error code ${typedCode}`,
    );
  }
  const details = decodeAdminErrorDetails(typedCode, error.details);
  const decoded: AdminHttpErrorDetailV1 = {
    status,
    code: typedCode,
    message: decodeAdminErrorMessage(error.message),
    timestamp: decodeTimestamp(error.timestamp, '$.error.timestamp'),
    path: decodeAdminErrorPath(error.path),
    requestId: decodeAdminRequestId(error.requestId),
    ...(details === undefined ? {} : { details }),
  };
  return Object.freeze({
    contractVersion: ADMIN_HTTP_ERROR_CONTRACT_VERSION,
    success: false,
    error: Object.freeze(decoded),
  });
}

export function encodeAdminHttpErrorEnvelopeV1(
  error: AdminHttpErrorDetailV1,
): AdminHttpErrorEnvelopeV1 {
  return decodeAdminHttpErrorEnvelopeV1({
    contractVersion: ADMIN_HTTP_ERROR_CONTRACT_VERSION,
    success: false,
    error,
  });
}

/**
 * Executable response projections for admin HTTP routes.
 *
 * A projection is both the compile-time DTO authority and the runtime list of
 * fields allowed to cross the HTTP boundary.  Controllers therefore cannot
 * accidentally serialize a persistence entity's newly-added column while the
 * generated browser facade continues to describe an older subset.
 */
export interface AdminResponseContract<TSource, TWire = TSource> {
  readonly kind:
    | 'array'
    | 'boolean'
    | 'date-string'
    | 'json'
    | 'literal'
    | 'never'
    | 'nullable'
    | 'number'
    | 'object'
    | 'optional'
    | 'page'
    | 'record'
    | 'string'
    | 'tuple'
    | 'union'
    | 'void';
  /** Type-only carriers; executable contracts never populate these members. */
  readonly source?: TSource;
  readonly wire?: TWire;
}

export interface AdminStringResponseContract extends AdminResponseContract<string> {
  readonly kind: 'string';
}

export interface AdminNumberResponseContract extends AdminResponseContract<number> {
  readonly kind: 'number';
}

export interface AdminBooleanResponseContract extends AdminResponseContract<boolean> {
  readonly kind: 'boolean';
}

export interface AdminDateStringResponseContract
  extends AdminResponseContract<Date | string, string> {
  readonly kind: 'date-string';
}

export interface AdminSchemalessJsonDecoderV1 extends AdminJsonDecoderDefinitionV1 {
  decode(value: unknown, path?: string): JsonValue;
}

function createAdminSchemalessJsonDecoder(
  definition: (typeof ADMIN_JSON_DECODER_CATALOG.entries)[number],
): AdminSchemalessJsonDecoderV1 {
  return Object.freeze({
    ...definition,
    decode(value: unknown, path = '$'): JsonValue {
      const decoded = decodeJsonValue(value, path);
      if (
        definition.rootPolicy === 'json-scalar' &&
        typeof decoded === 'object' &&
        decoded !== null
      ) {
        throw new AdminHttpContractError(path, 'expected a JSON scalar');
      }
      return decoded;
    },
  });
}

export const ADMIN_SCHEMALESS_JSON_DECODER_REGISTRY: Readonly<
  Record<AdminSchemalessJsonReason, AdminSchemalessJsonDecoderV1>
> = Object.freeze(
  Object.fromEntries(
    ADMIN_JSON_DECODER_CATALOG.entries.map((definition) => [
      definition.reason,
      createAdminSchemalessJsonDecoder(definition),
    ]),
  ) as Record<AdminSchemalessJsonReason, AdminSchemalessJsonDecoderV1>,
);

export function adminSchemalessJsonDecoderFor(
  reason: AdminSchemalessJsonReason,
): AdminSchemalessJsonDecoderV1 {
  const decoder = ADMIN_SCHEMALESS_JSON_DECODER_REGISTRY[reason];
  if (decoder === undefined) {
    throw new AdminHttpContractError('$', `unregistered admin JSON decoder reason: ${reason}`);
  }
  return decoder;
}

export function decodeAdminSchemalessJson(
  reason: AdminSchemalessJsonReason,
  value: unknown,
  path = '$',
): JsonValue {
  return adminSchemalessJsonDecoderFor(reason).decode(value, path);
}

export interface AdminJsonResponseContract
  extends AdminResponseContract<unknown, JsonValue>,
    AdminJsonDecoderDefinitionV1 {
  readonly kind: 'json';
  readonly reason: AdminSchemalessJsonReason;
  readonly decoderId: AdminJsonDecoderId;
  readonly owner: AdminJsonDecoderOwner;
}

export interface AdminNeverResponseContract extends AdminResponseContract<never, never> {
  readonly kind: 'never';
}

export interface AdminVoidResponseContract extends AdminResponseContract<void, null> {
  readonly kind: 'void';
}

export interface AdminLiteralResponseContract<T extends JsonPrimitive>
  extends AdminResponseContract<T> {
  readonly kind: 'literal';
  readonly value: T;
}

export interface AdminArrayResponseContract<TItem extends AdminResponseContract<unknown, unknown>>
  extends AdminResponseContract<
    readonly AdminResponseOf<TItem>[],
    readonly AdminWireResponseOf<TItem>[]
  > {
  readonly kind: 'array';
  readonly item: TItem;
}

export interface AdminPageResponseContract<TItem extends AdminResponseContract<unknown, unknown>>
  extends AdminResponseContract<
    StandardPaginatedResult<AdminResponseOf<TItem>>,
    StandardPaginatedResult<AdminWireResponseOf<TItem>>
  > {
  readonly kind: 'page';
  readonly item: TItem;
}

export type AdminResponseShape = Readonly<Record<string, AdminResponseContract<unknown, unknown>>>;

type OptionalResponseKeys<TShape extends AdminResponseShape> = {
  [TKey in keyof TShape]: undefined extends AdminResponseOf<TShape[TKey]> ? TKey : never;
}[keyof TShape];

type RequiredResponseKeys<TShape extends AdminResponseShape> = Exclude<
  keyof TShape,
  OptionalResponseKeys<TShape>
>;

export type AdminObjectResponse<TShape extends AdminResponseShape> = {
  readonly [TKey in RequiredResponseKeys<TShape>]: AdminResponseOf<TShape[TKey]>;
} & {
  readonly [TKey in OptionalResponseKeys<TShape>]?: Exclude<
    AdminResponseOf<TShape[TKey]>,
    undefined
  >;
};

type OptionalWireResponseKeys<TShape extends AdminResponseShape> = {
  [TKey in keyof TShape]: undefined extends AdminWireResponseOf<TShape[TKey]> ? TKey : never;
}[keyof TShape];

type RequiredWireResponseKeys<TShape extends AdminResponseShape> = Exclude<
  keyof TShape,
  OptionalWireResponseKeys<TShape>
>;

export type AdminWireObjectResponse<TShape extends AdminResponseShape> = {
  readonly [TKey in RequiredWireResponseKeys<TShape>]: AdminWireResponseOf<TShape[TKey]>;
} & {
  readonly [TKey in OptionalWireResponseKeys<TShape>]?: Exclude<
    AdminWireResponseOf<TShape[TKey]>,
    undefined
  >;
};

export interface AdminObjectResponseContract<TShape extends AdminResponseShape>
  extends AdminResponseContract<AdminObjectResponse<TShape>, AdminWireObjectResponse<TShape>> {
  readonly kind: 'object';
  readonly fields: TShape;
}

export interface AdminOptionalResponseContract<
  TValue extends AdminResponseContract<unknown, unknown>,
> extends AdminResponseContract<
    AdminResponseOf<TValue> | undefined,
    AdminWireResponseOf<TValue> | undefined
  > {
  readonly kind: 'optional';
  readonly value: TValue;
}

export interface AdminNullableResponseContract<
  TValue extends AdminResponseContract<unknown, unknown>,
> extends AdminResponseContract<
    AdminResponseOf<TValue> | null,
    AdminWireResponseOf<TValue> | null
  > {
  readonly kind: 'nullable';
  readonly value: TValue;
}

export interface AdminRecordResponseContract<TValue extends AdminResponseContract<unknown, unknown>>
  extends AdminResponseContract<
    Readonly<Record<string, AdminResponseOf<TValue>>>,
    Readonly<Record<string, AdminWireResponseOf<TValue>>>
  > {
  readonly kind: 'record';
  readonly value: TValue;
}

export type AdminResponseContractTuple = readonly AdminResponseContract<unknown, unknown>[];

export interface AdminTupleResponseContract<TItems extends AdminResponseContractTuple>
  extends AdminResponseContract<
    { readonly [TIndex in keyof TItems]: AdminResponseOf<TItems[TIndex]> },
    { readonly [TIndex in keyof TItems]: AdminWireResponseOf<TItems[TIndex]> }
  > {
  readonly kind: 'tuple';
  readonly items: TItems;
}

export interface AdminUnionResponseContract<TVariants extends AdminResponseContractTuple>
  extends AdminResponseContract<
    AdminResponseOf<TVariants[number]>,
    AdminWireResponseOf<TVariants[number]>
  > {
  readonly kind: 'union';
  readonly variants: TVariants;
}

export type AdminResponseOf<TContract extends AdminResponseContract<unknown, unknown>> =
  TContract extends AdminStringResponseContract
    ? string
    : TContract extends AdminNumberResponseContract
      ? number
      : TContract extends AdminBooleanResponseContract
        ? boolean
        : TContract extends AdminDateStringResponseContract
          ? Date | string
          : TContract extends AdminJsonResponseContract
            ? unknown
            : TContract extends AdminNeverResponseContract
              ? never
              : TContract extends AdminVoidResponseContract
                ? undefined
                : TContract extends AdminLiteralResponseContract<infer TValue>
                  ? TValue
                  : TContract extends AdminArrayResponseContract<infer TItem>
                    ? readonly AdminResponseOf<TItem>[]
                    : TContract extends AdminPageResponseContract<infer TItem>
                      ? StandardPaginatedResult<AdminResponseOf<TItem>>
                      : TContract extends AdminObjectResponseContract<infer TShape>
                        ? AdminObjectResponse<TShape>
                        : TContract extends AdminOptionalResponseContract<infer TValue>
                          ? AdminResponseOf<TValue> | undefined
                          : TContract extends AdminNullableResponseContract<infer TValue>
                            ? AdminResponseOf<TValue> | null
                            : TContract extends AdminRecordResponseContract<infer TValue>
                              ? Readonly<Record<string, AdminResponseOf<TValue>>>
                              : TContract extends AdminTupleResponseContract<infer TItems>
                                ? {
                                    readonly [TIndex in keyof TItems]: AdminResponseOf<
                                      TItems[TIndex]
                                    >;
                                  }
                                : TContract extends AdminUnionResponseContract<infer TVariants>
                                  ? AdminResponseOf<TVariants[number]>
                                  : never;

export type AdminWireResponseOf<TContract extends AdminResponseContract<unknown, unknown>> =
  TContract extends AdminDateStringResponseContract
    ? string
    : TContract extends AdminVoidResponseContract
      ? null
      : TContract extends AdminArrayResponseContract<infer TItem>
        ? readonly AdminWireResponseOf<TItem>[]
        : TContract extends AdminPageResponseContract<infer TItem>
          ? StandardPaginatedResult<AdminWireResponseOf<TItem>>
          : TContract extends AdminObjectResponseContract<infer TShape>
            ? AdminWireObjectResponse<TShape>
            : TContract extends AdminOptionalResponseContract<infer TValue>
              ? AdminWireResponseOf<TValue> | undefined
              : TContract extends AdminNullableResponseContract<infer TValue>
                ? AdminWireResponseOf<TValue> | null
                : TContract extends AdminRecordResponseContract<infer TValue>
                  ? Readonly<Record<string, AdminWireResponseOf<TValue>>>
                  : TContract extends AdminTupleResponseContract<infer TItems>
                    ? {
                        readonly [TIndex in keyof TItems]: AdminWireResponseOf<TItems[TIndex]>;
                      }
                    : TContract extends AdminUnionResponseContract<infer TVariants>
                      ? AdminWireResponseOf<TVariants[number]>
                      : TContract extends AdminLiteralResponseContract<infer TValue>
                        ? TValue
                        : TContract extends AdminStringResponseContract
                          ? string
                          : TContract extends AdminNumberResponseContract
                            ? number
                            : TContract extends AdminBooleanResponseContract
                              ? boolean
                              : TContract extends AdminJsonResponseContract
                                ? JsonValue
                                : TContract extends AdminNeverResponseContract
                                  ? never
                                  : never;

/** The named DTO at a route boundary, excluding its collection wrapper. */
export type AdminResponseProjection<TContract extends AdminResponseContract<unknown, unknown>> =
  TContract extends AdminArrayResponseContract<infer TItem>
    ? AdminResponseOf<TItem>
    : TContract extends AdminPageResponseContract<infer TItem>
      ? AdminResponseOf<TItem>
      : AdminResponseOf<TContract>;

export type AdminWireResponseProjection<TContract extends AdminResponseContract<unknown, unknown>> =
  TContract extends AdminArrayResponseContract<infer TItem>
    ? AdminWireResponseOf<TItem>
    : TContract extends AdminPageResponseContract<infer TItem>
      ? AdminWireResponseOf<TItem>
      : AdminWireResponseOf<TContract>;

const BUILT_RESPONSE_CONTRACTS = new WeakSet<object>();

function sealContract<const TContract extends AdminResponseContract<unknown, unknown>>(
  contract: TContract,
): TContract {
  BUILT_RESPONSE_CONTRACTS.add(contract);
  return Object.freeze(contract);
}

function requireExecutableChild(
  contract: AdminResponseContract<unknown, unknown>,
  path: string,
): void {
  if (!isExecutableAdminResponseContract(contract)) {
    throw new AdminHttpContractError(
      path,
      'response contract child must come from the closed adminResponse builders',
    );
  }
}

function stringContract(): AdminStringResponseContract {
  return sealContract({ kind: 'string' });
}

function numberContract(): AdminNumberResponseContract {
  return sealContract({ kind: 'number' });
}

function booleanContract(): AdminBooleanResponseContract {
  return sealContract({ kind: 'boolean' });
}

function dateStringContract(): AdminDateStringResponseContract {
  return sealContract({ kind: 'date-string' });
}

function jsonContract(reason: AdminSchemalessJsonReason): AdminJsonResponseContract {
  const definition = adminJsonDecoderDefinitionFor(reason);
  return sealContract({ kind: 'json', ...definition });
}

function neverContract(): AdminNeverResponseContract {
  return sealContract({ kind: 'never' });
}

function voidContract(): AdminVoidResponseContract {
  return sealContract({ kind: 'void' });
}

function literalContract<const TValue extends JsonPrimitive>(
  value: TValue,
): AdminLiteralResponseContract<TValue> {
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    (typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new AdminHttpContractError('$.value', 'literal requires a finite JSON primitive');
  }
  return sealContract({ kind: 'literal', value });
}

function literalSetContract<const TValues extends readonly JsonPrimitive[]>(
  values: TValues,
): AdminUnionResponseContract<readonly AdminLiteralResponseContract<TValues[number]>[]> {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new AdminHttpContractError(
      '$.values',
      'literalSet requires at least one unique JSON primitive',
    );
  }
  const variants: Array<AdminLiteralResponseContract<TValues[number]>> = values.map((value) =>
    literalContract(value),
  );
  return unionContract(variants);
}

function arrayContract<const TItem extends AdminResponseContract<unknown, unknown>>(
  item: TItem,
): AdminArrayResponseContract<TItem> {
  requireExecutableChild(item, '$.item');
  return sealContract({ kind: 'array', item });
}

function pageContract<const TItem extends AdminResponseContract<unknown, unknown>>(
  item: TItem,
): AdminPageResponseContract<TItem> {
  requireExecutableChild(item, '$.item');
  return sealContract({ kind: 'page', item });
}

function objectContract<const TShape extends AdminResponseShape>(
  fields: TShape,
): AdminObjectResponseContract<TShape> {
  for (const [key, field] of Object.entries(fields)) {
    requireExecutableChild(field, `$.fields.${key}`);
  }
  return sealContract({ kind: 'object', fields: Object.freeze({ ...fields }) });
}

function optionalContract<const TValue extends AdminResponseContract<unknown, unknown>>(
  value: TValue,
): AdminOptionalResponseContract<TValue> {
  requireExecutableChild(value, '$.value');
  return sealContract({ kind: 'optional', value });
}

function nullableContract<const TValue extends AdminResponseContract<unknown, unknown>>(
  value: TValue,
): AdminNullableResponseContract<TValue> {
  requireExecutableChild(value, '$.value');
  return sealContract({ kind: 'nullable', value });
}

function recordContract<const TValue extends AdminResponseContract<unknown, unknown>>(
  value: TValue,
): AdminRecordResponseContract<TValue> {
  requireExecutableChild(value, '$.value');
  return sealContract({ kind: 'record', value });
}

function tupleContract<const TItems extends AdminResponseContractTuple>(
  items: TItems,
): AdminTupleResponseContract<TItems> {
  items.forEach((item, index) => requireExecutableChild(item, `$.items[${index}]`));
  return sealContract({ kind: 'tuple', items: Object.freeze(items) });
}

function unionContract<const TVariants extends AdminResponseContractTuple>(
  variants: TVariants,
): AdminUnionResponseContract<TVariants> {
  if (variants.length === 0) {
    throw new AdminHttpContractError('$.variants', 'union requires at least one variant');
  }
  variants.forEach((variant, index) => requireExecutableChild(variant, `$.variants[${index}]`));
  return sealContract({ kind: 'union', variants: Object.freeze(variants) });
}

export const adminResponse = Object.freeze({
  array: arrayContract,
  boolean: booleanContract,
  dateString: dateStringContract,
  json: jsonContract,
  literal: literalContract,
  literalSet: literalSetContract,
  nullable: nullableContract,
  never: neverContract,
  number: numberContract,
  object: objectContract,
  optional: optionalContract,
  page: pageContract,
  record: recordContract,
  string: stringContract,
  tuple: tupleContract,
  union: unionContract,
  void: voidContract,
});

const BUILT_MANUAL_RESPONSE_PROFILES = new WeakSet<object>();

function requireStatusCodes(statusCodes: readonly number[]): readonly number[] {
  if (
    statusCodes.length === 0 ||
    new Set(statusCodes).size !== statusCodes.length ||
    statusCodes.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599)
  ) {
    throw new AdminHttpContractError(
      '$.statusCodes',
      'manual response status codes must be unique HTTP status integers',
    );
  }
  return Object.freeze([...statusCodes]);
}

function sealManualResponseProfile<const TProfile extends AdminManualResponseProfile>(
  profile: TProfile,
): TProfile {
  BUILT_MANUAL_RESPONSE_PROFILES.add(profile);
  return Object.freeze(profile);
}

function healthResponseProfile<const TBody extends AdminResponseContract<unknown, unknown>>(
  statusCodes: readonly number[],
  body: TBody,
): AdminHealthResponseProfile<TBody> {
  requireExecutableChild(body, '$.body');
  return sealManualResponseProfile({
    kind: 'health-response',
    transport: 'frontend-external',
    statusCodes: requireStatusCodes(statusCodes),
    body,
  });
}

function binaryResponseProfile<
  const TMediaType extends AdminBinaryMediaType,
  const TMaxBytes extends number,
>(
  statusCodes: readonly number[],
  mediaTypes: readonly TMediaType[],
  maxBytes: TMaxBytes,
): AdminBinaryResponseProfile<TMediaType, TMaxBytes> {
  if (
    mediaTypes.length === 0 ||
    new Set(mediaTypes).size !== mediaTypes.length ||
    mediaTypes.some((mediaType) => !ADMIN_BINARY_MEDIA_TYPES.includes(mediaType))
  ) {
    throw new AdminHttpContractError(
      '$.mediaTypes',
      'binary response media types must be unique members of the closed media catalog',
    );
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > ADMIN_BINARY_ABSOLUTE_MAX_BYTES
  ) {
    throw new AdminHttpContractError(
      '$.maxBytes',
      `binary response maxBytes must be a safe integer in 1-${ADMIN_BINARY_ABSOLUTE_MAX_BYTES}`,
    );
  }
  return sealManualResponseProfile({
    kind: 'binary-download',
    transport: 'binary-download',
    statusCodes: requireStatusCodes(statusCodes),
    mediaTypes: Object.freeze([...mediaTypes]),
    maxBytes,
    disposition: 'attachment-with-filename',
  });
}

export const adminManualResponse = Object.freeze({
  binary: binaryResponseProfile,
  health: healthResponseProfile,
});

export function isExecutableAdminManualResponseProfile(
  value: unknown,
): value is AdminManualResponseProfile {
  if (
    typeof value !== 'object' ||
    value === null ||
    !BUILT_MANUAL_RESPONSE_PROFILES.has(value) ||
    !Object.isFrozen(value)
  ) {
    return false;
  }
  const profile = value as AdminManualResponseProfile;
  if (!Object.isFrozen(profile.statusCodes)) return false;
  if (profile.kind === 'health-response') {
    return (
      hasExactOwnKeys(profile, ['kind', 'transport', 'statusCodes', 'body']) &&
      profile.transport === 'frontend-external' &&
      isExecutableAdminResponseContract(profile.body)
    );
  }
  return (
    profile.kind === 'binary-download' &&
    hasExactOwnKeys(profile, [
      'kind',
      'transport',
      'statusCodes',
      'mediaTypes',
      'maxBytes',
      'disposition',
    ]) &&
    profile.transport === 'binary-download' &&
    Object.isFrozen(profile.mediaTypes) &&
    profile.mediaTypes.every((mediaType) => ADMIN_BINARY_MEDIA_TYPES.includes(mediaType)) &&
    Number.isSafeInteger(profile.maxBytes) &&
    profile.maxBytes > 0 &&
    profile.maxBytes <= ADMIN_BINARY_ABSOLUTE_MAX_BYTES &&
    profile.disposition === 'attachment-with-filename'
  );
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Validates builder provenance and the complete immutable contract DAG.
 * Metadata fabricated outside the closed builders is never executable, even
 * when it happens to contain a familiar `kind` string.
 */
export function isExecutableAdminResponseContract(
  value: unknown,
): value is AdminResponseContract<unknown, unknown> {
  const visiting = new WeakSet<object>();
  const validated = new WeakSet<object>();

  const validate = (candidate: unknown): boolean => {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !BUILT_RESPONSE_CONTRACTS.has(candidate) ||
      !Object.isFrozen(candidate)
    ) {
      return false;
    }
    if (validated.has(candidate)) return true;
    if (visiting.has(candidate)) return false;
    visiting.add(candidate);

    const kind: unknown = Reflect.get(candidate, 'kind');
    let valid = false;
    switch (kind) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'date-string':
      case 'never':
      case 'void':
        valid = hasExactOwnKeys(candidate, ['kind']);
        break;
      case 'json': {
        const reason: unknown = Reflect.get(candidate, 'reason');
        if (
          !hasExactOwnKeys(candidate, [
            'codecPolicyId',
            'decoderId',
            'decoderVersion',
            'kind',
            'owner',
            'reason',
            'rootPolicy',
          ]) ||
          typeof reason !== 'string' ||
          !ADMIN_SCHEMALESS_JSON_REASONS.includes(reason as AdminSchemalessJsonReason)
        ) {
          valid = false;
          break;
        }
        const definition = adminJsonDecoderDefinitionFor(reason);
        valid =
          Reflect.get(candidate, 'decoderId') === definition.decoderId &&
          Reflect.get(candidate, 'decoderVersion') === definition.decoderVersion &&
          Reflect.get(candidate, 'owner') === definition.owner &&
          Reflect.get(candidate, 'rootPolicy') === definition.rootPolicy &&
          Reflect.get(candidate, 'codecPolicyId') === definition.codecPolicyId;
        break;
      }
      case 'literal':
        valid =
          hasExactOwnKeys(candidate, ['kind', 'value']) &&
          isJsonPrimitive(Reflect.get(candidate, 'value'));
        break;
      case 'array':
      case 'page':
        valid =
          hasExactOwnKeys(candidate, ['kind', 'item']) && validate(Reflect.get(candidate, 'item'));
        break;
      case 'optional':
      case 'nullable':
      case 'record':
        valid =
          hasExactOwnKeys(candidate, ['kind', 'value']) &&
          validate(Reflect.get(candidate, 'value'));
        break;
      case 'tuple':
      case 'union': {
        const key = kind === 'tuple' ? 'items' : 'variants';
        const entries: unknown = Reflect.get(candidate, key);
        valid =
          hasExactOwnKeys(candidate, ['kind', key]) &&
          Array.isArray(entries) &&
          Object.isFrozen(entries) &&
          (kind !== 'union' || entries.length > 0) &&
          entries.every((entry: unknown) => validate(entry));
        break;
      }
      case 'object': {
        const fields: unknown = Reflect.get(candidate, 'fields');
        valid =
          hasExactOwnKeys(candidate, ['kind', 'fields']) &&
          typeof fields === 'object' &&
          fields !== null &&
          !Array.isArray(fields) &&
          Reflect.getPrototypeOf(fields) === Object.prototype &&
          Object.isFrozen(fields) &&
          Reflect.ownKeys(fields).every(
            (key) =>
              typeof key === 'string' &&
              key !== '__proto__' &&
              key !== 'prototype' &&
              key !== 'constructor' &&
              validate(Reflect.get(fields, key)),
          );
        break;
      }
      default:
        valid = false;
    }

    visiting.delete(candidate);
    if (valid) validated.add(candidate);
    return valid;
  };

  return validate(value);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdminHttpContractError(path, 'expected a finite number');
  }
  return value;
}

function projectContractValue(
  contract: AdminResponseContract<unknown, unknown>,
  value: unknown,
  path: string,
): JsonValue | undefined {
  switch (contract.kind) {
    case 'string':
      if (typeof value !== 'string') {
        throw new AdminHttpContractError(path, 'expected a string');
      }
      return value;
    case 'number':
      return projectFiniteNumber(value, path);
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new AdminHttpContractError(path, 'expected a boolean');
      }
      return value;
    case 'date-string': {
      const timestamp = value instanceof Date ? value.toISOString() : value;
      if (
        typeof timestamp !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)
      ) {
        throw new AdminHttpContractError(path, 'expected an RFC 3339 UTC timestamp');
      }
      return timestamp;
    }
    case 'json':
      return decodeAdminSchemalessJson((contract as AdminJsonResponseContract).reason, value, path);
    case 'never':
      throw new AdminHttpContractError(path, 'unreachable route produced a response value');
    case 'void':
      if (value !== undefined) {
        throw new AdminHttpContractError(path, 'expected no response value');
      }
      return null;
    case 'literal': {
      const literal = contract as AdminLiteralResponseContract<JsonPrimitive>;
      if (value !== literal.value) {
        throw new AdminHttpContractError(path, `expected literal ${JSON.stringify(literal.value)}`);
      }
      return literal.value;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        throw new AdminHttpContractError(path, 'expected an array');
      }
      const array = contract as AdminArrayResponseContract<AdminResponseContract<unknown, unknown>>;
      return Object.freeze(
        value.map((entry, index) =>
          projectContractValue(array.item, entry, `${path}[${index}]`),
        ) as JsonValue[],
      );
    }
    case 'page': {
      if (!isUnknownRecord(value) || !Array.isArray(value.items)) {
        throw new AdminHttpContractError(path, 'expected a canonical page');
      }
      const page = contract as AdminPageResponseContract<AdminResponseContract<unknown, unknown>>;
      const total = projectFiniteNumber(value.total, `${path}.total`);
      const currentPage = projectFiniteNumber(value.page, `${path}.page`);
      const limit = projectFiniteNumber(value.limit, `${path}.limit`);
      const totalPages = projectFiniteNumber(value.totalPages, `${path}.totalPages`);
      if (typeof value.hasNextPage !== 'boolean') {
        throw new AdminHttpContractError(`${path}.hasNextPage`, 'expected a boolean');
      }
      if (typeof value.hasPreviousPage !== 'boolean') {
        throw new AdminHttpContractError(`${path}.hasPreviousPage`, 'expected a boolean');
      }
      return Object.freeze({
        items: Object.freeze(
          value.items.map((entry, index) =>
            projectContractValue(page.item, entry, `${path}.items[${index}]`),
          ) as JsonValue[],
        ),
        total,
        page: currentPage,
        limit,
        totalPages,
        hasNextPage: value.hasNextPage,
        hasPreviousPage: value.hasPreviousPage,
      });
    }
    case 'object': {
      if (!isUnknownRecord(value)) {
        throw new AdminHttpContractError(path, 'expected an object');
      }
      const object = contract as AdminObjectResponseContract<AdminResponseShape>;
      const projected = Object.create(null) as Record<string, JsonValue>;
      for (const [key, field] of Object.entries(object.fields)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          if (field.kind === 'optional') continue;
          throw new AdminHttpContractError(`${path}.${key}`, 'required field is missing');
        }
        const fieldValue = projectContractValue(field, value[key], `${path}.${key}`);
        if (fieldValue !== undefined) projected[key] = fieldValue;
      }
      return Object.freeze(projected);
    }
    case 'optional': {
      const optional = contract as AdminOptionalResponseContract<
        AdminResponseContract<unknown, unknown>
      >;
      return value === undefined ? undefined : projectContractValue(optional.value, value, path);
    }
    case 'nullable': {
      const nullable = contract as AdminNullableResponseContract<
        AdminResponseContract<unknown, unknown>
      >;
      return value === null ? null : projectContractValue(nullable.value, value, path);
    }
    case 'record': {
      if (!isUnknownRecord(value)) {
        throw new AdminHttpContractError(path, 'expected a record');
      }
      const record = contract as AdminRecordResponseContract<
        AdminResponseContract<unknown, unknown>
      >;
      const projected = Object.create(null) as Record<string, JsonValue>;
      for (const [key, entry] of Object.entries(value)) {
        if (ADMIN_JSON_FORBIDDEN_KEYS.has(key)) {
          throw new AdminHttpContractError(
            jsonPathField(path, key),
            'prototype-mutating record key is forbidden',
          );
        }
        const fieldValue = projectContractValue(record.value, entry, `${path}.${key}`);
        if (fieldValue !== undefined) projected[key] = fieldValue;
      }
      return Object.freeze(projected);
    }
    case 'tuple': {
      if (!Array.isArray(value)) {
        throw new AdminHttpContractError(path, 'expected a tuple');
      }
      const tuple = contract as AdminTupleResponseContract<AdminResponseContractTuple>;
      if (value.length !== tuple.items.length) {
        throw new AdminHttpContractError(path, `expected ${tuple.items.length} tuple entries`);
      }
      return Object.freeze(
        tuple.items.map((item, index) =>
          projectContractValue(item, value[index], `${path}[${index}]`),
        ) as JsonValue[],
      );
    }
    case 'union': {
      const union = contract as AdminUnionResponseContract<AdminResponseContractTuple>;
      const failures: string[] = [];
      for (const variant of union.variants) {
        try {
          return projectContractValue(variant, value, path);
        } catch (error) {
          if (!(error instanceof AdminHttpContractError)) throw error;
          failures.push(error.message);
        }
      }
      throw new AdminHttpContractError(
        path,
        `did not match any response variant (${failures.join('; ')})`,
      );
    }
  }
}

export function projectAdminResponse<TContract extends AdminResponseContract<unknown, unknown>>(
  contract: TContract,
  value: unknown,
): AdminWireResponseOf<TContract>;
export function projectAdminResponse(
  contract: AdminResponseContract<unknown, unknown>,
  value: unknown,
): JsonValue | undefined {
  return projectAdminResponseToJson(contract, value);
}

/** Runtime-only projection entry point for dynamically resolved route metadata. */
export function projectAdminResponseToJson(
  contract: AdminResponseContract<unknown, unknown>,
  value: unknown,
): JsonValue | undefined {
  return projectContractValue(contract, value, '$');
}

/**
 * Validate a value that has already crossed JSON rather than projecting a
 * backend value.  The two operations deliberately share the closed contract
 * graph while keeping `void` honest: a backend `undefined` serializes as the
 * wire value `null`.
 */
function decodeWireContractValue(
  contract: AdminResponseContract<unknown, unknown>,
  value: unknown,
  path: string,
): JsonValue {
  if (contract.kind === 'void') {
    if (value !== null) {
      throw new AdminHttpContractError(path, 'expected the null wire value for void');
    }
    return null;
  }
  if (contract.kind === 'never') {
    throw new AdminHttpContractError(path, 'unreachable route produced a wire value');
  }
  const projected = projectContractValue(contract, value, path);
  if (projected === undefined) {
    throw new AdminHttpContractError(path, 'top-level response cannot be omitted');
  }
  return projected;
}

export function decodeAdminWireResponse<TContract extends AdminResponseContract<unknown, unknown>>(
  contract: TContract,
  value: unknown,
): AdminWireResponseOf<TContract> {
  return decodeWireContractValue(contract, value, '$') as AdminWireResponseOf<TContract>;
}

const BUILT_REQUEST_CONTRACTS = new WeakSet<object>();

export function createAdminRequestContract<
  const TPath extends AdminRequestObjectContract,
  const TQuery extends AdminRequestObjectContract,
  const TQueryCodecs extends AdminQueryCodecMap<TQuery>,
  const THeaders extends AdminRequestObjectContract,
  const TBody extends AdminResponseContract<unknown, unknown>,
>(
  path: TPath,
  query: TQuery,
  queryCodecs: TQueryCodecs,
  headers: THeaders,
  body: TBody,
  contentType: 'application/json' | null,
): AdminRouteRequestContract<TPath, TQuery, TQueryCodecs, THeaders, TBody> {
  for (const [name, contract] of [
    ['path', path],
    ['query', query],
    ['headers', headers],
  ] as const) {
    if (!isExecutableAdminResponseContract(contract) || contract.kind !== 'object') {
      throw new AdminHttpContractError(
        `$.request.${name}`,
        `${name} request contract must be a closed object schema`,
      );
    }
  }
  if (!isExecutableAdminResponseContract(body)) {
    throw new AdminHttpContractError('$.request.body', 'body request contract must be closed');
  }
  if ((body.kind === 'void') !== (contentType === null)) {
    throw new AdminHttpContractError(
      '$.request.contentType',
      'JSON media type and non-void request body must be declared together',
    );
  }
  const queryFields = Object.keys(query.fields).sort();
  const codecFields = Object.keys(queryCodecs).sort();
  if (
    queryFields.length !== codecFields.length ||
    queryFields.some((field, index) => field !== codecFields[index])
  ) {
    throw new AdminHttpContractError(
      '$.request.queryCodecs',
      'query codec keys must exactly equal the executable query field set',
    );
  }
  for (const field of queryFields) {
    const codec = queryCodecs[field];
    if (codec !== 'scalar' && codec !== 'repeated' && codec !== 'comma-separated') {
      throw new AdminHttpContractError(
        `$.request.queryCodecs.${field}`,
        'query codec must be scalar, repeated, or comma-separated',
      );
    }
    const fieldContract = query.fields[field];
    if (fieldContract === undefined) {
      throw new AdminHttpContractError(
        `$.request.query.${field}`,
        'query contract field disappeared during validation',
      );
    }
    const unwrapped = unwrapOptionalAdminContract(fieldContract);
    if ((unwrapped.kind === 'array') !== (codec === 'repeated')) {
      if (unwrapped.kind === 'array' || codec === 'repeated') {
        throw new AdminHttpContractError(
          `$.request.queryCodecs.${field}`,
          'repeated encoding is reserved for array-typed query fields',
        );
      }
    }
  }
  for (const field of Object.keys(headers.fields)) {
    if (field !== field.toLowerCase()) {
      throw new AdminHttpContractError(
        `$.request.headers.${field}`,
        'request header contract names must be lowercase',
      );
    }
    if (ADMIN_RESERVED_REQUEST_HEADER_NAMES.has(field)) {
      throw new AdminHttpContractError(
        `$.request.headers.${field}`,
        'request header is reserved by the transport kernel',
      );
    }
  }
  const request = {
    path,
    query,
    queryCodecs: Object.freeze({ ...queryCodecs }),
    headers,
    body,
    contentType,
  };
  BUILT_REQUEST_CONTRACTS.add(request);
  return Object.freeze(request);
}

export function isExecutableAdminRouteRequestContract(
  value: unknown,
): value is AdminRouteRequestContract {
  if (
    typeof value !== 'object' ||
    value === null ||
    !BUILT_REQUEST_CONTRACTS.has(value) ||
    !Object.isFrozen(value) ||
    !hasExactOwnKeys(value, ['body', 'contentType', 'headers', 'path', 'query', 'queryCodecs'])
  ) {
    return false;
  }
  const request = value as AdminRouteRequestContract;
  return (
    isExecutableAdminResponseContract(request.path) &&
    request.path.kind === 'object' &&
    isExecutableAdminResponseContract(request.query) &&
    request.query.kind === 'object' &&
    isExecutableAdminResponseContract(request.headers) &&
    request.headers.kind === 'object' &&
    isExecutableAdminResponseContract(request.body) &&
    Object.isFrozen(request.queryCodecs) &&
    ((request.body.kind === 'void' && request.contentType === null) ||
      (request.body.kind !== 'void' && request.contentType === 'application/json'))
  );
}

export interface AdminInboundRequestCandidateV1 {
  readonly path?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
}

export interface DecodedAdminInboundRequestV1 {
  readonly path: Readonly<Record<string, JsonValue>>;
  readonly query: Readonly<Record<string, JsonValue>>;
  readonly headers: Readonly<Record<string, JsonValue>>;
  readonly body?: JsonValue;
}

type AdminInboundRepresentation = 'json' | 'uri';

interface AdminInboundDecodeBudget {
  depth: number;
  nodes: number;
}

function mutableNullPrototypeRecord<T>(): Record<string, T> {
  const record: Record<string, T> = {};
  Object.setPrototypeOf(record, null);
  return record;
}

function consumeAdminInboundBudget(
  budget: AdminInboundDecodeBudget,
  path: string,
  depth: number,
): void {
  budget.nodes++;
  if (budget.nodes > ADMIN_JSON_CODEC_POLICY.maxNodes) {
    throw new AdminHttpContractError(
      path,
      `request exceeds ${ADMIN_JSON_CODEC_POLICY.maxNodes} nodes`,
    );
  }
  if (depth > ADMIN_JSON_CODEC_POLICY.maxDepth) {
    throw new AdminHttpContractError(
      path,
      `request exceeds depth ${ADMIN_JSON_CODEC_POLICY.maxDepth}`,
    );
  }
  budget.depth = Math.max(budget.depth, depth);
}

function inboundOwnDataEntries(
  value: unknown,
  path: string,
): readonly (readonly [string, unknown])[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdminHttpContractError(path, 'expected an object');
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdminHttpContractError(path, 'expected a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > ADMIN_JSON_CODEC_POLICY.maxObjectKeys) {
    throw new AdminHttpContractError(
      path,
      `request object exceeds ${ADMIN_JSON_CODEC_POLICY.maxObjectKeys} keys`,
    );
  }
  return ownKeys.map((key): readonly [string, unknown] => {
    if (typeof key !== 'string') {
      throw new AdminHttpContractError(path, 'symbol request keys are forbidden');
    }
    if (ADMIN_JSON_FORBIDDEN_KEYS.has(key)) {
      throw new AdminHttpContractError(
        jsonPathField(path, key),
        'prototype-mutating request key is forbidden',
      );
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new AdminHttpContractError(
        jsonPathField(path, key),
        'request fields must be enumerable own data properties',
      );
    }
    if (new TextEncoder().encode(key).byteLength > ADMIN_JSON_CODEC_POLICY.maxKeyBytes) {
      throw new AdminHttpContractError(
        jsonPathField(path, key),
        `request key exceeds ${ADMIN_JSON_CODEC_POLICY.maxKeyBytes} UTF-8 bytes`,
      );
    }
    return [key, descriptor.value];
  });
}

function decodeInboundString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new AdminHttpContractError(path, 'expected a string');
  }
  if (new TextEncoder().encode(value).byteLength > ADMIN_JSON_CODEC_POLICY.maxStringBytes) {
    throw new AdminHttpContractError(
      path,
      `request string exceeds ${ADMIN_JSON_CODEC_POLICY.maxStringBytes} UTF-8 bytes`,
    );
  }
  return value;
}

function decodeInboundNumber(
  value: unknown,
  path: string,
  representation: AdminInboundRepresentation,
): number {
  if (representation === 'json') return projectFiniteNumber(value, path);
  if (
    typeof value !== 'string' ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)
  ) {
    throw new AdminHttpContractError(path, 'expected a canonical finite number');
  }
  return projectFiniteNumber(Number(value), path);
}

function decodeInboundBoolean(
  value: unknown,
  path: string,
  representation: AdminInboundRepresentation,
): boolean {
  if (representation === 'uri') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  } else if (typeof value === 'boolean') {
    return value;
  }
  throw new AdminHttpContractError(path, 'expected a canonical boolean');
}

function decodeInboundLiteral(
  literal: JsonPrimitive,
  value: unknown,
  path: string,
  representation: AdminInboundRepresentation,
): JsonPrimitive {
  const candidate =
    representation === 'uri'
      ? literal === null
        ? value
        : typeof literal === 'number'
          ? decodeInboundNumber(value, path, representation)
          : typeof literal === 'boolean'
            ? decodeInboundBoolean(value, path, representation)
            : value
      : value;
  if (candidate !== literal) {
    throw new AdminHttpContractError(path, `expected literal ${JSON.stringify(literal)}`);
  }
  return literal;
}

function decodeAdminInboundContractValue(
  contract: AdminResponseContract<unknown, unknown>,
  value: unknown,
  path: string,
  representation: AdminInboundRepresentation,
  budget: AdminInboundDecodeBudget,
  depth: number,
): JsonValue | undefined {
  consumeAdminInboundBudget(budget, path, depth);
  switch (contract.kind) {
    case 'string':
      return decodeInboundString(value, path);
    case 'number':
      return decodeInboundNumber(value, path, representation);
    case 'boolean':
      return decodeInboundBoolean(value, path, representation);
    case 'date-string': {
      const timestamp = decodeInboundString(value, path);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) {
        throw new AdminHttpContractError(path, 'expected an RFC 3339 UTC timestamp');
      }
      const instant = new Date(timestamp);
      const normalized = Number.isNaN(instant.getTime()) ? '' : instant.toISOString();
      const canonical = timestamp.includes('.') ? normalized : normalized.replace('.000Z', 'Z');
      if (canonical !== timestamp) {
        throw new AdminHttpContractError(path, 'expected a real calendar timestamp');
      }
      return timestamp;
    }
    case 'json':
      return decodeAdminSchemalessJson((contract as AdminJsonResponseContract).reason, value, path);
    case 'never':
      throw new AdminHttpContractError(path, 'never is not a valid request value');
    case 'void':
      if (value !== undefined) {
        throw new AdminHttpContractError(path, 'route does not accept a request body');
      }
      return undefined;
    case 'literal':
      return decodeInboundLiteral(
        (contract as AdminLiteralResponseContract<JsonPrimitive>).value,
        value,
        path,
        representation,
      );
    case 'array': {
      if (!Array.isArray(value)) {
        throw new AdminHttpContractError(path, 'expected an array');
      }
      if (value.length > ADMIN_JSON_CODEC_POLICY.maxArrayItems) {
        throw new AdminHttpContractError(
          path,
          `request array exceeds ${ADMIN_JSON_CODEC_POLICY.maxArrayItems} entries`,
        );
      }
      const item = (contract as AdminArrayResponseContract<AdminResponseContract<unknown, unknown>>)
        .item;
      return Object.freeze(
        value.map((entry, index) => {
          const decoded = decodeAdminInboundContractValue(
            item,
            entry,
            `${path}[${index}]`,
            representation,
            budget,
            depth + 1,
          );
          if (decoded === undefined) {
            throw new AdminHttpContractError(`${path}[${index}]`, 'array item cannot be omitted');
          }
          return decoded;
        }),
      );
    }
    case 'page':
      throw new AdminHttpContractError(path, 'page contracts are response-only');
    case 'object': {
      const object = contract as AdminObjectResponseContract<AdminResponseShape>;
      const entries = inboundOwnDataEntries(value, path);
      const received = new Map(entries);
      for (const key of received.keys()) {
        if (!Object.prototype.hasOwnProperty.call(object.fields, key)) {
          throw new AdminHttpContractError(
            jsonPathField(path, key),
            'field is not declared by this request contract',
          );
        }
      }
      const decoded = mutableNullPrototypeRecord<JsonValue>();
      for (const [key, field] of Object.entries(object.fields)) {
        if (!received.has(key)) {
          if (field.kind === 'optional') continue;
          throw new AdminHttpContractError(`${path}.${key}`, 'required field is missing');
        }
        const fieldValue = decodeAdminInboundContractValue(
          field,
          received.get(key),
          `${path}.${key}`,
          representation,
          budget,
          depth + 1,
        );
        if (fieldValue !== undefined) decoded[key] = fieldValue;
      }
      return Object.freeze(decoded);
    }
    case 'optional': {
      if (value === undefined) return undefined;
      return decodeAdminInboundContractValue(
        (contract as AdminOptionalResponseContract<AdminResponseContract<unknown, unknown>>).value,
        value,
        path,
        representation,
        budget,
        depth,
      );
    }
    case 'nullable': {
      if (value === null) return null;
      return decodeAdminInboundContractValue(
        (contract as AdminNullableResponseContract<AdminResponseContract<unknown, unknown>>).value,
        value,
        path,
        representation,
        budget,
        depth,
      );
    }
    case 'record': {
      const record = contract as AdminRecordResponseContract<
        AdminResponseContract<unknown, unknown>
      >;
      const decoded = mutableNullPrototypeRecord<JsonValue>();
      for (const [key, entry] of inboundOwnDataEntries(value, path)) {
        const fieldValue = decodeAdminInboundContractValue(
          record.value,
          entry,
          jsonPathField(path, key),
          representation,
          budget,
          depth + 1,
        );
        if (fieldValue !== undefined) decoded[key] = fieldValue;
      }
      return Object.freeze(decoded);
    }
    case 'tuple': {
      if (!Array.isArray(value)) {
        throw new AdminHttpContractError(path, 'expected a tuple');
      }
      const tuple = contract as AdminTupleResponseContract<AdminResponseContractTuple>;
      if (value.length !== tuple.items.length) {
        throw new AdminHttpContractError(path, `expected ${tuple.items.length} tuple entries`);
      }
      return Object.freeze(
        tuple.items.map((item, index) => {
          const decoded = decodeAdminInboundContractValue(
            item,
            value[index],
            `${path}[${index}]`,
            representation,
            budget,
            depth + 1,
          );
          if (decoded === undefined) {
            throw new AdminHttpContractError(`${path}[${index}]`, 'tuple item cannot be omitted');
          }
          return decoded;
        }),
      );
    }
    case 'union': {
      const union = contract as AdminUnionResponseContract<AdminResponseContractTuple>;
      const matches: JsonValue[] = [];
      const failures: string[] = [];
      for (const variant of union.variants) {
        try {
          const decoded = decodeAdminInboundContractValue(
            variant,
            value,
            path,
            representation,
            budget,
            depth,
          );
          if (decoded !== undefined) matches.push(decoded);
        } catch (error) {
          if (!(error instanceof AdminHttpContractError)) throw error;
          failures.push(error.message);
        }
      }
      if (matches.length !== 1) {
        throw new AdminHttpContractError(
          path,
          matches.length === 0
            ? `did not match any request variant (${failures.join('; ')})`
            : 'request value ambiguously matches multiple variants',
        );
      }
      return matches[0];
    }
  }
}

function decodeAdminInboundObjectSection(
  contract: AdminRequestObjectContract,
  value: unknown,
  path: string,
  budget: AdminInboundDecodeBudget,
): Readonly<Record<string, JsonValue>> {
  const decoded = decodeAdminInboundContractValue(
    contract,
    value ?? Object.create(null),
    path,
    'uri',
    budget,
    0,
  );
  if (decoded === undefined || !isJsonRecord(decoded)) {
    throw new AdminHttpContractError(path, 'request section did not decode to an object');
  }
  return decoded;
}

function decodeAdminInboundQuerySection(
  contract: AdminRequestObjectContract,
  codecs: Readonly<Record<string, AdminQueryCodecV1>>,
  value: unknown,
  budget: AdminInboundDecodeBudget,
): Readonly<Record<string, JsonValue>> {
  const entries = inboundOwnDataEntries(value ?? Object.create(null), '$.request.query');
  const received = new Map(entries);
  for (const key of received.keys()) {
    if (!Object.prototype.hasOwnProperty.call(contract.fields, key)) {
      throw new AdminHttpContractError(
        `$.request.query.${key}`,
        'field is not declared by this request contract',
      );
    }
  }
  const normalized = mutableNullPrototypeRecord<unknown>();
  for (const [key, field] of Object.entries(contract.fields)) {
    if (!received.has(key)) continue;
    const raw = received.get(key);
    const codec = codecs[key];
    if (codec === undefined) {
      throw new AdminHttpContractError(
        `$.request.queryCodecs.${key}`,
        'query field has no executable wire codec',
      );
    }
    if (codec === 'scalar') {
      if (Array.isArray(raw)) {
        throw new AdminHttpContractError(
          `$.request.query.${key}`,
          'scalar query field cannot be repeated',
        );
      }
      normalized[key] = raw;
      continue;
    }
    if (codec === 'repeated') {
      normalized[key] = Array.isArray(raw) ? raw : [raw];
      continue;
    }
    if (typeof raw !== 'string') {
      throw new AdminHttpContractError(
        `$.request.query.${key}`,
        'comma-separated query field must have one string value',
      );
    }
    const values = raw.split(',');
    const scalar = unwrapOptionalAdminContract(field);
    for (let index = 0; index < values.length; index++) {
      decodeAdminInboundContractValue(
        scalar,
        values[index],
        `$.request.query.${key}[${index}]`,
        'uri',
        budget,
        1,
      );
    }
    normalized[key] = values.join(',');
  }
  return decodeAdminInboundObjectSection(contract, normalized, '$.request.query', budget);
}

/**
 * Decode one raw HTTP request against the generated request DAG. This is a
 * validation boundary, not a response projection: every undeclared key is an
 * error and the returned graph is the sole canonical value written to Nest's
 * request object before ValidationPipe performs class transformation and
 * class-validator checks.
 */
export function decodeAdminInboundRequestV1(
  contract: AdminRouteRequestContract,
  candidate: AdminInboundRequestCandidateV1,
): DecodedAdminInboundRequestV1 {
  const entries = inboundOwnDataEntries(candidate, '$.request');
  const allowed = new Set(['body', 'headers', 'path', 'query']);
  for (const [key] of entries) {
    if (!allowed.has(key)) {
      throw new AdminHttpContractError(`$.request.${key}`, 'unknown request section');
    }
  }
  const budget: AdminInboundDecodeBudget = { depth: 0, nodes: 0 };
  const path = decodeAdminInboundObjectSection(
    contract.path,
    candidate.path,
    '$.request.path',
    budget,
  );
  const query = decodeAdminInboundQuerySection(
    contract.query,
    contract.queryCodecs,
    candidate.query,
    budget,
  );
  const headers = decodeAdminInboundObjectSection(
    contract.headers,
    candidate.headers,
    '$.request.headers',
    budget,
  );
  const body = decodeAdminInboundContractValue(
    contract.body,
    candidate.body,
    '$.request.body',
    'json',
    budget,
    0,
  );
  return Object.freeze({
    path,
    query,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function unwrapOptionalAdminContract(
  contract: AdminResponseContract<unknown, unknown>,
): AdminResponseContract<unknown, unknown> {
  return contract.kind === 'optional'
    ? (contract as AdminOptionalResponseContract<AdminResponseContract<unknown, unknown>>).value
    : contract;
}

function createAdminRouteClientPolicy(
  method: AdminHttpMethod,
  authorization: AdminRouteAuthorizationV1,
  request: AdminRouteRequestContract,
  successStatusCodes: readonly number[],
  successMediaType: AdminRouteClientPolicy['successMediaType'],
): AdminRouteClientPolicy {
  const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const callerHeaderNames = Object.keys(request.headers.fields).sort();
  return Object.freeze({
    ...authorization,
    tenantScope: 'platform' as const,
    // Admin HTTP is bearer-only. Cookie credentials are never sent to these
    // routes, so a double-submit CSRF token would be a dead, misleading control.
    csrf: 'forbidden' as const,
    mediaType: request.contentType,
    successStatusCodes: Object.freeze([...successStatusCodes]),
    successMediaType,
    deadlineMs: 60_000,
    retry: safeMethod
      ? Object.freeze({
          mode: 'safe-exponential' as const,
          maxRetries: 3,
          baseDelayMs: 1_000,
          maxDelayMs: 10_000,
        })
      : Object.freeze({ mode: 'none' as const }),
    callerHeaderNames: Object.freeze(callerHeaderNames),
  });
}

function projectedRequestObject(
  contract: AdminRequestObjectContract,
  value: unknown,
  path: string,
  uriScalarCoercion = false,
): Readonly<Record<string, JsonValue>> {
  try {
    return projectAdminResponse(
      contract,
      uriScalarCoercion ? coerceAdminUriInput(contract, value, path) : value,
    );
  } catch (error) {
    if (error instanceof AdminHttpContractError) {
      throw new AdminHttpContractError(`${path}${error.path.slice(1)}`, error.message);
    }
    throw error;
  }
}

function coerceAdminUriInput(
  contract: AdminResponseContract<unknown, unknown>,
  value: unknown,
  path: string,
): unknown {
  if (contract.kind === 'optional') {
    return value === undefined
      ? undefined
      : coerceAdminUriInput(
          (contract as AdminOptionalResponseContract<AdminResponseContract<unknown, unknown>>)
            .value,
          value,
          path,
        );
  }
  if (contract.kind === 'nullable') {
    return value === null
      ? null
      : coerceAdminUriInput(
          (contract as AdminNullableResponseContract<AdminResponseContract<unknown, unknown>>)
            .value,
          value,
          path,
        );
  }
  if (contract.kind === 'string') {
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  }
  if (contract.kind === 'array') {
    if (!Array.isArray(value)) return value;
    const item = (contract as AdminArrayResponseContract<AdminResponseContract<unknown, unknown>>)
      .item;
    return value.map((entry, index) => coerceAdminUriInput(item, entry, `${path}[${index}]`));
  }
  if (contract.kind !== 'object' || typeof value !== 'object' || value === null) return value;
  const objectContract = contract as AdminRequestObjectContract;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) {
      throw new AdminHttpContractError(
        `${path}.${field}`,
        'URI input fields must be data properties',
      );
    }
    const fieldContract = objectContract.fields[field];
    output[field] =
      fieldContract === undefined
        ? descriptor.value
        : coerceAdminUriInput(fieldContract, descriptor.value, `${path}.${field}`);
  }
  return output;
}

function requestSectionInput(
  input: Readonly<Record<string, unknown>>,
  name: 'headers' | 'path' | 'query',
  contract: AdminRequestObjectContract,
): unknown {
  const hasFields = Object.keys(contract.fields).length > 0;
  const value = input[name];
  if (value === undefined) return hasFields ? {} : {};
  return value;
}

function projectedQueryObject(
  contract: AdminRequestObjectContract,
  codecs: Readonly<Record<string, AdminQueryCodecV1>>,
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdminHttpContractError('$.request.query', 'query input must be an object');
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AdminHttpContractError(
      '$.request.query',
      'query input must have a plain or null prototype',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const field of Object.keys(descriptors)) {
    if (contract.fields[field] === undefined) {
      throw new AdminHttpContractError(
        `$.request.query.${field}`,
        'field is not declared by this route',
      );
    }
  }
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const [field, fieldContract] of Object.entries(contract.fields)) {
    const descriptor = descriptors[field];
    if (descriptor !== undefined && !('value' in descriptor)) {
      throw new AdminHttpContractError(
        `$.request.query.${field}`,
        'query fields must be data properties',
      );
    }
    const fieldValue: unknown = descriptor === undefined ? undefined : descriptor.value;
    const codec = codecs[field];
    if (codec === undefined) {
      throw new AdminHttpContractError(
        `$.request.queryCodecs.${field}`,
        'query field has no executable wire codec',
      );
    }
    if (codec === 'scalar') {
      const projected = projectAdminResponse(
        fieldContract,
        coerceAdminUriInput(fieldContract, fieldValue, `$.request.query.${field}`),
      );
      if (projected !== undefined) output[field] = projected;
      continue;
    }
    if (fieldValue === undefined && fieldContract.kind === 'optional') continue;
    if (!Array.isArray(fieldValue)) {
      throw new AdminHttpContractError(
        `$.request.query.${field}`,
        `${codec} query field requires an array`,
      );
    }
    const unwrapped = unwrapOptionalAdminContract(fieldContract);
    const itemContract =
      codec === 'repeated' && unwrapped.kind === 'array'
        ? (unwrapped as AdminArrayResponseContract<AdminResponseContract<unknown, unknown>>).item
        : unwrapped;
    const projectedItems = fieldValue.map((entry, index) => {
      const projected = projectAdminResponse(
        itemContract,
        coerceAdminUriInput(itemContract, entry, `$.request.query.${field}[${index}]`),
      );
      if (projected === undefined) {
        throw new AdminHttpContractError(
          `$.request.query.${field}[${index}]`,
          'query array item cannot be omitted',
        );
      }
      return projected;
    });
    output[field] = projectedItems;
  }
  return output;
}

function encodePathParameter(value: JsonValue, path: string): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new AdminHttpContractError(path, 'path parameters must project to scalar values');
  }
  return encodeURIComponent(String(value));
}

function encodeQueryParameter(value: JsonValue, path: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new AdminHttpContractError(path, 'query parameters must project to scalar values');
}

function encodeAdminRequest<TRequest extends AdminRouteRequestContract>(
  routePath: string,
  method: AdminHttpMethod,
  request: TRequest,
  inputValue: AdminRouteRequestInput<TRequest> | undefined,
): EncodedAdminRouteRequest {
  const input = inputValue ?? {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AdminHttpContractError('$.request', 'route input must be an object');
  }
  const inputRecord = input as Readonly<Record<string, unknown>>;
  const allowedKeys = new Set(['signal']);
  if (Object.keys(request.path.fields).length > 0) allowedKeys.add('path');
  if (Object.keys(request.query.fields).length > 0) allowedKeys.add('query');
  if (Object.keys(request.headers.fields).length > 0) allowedKeys.add('headers');
  if (request.body.kind !== 'void') allowedKeys.add('body');
  for (const key of Object.keys(inputRecord)) {
    if (!allowedKeys.has(key)) {
      throw new AdminHttpContractError(`$.request.${key}`, 'field is not declared by this route');
    }
  }
  if (Object.prototype.hasOwnProperty.call(inputRecord, 'signal')) {
    const signal = inputRecord.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new AdminHttpContractError('$.request.signal', 'signal must be an AbortSignal');
    }
  }

  const pathValues = projectedRequestObject(
    request.path,
    requestSectionInput(inputRecord, 'path', request.path),
    '$.request.path',
    true,
  );
  const endpointPath = routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, field: string) => {
    if (!Object.prototype.hasOwnProperty.call(pathValues, field)) {
      throw new AdminHttpContractError(`$.request.path.${field}`, 'required path field is missing');
    }
    const pathValue = pathValues[field];
    if (pathValue === undefined) {
      throw new AdminHttpContractError(`$.request.path.${field}`, 'path value is unavailable');
    }
    return encodePathParameter(pathValue, `$.request.path.${field}`);
  });

  const queryValues = projectedQueryObject(
    request.query,
    request.queryCodecs,
    requestSectionInput(inputRecord, 'query', request.query),
  );
  const search = new URLSearchParams();
  for (const [field, value] of Object.entries(queryValues)) {
    if (value === undefined || value === null) continue;
    const codec = request.queryCodecs[field];
    if (codec === undefined) {
      throw new AdminHttpContractError(
        `$.request.queryCodecs.${field}`,
        'query field has no executable wire codec',
      );
    }
    if (codec === 'scalar') {
      if (isJsonValueArray(value)) {
        throw new AdminHttpContractError(
          `$.request.query.${field}`,
          'scalar query field cannot receive an array',
        );
      }
      search.set(field, encodeQueryParameter(value, `$.request.query.${field}`));
      continue;
    }
    if (!isJsonValueArray(value)) {
      throw new AdminHttpContractError(
        `$.request.query.${field}`,
        `${codec} query field requires an array`,
      );
    }
    const encodedValues = value.map((entry, index) =>
      encodeQueryParameter(entry, `$.request.query.${field}[${index}]`),
    );
    if (codec === 'repeated') {
      for (const entry of encodedValues) search.append(field, entry);
    } else {
      search.set(field, encodedValues.join(','));
    }
  }
  const query = search.toString();

  const headerValues = projectedRequestObject(
    request.headers,
    requestSectionInput(inputRecord, 'headers', request.headers),
    '$.request.headers',
  );
  const headers: Record<string, string> = {};
  for (const [field, value] of Object.entries(headerValues)) {
    if (typeof value !== 'string') {
      throw new AdminHttpContractError(
        `$.request.headers.${field}`,
        'header value must be a string',
      );
    }
    headers[field] = value;
  }

  let body: string | undefined;
  if (request.body.kind !== 'void') {
    const projected = projectAdminResponse(request.body, inputRecord.body);
    body = JSON.stringify(projected);
    if (new TextEncoder().encode(body).byteLength > ADMIN_JSON_CODEC_POLICY.maxWireBytes) {
      throw new AdminHttpContractError(
        '$.request.body',
        `request body exceeds ${ADMIN_JSON_CODEC_POLICY.maxWireBytes} UTF-8 wire bytes`,
      );
    }
  }
  return Object.freeze({
    endpoint: `${endpointPath}${query.length > 0 ? `?${query}` : ''}`,
    method,
    headers: Object.freeze(headers),
    ...(body === undefined ? {} : { body }),
    ...(inputRecord.signal instanceof AbortSignal ? { signal: inputRecord.signal } : {}),
  });
}

function routePathFieldNames(routePath: string): readonly string[] {
  const names: string[] = [];
  for (const segment of routePath.split('/')) {
    if (!segment.startsWith(':')) continue;
    const name = segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.includes(name)) {
      throw new AdminHttpContractError(
        '$.route.path',
        'route path parameters must be unique names',
      );
    }
    names.push(name);
  }
  return names.sort();
}

function assertRoutePathRequestEquality(
  routePath: string,
  request: AdminRouteRequestContract,
): void {
  const routeFields = routePathFieldNames(routePath);
  const contractFields = Object.keys(request.path.fields).sort();
  if (
    routeFields.length !== contractFields.length ||
    routeFields.some((field, index) => field !== contractFields[index])
  ) {
    throw new AdminHttpContractError(
      '$.request.path',
      'route parameter names must exactly equal the executable path field set',
    );
  }
}

export function createAdminRouteDefinition<
  const TMethod extends AdminHttpMethod,
  const TPath extends `/${string}` | '/',
  const TRequest extends AdminRouteRequestContract,
  const TContract extends AdminResponseContract<unknown, unknown>,
>(
  method: TMethod,
  path: TPath,
  request: TRequest,
  authorization: AdminRouteAuthorizationV1,
  successStatusCode: number,
  contract: TContract,
): AdminRouteDefinition<TContract, TMethod, TPath, TRequest> {
  const validatedAuthorization = validatedAdminRouteAuthorizationV1(authorization);
  if (!isExecutableAdminResponseContract(contract)) {
    throw new AdminHttpContractError(
      '$.contract',
      'route definition requires a closed executable admin response contract',
    );
  }
  if (
    !Number.isSafeInteger(successStatusCode) ||
    successStatusCode < 200 ||
    successStatusCode > 299
  ) {
    throw new AdminHttpContractError('$.status', 'success status must be one 2xx integer');
  }
  if (successStatusCode === 204 && contract.kind !== 'void') {
    throw new AdminHttpContractError(
      '$.status',
      '204 success is valid only for a void response contract',
    );
  }
  assertRoutePathRequestEquality(path, request);
  const policy = createAdminRouteClientPolicy(
    method,
    validatedAuthorization,
    request,
    [successStatusCode],
    successStatusCode === 204 ? null : 'application/json',
  );
  const id = `${method} ${path}` as const;
  return Object.freeze({
    transport: 'json-envelope' as const,
    id,
    method,
    path,
    request,
    policy,
    contract,
    encode: (input: AdminRouteRequestInput<TRequest> | undefined): EncodedAdminRouteRequest =>
      encodeAdminRequest(path, method, request, input),
    decode: (value: unknown): AdminWireResponseOf<TContract> =>
      decodeAdminWireResponse(contract, value),
  });
}

export function createAdminBinaryRouteDefinition<
  const TMethod extends AdminHttpMethod,
  const TPath extends `/${string}` | '/',
  const TRequest extends AdminRouteRequestContract,
  const TProfile extends AdminBinaryResponseProfile,
>(
  method: TMethod,
  path: TPath,
  request: TRequest,
  authorization: AdminRouteAuthorizationV1,
  profile: TProfile,
): AdminBinaryRouteDefinition<TProfile, TMethod, TPath, TRequest> {
  const validatedAuthorization = validatedAdminRouteAuthorizationV1(authorization);
  if (!isExecutableAdminManualResponseProfile(profile) || profile.kind !== 'binary-download') {
    throw new AdminHttpContractError(
      '$.profile',
      'binary route definition requires a sealed executable binary profile',
    );
  }
  assertRoutePathRequestEquality(path, request);
  const policy = createAdminRouteClientPolicy(
    method,
    validatedAuthorization,
    request,
    profile.statusCodes,
    null,
  );
  const id = `${method} ${path}` as const;
  return Object.freeze({
    transport: 'binary-download' as const,
    id,
    method,
    path,
    request,
    policy,
    profile,
    encode: (input: AdminRouteRequestInput<TRequest> | undefined): EncodedAdminRouteRequest =>
      encodeAdminRequest(path, method, request, input),
  });
}

/**
 * Strict application-boundary recognition for backend page producers.
 *
 * The TypeScript brand does not exist on older producer objects at runtime.
 * A value is therefore recognized only when it has the complete canonical key
 * set and all redundant fields agree. Partial pagination-like objects are not
 * guessed into the contract.
 */
export function decodeStandardPaginatedResultCandidate(
  value: unknown,
): StandardPaginatedResult<JsonValue> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (!STANDARD_PAGE_KEYS.every((key) => keys.includes(key))) {
    return null;
  }

  const pageRecord = decodeRecord(toJsonValue(value), '$');
  assertExactKeys(pageRecord, STANDARD_PAGE_KEYS, '$');
  if (!Array.isArray(pageRecord.items)) {
    throw new AdminHttpContractError('$.items', 'expected an array');
  }
  const total = decodeNumber(pageRecord.total, '$.total');
  const page = decodeNumber(pageRecord.page, '$.page');
  const limit = decodeNumber(pageRecord.limit, '$.limit');
  const totalPages = decodeNumber(pageRecord.totalPages, '$.totalPages');
  const hasNextPage = decodeBoolean(pageRecord.hasNextPage, '$.hasNextPage');
  const hasPreviousPage = decodeBoolean(pageRecord.hasPreviousPage, '$.hasPreviousPage');
  const expected = expectedTotalPages(total, limit);
  if (totalPages !== expected) {
    throw new AdminHttpContractError(
      '$.totalPages',
      `expected ${expected}, received ${totalPages}`,
    );
  }
  const result = createStandardPaginatedResult(pageRecord.items, total, page, limit);
  if (hasNextPage !== result.hasNextPage || hasPreviousPage !== result.hasPreviousPage) {
    throw new AdminHttpContractError(
      '$',
      'pagination navigation flags are inconsistent with page metadata',
    );
  }
  return result;
}

export interface DecodedAdminHttpEnvelopeV1 {
  readonly data: JsonValue;
  readonly timestamp: string;
  readonly requestId: string;
  readonly pagination?: AdminPaginationMetadataV1;
}

export function decodeAdminHttpEnvelopeV1(value: unknown): DecodedAdminHttpEnvelopeV1 {
  const json = decodeJsonValue(value);
  const envelope = decodeRecord(json, '$');
  assertExactKeys(envelope, ['contractVersion', 'success', 'data', 'meta'], '$');

  if (envelope.contractVersion !== ADMIN_HTTP_CONTRACT_VERSION) {
    throw new AdminHttpContractError(
      '$.contractVersion',
      `expected ${ADMIN_HTTP_CONTRACT_VERSION}`,
    );
  }
  if (envelope.success !== true) {
    throw new AdminHttpContractError('$.success', 'expected true');
  }

  const meta = decodeRecord(envelope.meta ?? null, '$.meta');
  const metaKeys = Object.keys(meta);
  const hasPagination = metaKeys.includes('pagination');
  assertExactKeys(
    meta,
    hasPagination ? ['timestamp', 'requestId', 'pagination'] : ['timestamp', 'requestId'],
    '$.meta',
  );
  const timestamp = decodeTimestamp(meta.timestamp, '$.meta.timestamp');
  const requestId = decodeAdminRequestId(meta.requestId);

  if (!hasPagination) {
    return { data: envelope.data ?? null, timestamp, requestId };
  }

  const paginationRecord = decodeRecord(meta.pagination ?? null, '$.meta.pagination');
  assertExactKeys(paginationRecord, ['total', 'page', 'limit', 'totalPages'], '$.meta.pagination');
  const total = decodeNumber(paginationRecord.total, '$.meta.pagination.total');
  const page = decodeNumber(paginationRecord.page, '$.meta.pagination.page');
  const limit = decodeNumber(paginationRecord.limit, '$.meta.pagination.limit');
  const totalPages = decodeNumber(paginationRecord.totalPages, '$.meta.pagination.totalPages');
  assertInteger(total, '$.meta.pagination.total', 0);
  assertInteger(page, '$.meta.pagination.page', 1);
  assertInteger(limit, '$.meta.pagination.limit', 1);
  assertInteger(totalPages, '$.meta.pagination.totalPages', 0);
  if (totalPages !== expectedTotalPages(total, limit)) {
    throw new AdminHttpContractError(
      '$.meta.pagination.totalPages',
      `is inconsistent with total=${total} and limit=${limit}`,
    );
  }
  return {
    data: envelope.data ?? null,
    timestamp,
    requestId,
    pagination: { total, page, limit, totalPages },
  };
}

export function encodeAdminHttpValueV1(
  value: unknown,
  timestamp: string,
  requestId: string,
): AdminHttpSuccessEnvelopeV1 {
  return {
    contractVersion: ADMIN_HTTP_CONTRACT_VERSION,
    success: true,
    data: toJsonValue(value),
    meta: {
      timestamp: decodeTimestamp(timestamp, 'timestamp'),
      requestId: decodeAdminRequestId(requestId),
    },
  };
}

export function encodeAdminHttpPageV1<T>(
  page: StandardPaginatedResult<T>,
  timestamp: string,
  requestId: string,
): AdminHttpSuccessEnvelopeV1 {
  return {
    contractVersion: ADMIN_HTTP_CONTRACT_VERSION,
    success: true,
    data: toJsonValue(page.items),
    meta: {
      timestamp: decodeTimestamp(timestamp, 'timestamp'),
      requestId: decodeAdminRequestId(requestId),
      pagination: {
        total: page.total,
        page: page.page,
        limit: page.limit,
        totalPages: page.totalPages,
      },
    },
  };
}

export function decodeAdminHttpValueV1<T>(value: unknown, decoder: WireDecoder<T>): T {
  const envelope = decodeAdminHttpEnvelopeV1(value);
  if (envelope.pagination !== undefined) {
    throw new AdminHttpContractError('$', 'expected a non-paginated response');
  }
  return decoder.decode(envelope.data, '$.data');
}

export function decodeAdminHttpPageV1<T>(
  value: unknown,
  itemDecoder: WireDecoder<T>,
): StandardPaginatedResult<T> {
  const envelope = decodeAdminHttpEnvelopeV1(value);
  if (envelope.pagination === undefined) {
    throw new AdminHttpContractError('$', 'expected a paginated response');
  }
  if (!isJsonValueArray(envelope.data)) {
    throw new AdminHttpContractError('$.data', 'expected an array for a paginated response');
  }

  const items = envelope.data.map((entry, index) => itemDecoder.decode(entry, `$.data[${index}]`));
  return createStandardPaginatedResult(
    items,
    envelope.pagination.total,
    envelope.pagination.page,
    envelope.pagination.limit,
  );
}

export const jsonValueDecoder: WireDecoder<JsonValue> = {
  contractName: 'JsonValue',
  decode(value: JsonValue): JsonValue {
    return value;
  },
};
