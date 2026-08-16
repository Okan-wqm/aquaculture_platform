import { createHash } from 'node:crypto';

import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationKeyId,
} from '@aquaculture/configuration-contracts';
import { AuditLogService, AuditSeverity } from '@aquaculture/backend-common/audit';
import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { isValidUUID } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  getServiceIdentityHeader,
  parseServiceIdentityKeyring,
  verifyServiceIdentityRequest,
  type ServiceIdentityKeyringEntry,
} from '@aquaculture/backend-common/utils';
import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_ALLOWLIST,
  MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  MARINE_PROVIDER_CREDENTIAL_SUBJECTS,
  MarineProviderCredentialMutationOutcome,
  MarineProviderCredentialResolveOutcome,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  canonicalMarineProviderCredentialBody,
  parseMarineProviderCdseCredentialBundle,
  type MarineProviderCredentialMutationResult,
  type MarineProviderCredentialOperation,
  type MarineProviderCredentialRequest,
  type MarineProviderCredentialResolveResult,
} from '@platform/event-contracts';

import { serviceIdentityAudiencesForService } from '../../../../../platform/libs/service-catalog/src/index';
import { ApplyConfigurationBatchInputV1 } from '../dto/configuration-snapshot.dto';
import { ConfigEnvironment } from '../entities/configuration.entity';
import { ConfigurationChangeIntentV1 } from '../generated/configuration-graphql.generated';
import { ConfigurationBatchAuthorityService } from '../services/configuration-batch-authority.service';
import { ConfigurationSnapshotService } from '../services/configuration-snapshot.service';
import { ConfigurationService } from '../services/configuration.service';

const NONCE_TTL_SECONDS = 5 * 60;
const MAX_ACTOR_ID_LENGTH = 100;
const ALLOWED_RESOURCES = new Set(MARINE_PROVIDER_CREDENTIAL_ALLOWLIST['farm-service'] ?? []);

interface EffectiveCredential {
  value: string;
  sourceTenantId: string;
  configVersion: number;
}

interface AuthorizedCredentialRequest {
  outcome: 'AUTHORIZED';
  request: MarineProviderCredentialRequest;
  caller: string;
  nonce: string;
}

type CredentialAuthorizationResult =
  | AuthorizedCredentialRequest
  | { outcome: 'DENIED' }
  | { outcome: 'UNAVAILABLE' };

type EffectiveCredentialReadResult =
  | { outcome: 'SUCCESS'; credential: EffectiveCredential | null }
  | { outcome: 'UNAVAILABLE' };

/**
 * Purpose-built config-service boundary for CDSE credentials.
 *
 * It deliberately does not expose generic configuration writes. Every request
 * is bound to the exact farm-service CDSE key, requesting tenant, operation,
 * actor and (for writes) complete JSON bundle by HMAC-v2. NATS cert-CN grants
 * add the broker-level identity boundary.
 */
@Controller()
export class MarineProviderCredentialsNatsHandler {
  private readonly logger = new Logger(MarineProviderCredentialsNatsHandler.name);
  private readonly keyring: ServiceIdentityKeyringEntry[];
  private readonly devSecret: string | undefined;
  private readonly expectedAudiences: readonly string[];

  constructor(
    private readonly configurationService: ConfigurationService,
    private readonly batchAuthority: ConfigurationBatchAuthorityService,
    private readonly snapshotService: ConfigurationSnapshotService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.keyring = parseServiceIdentityKeyring(
      this.configService.get<string>('SERVICE_IDENTITY_KEYRING') ??
        process.env['SERVICE_IDENTITY_KEYRING'],
    );
    this.devSecret =
      process.env['NODE_ENV'] === 'production'
        ? undefined
        : (this.configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET') ??
          this.configService.get<string>('INTERNAL_SERVICE_SECRET'));
    this.expectedAudiences = serviceIdentityAudiencesForService('config-service');
  }

  @MessagePattern(MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE)
  async resolve(@Payload() payload: unknown): Promise<MarineProviderCredentialResolveResult> {
    const authorization = await this.authorize(
      payload,
      'resolve',
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
    );
    if (authorization.outcome === 'UNAVAILABLE') {
      return this.unavailableResolve();
    }
    if (authorization.outcome === 'DENIED') {
      return this.emptyResolve();
    }
    const { request, caller, nonce } = authorization;

    const read = await this.readEffective(request);
    if (read.outcome === 'UNAVAILABLE') {
      return this.unavailableResolve();
    }
    const effective = read.credential;
    if (!effective) {
      const audited = await this.auditSecretDisclosure(request, caller, false, null);
      return audited ? this.emptyResolve() : this.unavailableResolve();
    }
    const valid = parseMarineProviderCdseCredentialBundle(effective.value) !== null;
    if (!valid) {
      await this.audit('marine.provider-credential.denied', request, caller, {
        reason: 'invalid-secret-bundle',
        sourceTenantId: effective.sourceTenantId,
        configVersion: effective.configVersion,
      });
      return this.emptyResolve(effective.sourceTenantId, effective.configVersion);
    }

    const audited = await this.auditSecretDisclosure(request, caller, true, effective);
    if (!audited) {
      return this.unavailableResolve();
    }
    return {
      outcome: MarineProviderCredentialResolveOutcome.RESOLVED,
      found: true,
      bundleJson: effective.value,
      sourceTenantId: effective.sourceTenantId,
      configVersion: effective.configVersion,
    };
  }

  @MessagePattern(MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT)
  async upsert(@Payload() payload: unknown): Promise<MarineProviderCredentialMutationResult> {
    const authorization = await this.authorize(
      payload,
      'upsert',
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
    );
    if (authorization.outcome !== 'AUTHORIZED') {
      return this.emptyMutation();
    }
    const { request, caller, nonce } = authorization;
    if (!request.bundleJson) {
      return this.emptyMutation();
    }
    if (!parseMarineProviderCdseCredentialBundle(request.bundleJson)) {
      await this.audit('marine.provider-credential.denied', request, caller, {
        reason: 'invalid-secret-bundle',
      });
      return this.emptyMutation();
    }
    if (
      !(await this.auditRequired('marine.provider-credential.upsert', request, caller, {
        outcome: 'requested',
      }))
    ) {
      return this.emptyMutation();
    }

    try {
      const current = await this.snapshotService.getSnapshot(
        request.tenantId,
        ConfigEnvironment.ALL,
      );
      const input: ApplyConfigurationBatchInputV1 = {
        operationId: this.operationIdForNonce(caller, nonce),
        targetTenantId: request.tenantId,
        environment: ConfigEnvironment.ALL,
        catalogDigest: CONFIGURATION_CATALOG_DIGEST,
        expectedSnapshotToken: current.snapshotToken,
        reason: 'Marine provider credential bundle upsert',
        changes: [
          {
            keyId: ConfigurationKeyId.MARINE_CDSE_CREDENTIALS,
            intent: ConfigurationChangeIntentV1.SET,
            value: request.bundleJson,
          },
        ],
      };
      const receipt = await this.batchAuthority.apply(
        input,
        request.tenantId,
        request.actorId,
        false,
      );
      const version = receipt.changes[0]?.version;
      if (version === undefined || version === null) {
        throw new Error('Marine provider credential receipt did not carry a version');
      }
      return {
        outcome: MarineProviderCredentialMutationOutcome.APPLIED,
        success: true,
        sourceTenantId: request.tenantId,
        configVersion: version,
      };
    } catch (error) {
      if (error instanceof TenantErasureTombstoneError) {
        await this.audit('marine.provider-credential.denied', request, caller, {
          reason: 'tenant-erased',
        });
        return {
          outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
          success: false,
          sourceTenantId: null,
          configVersion: null,
        };
      }
      this.logger.error('Marine provider credential upsert failed', {
        service: request.service,
        key: request.key,
      });
      return this.emptyMutation();
    }
  }

  private async authorize(
    payload: unknown,
    operation: MarineProviderCredentialOperation,
    subject: string,
  ): Promise<CredentialAuthorizationResult> {
    if (!this.isRequestShapeValid(payload, operation)) {
      await this.auditMalformedDenied(operation);
      return { outcome: 'DENIED' };
    }
    const request = payload;
    const headers =
      request.identity && typeof request.identity === 'object' ? { ...request.identity } : {};
    const outcome = verifyServiceIdentityRequest({
      headers,
      observedMethod: 'POST',
      observedPath: subject,
      observedBody: canonicalMarineProviderCredentialBody({
        operation,
        tenantId: request.tenantId,
        service: request.service,
        key: request.key,
        actorId: request.actorId,
        bundleJson: request.bundleJson,
      }),
      keyring: this.keyring,
      secret: this.devSecret,
      allowUnscopedDevKey: process.env['NODE_ENV'] !== 'production',
      expectedTenantId: request.tenantId,
      expectedAudiences: this.expectedAudiences,
    });
    if (!outcome.valid) {
      await this.auditDenied(
        request,
        outcome.reason,
        getServiceIdentityHeader(headers, 'x-service-identity') ?? 'unknown',
      );
      return { outcome: 'DENIED' };
    }
    if (outcome.serviceName !== 'farm-service') {
      await this.auditDenied(request, 'caller-not-allowed', outcome.serviceName);
      return { outcome: 'DENIED' };
    }
    const nonceClaim = await this.claimNonce(outcome.serviceName, outcome.nonce);
    if (nonceClaim === 'nonce-store-unavailable') {
      await this.auditDenied(request, nonceClaim, outcome.serviceName);
      return { outcome: 'UNAVAILABLE' };
    }
    if (nonceClaim === 'nonce-replay') {
      await this.auditDenied(request, nonceClaim, outcome.serviceName);
      return { outcome: 'DENIED' };
    }
    return {
      outcome: 'AUTHORIZED',
      request,
      caller: outcome.serviceName,
      nonce: outcome.nonce,
    };
  }

  private isRequestShapeValid(
    payload: unknown,
    operation: MarineProviderCredentialOperation,
  ): payload is MarineProviderCredentialRequest {
    if (!this.isRecord(payload)) {
      return false;
    }
    const tenantId = payload['tenantId'];
    const service = payload['service'];
    const key = payload['key'];
    const actorId = payload['actorId'];
    const identity = payload['identity'];
    const bundleJson = payload['bundleJson'];
    if (
      typeof tenantId !== 'string' ||
      !isValidUUID(tenantId) ||
      tenantId === CONFIG_RUNTIME_SYSTEM_TENANT_ID ||
      service !== MARINE_PROVIDER_CREDENTIAL_SERVICE ||
      typeof key !== 'string' ||
      !ALLOWED_RESOURCES.has(`${service}/${key}`) ||
      typeof actorId !== 'string' ||
      actorId.length === 0 ||
      actorId.length > MAX_ACTOR_ID_LENGTH ||
      (operation === 'resolve' && actorId !== MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID) ||
      (operation === 'upsert' && actorId !== MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID) ||
      !this.isRecord(identity) ||
      Object.values(identity).some((value) => typeof value !== 'string')
    ) {
      return false;
    }
    if (operation === 'upsert') {
      return (
        typeof bundleJson === 'string' &&
        parseMarineProviderCdseCredentialBundle(bundleJson) !== null
      );
    }
    return bundleJson === undefined;
  }

  private async readEffective(
    request: MarineProviderCredentialRequest,
  ): Promise<EffectiveCredentialReadResult> {
    try {
      return {
        outcome: 'SUCCESS',
        credential: await this.configurationService.getEffectiveWithMetaFresh(
          request.tenantId,
          ConfigurationKeyId.MARINE_CDSE_CREDENTIALS,
        ),
      };
    } catch {
      this.logger.error('Marine provider credential read failed', {
        service: request.service,
        key: request.key,
      });
      return { outcome: 'UNAVAILABLE' };
    }
  }

  private operationIdForNonce(caller: string, nonce: string): string {
    const value = createHash('sha256')
      .update(`marine-provider-configuration-v1\0${caller}\0${nonce}`, 'utf8')
      .digest('hex');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async claimNonce(
    caller: string,
    nonce: string,
  ): Promise<'claimed' | 'nonce-replay' | 'nonce-store-unavailable'> {
    const nonceDigest = createHash('sha256').update(`${caller}\0${nonce}`, 'utf8').digest('hex');
    try {
      const claimed = await this.redisService.setNx(
        `marine-provider-credential:nonce:v1:${nonceDigest}`,
        'claimed',
        NONCE_TTL_SECONDS,
      );
      return claimed ? 'claimed' : 'nonce-replay';
    } catch {
      // Secret disclosure and credential mutation both fail closed when the
      // shared replay ledger is unavailable. A pod-local fallback would let
      // the same signed request succeed on a peer replica.
      this.logger.error('Marine provider credential replay ledger unavailable');
      return 'nonce-store-unavailable';
    }
  }

  private async auditSecretDisclosure(
    request: MarineProviderCredentialRequest,
    caller: string,
    found: boolean,
    effective: EffectiveCredential | null,
  ): Promise<boolean> {
    return this.auditRequired('marine.provider-credential.resolved', request, caller, {
      outcome: 'allow',
      found,
      sourceTenantId: effective?.sourceTenantId ?? null,
      configVersion: effective?.configVersion ?? null,
    });
  }

  private async auditDenied(
    request: MarineProviderCredentialRequest,
    reason: string,
    caller = 'unknown',
  ): Promise<void> {
    await this.audit('marine.provider-credential.denied', request, caller, {
      outcome: 'deny',
      reason,
    });
  }

  private async auditMalformedDenied(operation: MarineProviderCredentialOperation): Promise<void> {
    try {
      await this.auditLogService.recordAwait({
        action: 'marine.provider-credential.denied',
        resource: 'marine-provider-credential',
        resourceId: operation,
        tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
        userId: 'unknown',
        severity: AuditSeverity.WARNING,
        metadata: { caller: 'unknown', outcome: 'deny', reason: 'invalid-request-shape' },
      });
    } catch {
      this.logger.error('Marine provider credential malformed-request audit failed');
    }
  }

  private async audit(
    action: string,
    request: MarineProviderCredentialRequest,
    caller: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogService.recordAwait({
        action,
        resource: 'marine-provider-credential',
        resourceId: `${request.service}/${request.key}`,
        tenantId: isValidUUID(request.tenantId)
          ? request.tenantId
          : CONFIG_RUNTIME_SYSTEM_TENANT_ID,
        userId: request.actorId,
        severity: action.endsWith('denied') ? AuditSeverity.WARNING : AuditSeverity.INFO,
        metadata: { caller, ...metadata },
      });
    } catch {
      this.logger.error('Marine provider credential audit failed', {
        service: request.service,
        key: request.key,
      });
    }
  }

  private async auditRequired(
    action: string,
    request: MarineProviderCredentialRequest,
    caller: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.auditLogService.recordAwait({
        action,
        resource: 'marine-provider-credential',
        resourceId: `${request.service}/${request.key}`,
        tenantId: request.tenantId,
        userId: request.actorId,
        severity: AuditSeverity.INFO,
        metadata: { caller, ...metadata },
      });
      return true;
    } catch {
      this.logger.error('Required marine provider credential audit failed', {
        service: request.service,
        key: request.key,
      });
      return false;
    }
  }

  private emptyResolve(
    sourceTenantId: string | null = null,
    configVersion: number | null = null,
  ): MarineProviderCredentialResolveResult {
    return {
      outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
      found: false,
      bundleJson: null,
      sourceTenantId,
      configVersion,
    };
  }

  private unavailableResolve(): MarineProviderCredentialResolveResult {
    return {
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    };
  }

  private emptyMutation(): MarineProviderCredentialMutationResult {
    return {
      outcome: MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    };
  }
}
