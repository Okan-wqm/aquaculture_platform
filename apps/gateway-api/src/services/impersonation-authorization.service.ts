import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import {
  IMPERSONATION_CREDENTIAL_HEADER,
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  compileImpersonationAuthorizationOperationsV1,
  decodeCanonicalImpersonationPermissionsV1,
  impersonationAuthorizationOperationSetDigestV1,
  impersonationAuthorizationRequestDigestV1,
  isImpersonationContextId,
  isImpersonationCredential,
  sha256Hex,
  type ImpersonationAuthorizationHttpMethod,
  type ImpersonationAuthorizationReceiptCoordinateV1,
  type ImpersonationOperationDescriptor,
  type ImpersonationPermissionsContract,
} from '@aquaculture/shared-contracts';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ValidatedImpersonationAuthorization {
  readonly sessionId: string;
  readonly superAdminId: string;
  readonly targetTenantId: string;
  readonly targetUserId?: string;
  readonly permissions: ImpersonationPermissionsContract;
  readonly expiresAt: string;
}

export interface ImpersonationAuthorizationBaseRequest {
  readonly credential: string;
  readonly authorization: string;
  readonly verifiedUserAssertion: string;
  readonly authorizationReceiptId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly mfaVerified: true;
  readonly targetTenantId: string;
  readonly method: ImpersonationAuthorizationHttpMethod;
  readonly normalizedPath: string;
  readonly normalizedQueryHash: string;
  readonly bodyHash: string;
  readonly clientIp?: string;
  readonly clientUserAgent?: string;
}

export interface ImpersonationAuthorizationReceipt
  extends ValidatedImpersonationAuthorization {
  readonly authorizationReceiptId: string;
  readonly requestDigest: string;
  readonly replayed: boolean;
}

const AUTHORIZATION_CONTEXT_PATH = '/api/impersonation/sessions/authorization-context';
const AUTHORIZATION_RECEIPT_PATH = '/api/impersonation/sessions/authorization-receipts';
const RESPONSE_LIMIT_BYTES = 64 * 1024;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > RESPONSE_LIMIT_BYTES) {
      await response.body?.cancel();
      throw new ServiceUnavailableException('Impersonation authority response exceeded its limit');
    }
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new ServiceUnavailableException(
          'Impersonation authority response exceeded its limit',
        );
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function permissions(value: unknown): ImpersonationPermissionsContract | undefined {
  return decodeCanonicalImpersonationPermissionsV1(value);
}

@Injectable()
export class ImpersonationAuthorizationService {
  private readonly baseUrl: URL;

  constructor(
    configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    const configured =
      configService.get<string>('ADMIN_API_INTERNAL_URL') ??
      configService.get<string>('ADMIN_SERVICE_URL') ??
      (configService.get<string>('NODE_ENV') === 'production'
        ? undefined
        : 'http://localhost:3008');
    if (!configured) {
      throw new Error(
        'ADMIN_API_INTERNAL_URL is required for canonical impersonation authorization receipts',
      );
    }
    this.baseUrl = new URL(configured);
  }

  async resolveContext(
    request: ImpersonationAuthorizationBaseRequest,
  ): Promise<ValidatedImpersonationAuthorization | null> {
    const prepared = this.prepareRequest(request);
    if (!prepared) return null;
    const body = JSON.stringify(prepared.wireCoordinate);
    return this.postAuthority(
      AUTHORIZATION_CONTEXT_PATH,
      request,
      body,
      (data) => this.decodeContext(data, request),
    );
  }

  async authorizeOperations(
    request: ImpersonationAuthorizationBaseRequest,
    operationInput: readonly ImpersonationOperationDescriptor[],
  ): Promise<ImpersonationAuthorizationReceipt | null> {
    const prepared = this.prepareRequest(request);
    const operations = compileImpersonationAuthorizationOperationsV1(operationInput);
    if (!prepared || !operations) return null;
    const operationSetDigest = impersonationAuthorizationOperationSetDigestV1(operations);
    const body = JSON.stringify({
      ...prepared.wireCoordinate,
      operations,
      operationSetDigest,
    });
    return this.postAuthority(AUTHORIZATION_RECEIPT_PATH, request, body, (data) => {
      const context = this.decodeContext(data, request);
      if (
        !context ||
        data.authorizationReceiptId !== request.authorizationReceiptId ||
        data.requestDigest !== prepared.requestDigest ||
        typeof data.replayed !== 'boolean'
      ) {
        return null;
      }
      return {
        ...context,
        authorizationReceiptId: request.authorizationReceiptId,
        requestDigest: prepared.requestDigest,
        replayed: data.replayed,
      };
    });
  }

  private prepareRequest(request: ImpersonationAuthorizationBaseRequest):
    | {
        readonly requestDigest: string;
        readonly wireCoordinate: Readonly<Record<string, unknown>>;
      }
    | undefined {
    if (
      !isImpersonationCredential(request.credential) ||
      request.verifiedUserAssertion.length === 0 ||
      !isImpersonationContextId(request.authorizationReceiptId) ||
      !isImpersonationContextId(request.sessionId) ||
      !isImpersonationContextId(request.actorId) ||
      !isImpersonationContextId(request.targetTenantId) ||
      !request.clientIp ||
      !request.clientUserAgent
    ) {
      return undefined;
    }

    const coordinate: ImpersonationAuthorizationReceiptCoordinateV1 = {
      schemaVersion: IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
      authorizationReceiptId: request.authorizationReceiptId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      mfaVerified: request.mfaVerified,
      effectiveTenantId: request.targetTenantId,
      method: request.method,
      normalizedPath: request.normalizedPath,
      normalizedQueryHash: request.normalizedQueryHash,
      bodyHash: request.bodyHash,
      clientIp: request.clientIp,
      clientUserAgent: request.clientUserAgent,
    };
    let requestDigest: string;
    try {
      requestDigest = impersonationAuthorizationRequestDigestV1(coordinate);
    } catch {
      return undefined;
    }
    return {
      requestDigest,
      wireCoordinate: Object.freeze({
        schemaVersion: coordinate.schemaVersion,
        authorizationReceiptId: coordinate.authorizationReceiptId,
        sessionId: coordinate.sessionId,
        effectiveTenantId: coordinate.effectiveTenantId,
        method: coordinate.method,
        normalizedPath: coordinate.normalizedPath,
        normalizedQueryHash: coordinate.normalizedQueryHash,
        bodyHash: coordinate.bodyHash,
        requestDigest,
      }),
    };
  }

  private async postAuthority<T>(
    path: string,
    request: ImpersonationAuthorizationBaseRequest,
    body: string,
    decode: (data: Readonly<Record<string, unknown>>) => T | null,
  ): Promise<T | null> {
    const url = new URL(this.baseUrl);
    url.pathname = path;
    url.search = '';
    url.hash = '';
    const signedHeaders = buildSignedInternalHeaders({
      serviceName: 'gateway-api',
      tenantId: request.targetTenantId,
      method: 'POST',
      path,
      body,
      audience: 'admin-api-service',
      contentType: 'application/json',
      effectiveTenantId: request.targetTenantId,
      assertionHash: sha256Hex(request.verifiedUserAssertion),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      return await this.circuitBreaker.execute({
        serviceName: 'admin-api-service.impersonation-authority',
        tenantId: request.targetTenantId,
        options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
        fn: async () => {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              ...signedHeaders,
              Authorization: request.authorization,
              [IMPERSONATION_CREDENTIAL_HEADER]: request.credential,
              'X-Verified-User-Assertion': request.verifiedUserAssertion,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body,
            redirect: 'error',
            signal: controller.signal,
          });
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            await response.body?.cancel();
            return null;
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new ServiceUnavailableException('Impersonation authority is unavailable');
          }

          const text = await readBoundedText(response);
          let decoded: unknown;
          try {
            decoded = JSON.parse(text);
          } catch {
            throw new ServiceUnavailableException('Impersonation authority returned invalid JSON');
          }
          const envelope = record(decoded);
          const data = record(envelope?.data);
          return data ? decode(data) : null;
        },
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Impersonation authority request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private decodeContext(
    data: Readonly<Record<string, unknown>>,
    request: ImpersonationAuthorizationBaseRequest,
  ): ValidatedImpersonationAuthorization | null {
    const context = record(data.context);
    const decodedPermissions = permissions(context?.permissions);
    const sessionId = context?.sessionId;
    const superAdminId = context?.superAdminId;
    const targetTenantId = context?.targetTenantId;
    const expiresAt = requiredString(context?.expiresAt);
    const targetUserClaim = context?.targetUserId;
    const targetUserId = isImpersonationContextId(targetUserClaim)
      ? targetUserClaim
      : undefined;
    const targetUserIdIsValid =
      targetUserClaim === undefined || targetUserClaim === null || targetUserId !== undefined;
    if (
      context?.isActive !== true ||
      !isImpersonationContextId(sessionId) ||
      sessionId !== request.sessionId ||
      !isImpersonationContextId(superAdminId) ||
      !isImpersonationContextId(targetTenantId) ||
      superAdminId !== request.actorId ||
      targetTenantId !== request.targetTenantId ||
      !targetUserIdIsValid ||
      !expiresAt ||
      !decodedPermissions ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now()
    ) {
      return null;
    }
    return {
      sessionId,
      superAdminId,
      targetTenantId,
      ...(targetUserId ? { targetUserId } : {}),
      permissions: decodedPermissions,
      expiresAt,
    };
  }
}
