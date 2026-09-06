import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  MARINE_PROVIDER_CREDENTIAL_SUBJECTS,
  canonicalMarineProviderCredentialBody,
  marineProviderCredentialKey,
  parseMarineProviderCredentialResolveResult,
  parseMarineProviderCredentialMutationResult,
  serializeMarineProviderCdseCredentialBundle,
  type MarineProviderCdseCredentialBundle,
  type MarineProviderCredentialMutationResult,
  type MarineProviderCredentialOperation,
  type MarineProviderCredentialRequest,
  type MarineProviderCredentialResolveResult,
} from '@platform/event-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

import { serviceIdentityAudienceForService } from '../../../../platform/libs/service-catalog/src/index';
import { buildSignedInternalHeaders } from '../http/signed-http-client';
import { parseNatsRequestTimeout } from '../nats/nats-response-policy';

export const MARINE_PROVIDER_CREDENTIAL_NATS_CLIENT = 'MARINE_PROVIDER_CREDENTIAL_NATS_CLIENT';
export const MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE_TOKEN =
  'MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE_TOKEN';
export const MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE = 'farm-service';

const DEFAULT_TIMEOUT_MS = 5_000;

export type CdseProviderCredentialBundle = MarineProviderCdseCredentialBundle;

/**
 * Config-service CDSE transport/authentication availability failure.
 *
 * It intentionally carries no upstream error message because transport
 * implementations can include request payloads in their errors. Callers can
 * distinguish this from a legitimate `NOT_FOUND` response without risking a
 * credential bundle in logs or public error surfaces.
 */
export class MarineProviderCredentialTransportError extends Error {
  constructor() {
    super('CDSE credential configuration is unavailable');
    this.name = 'MarineProviderCredentialTransportError';
  }
}

/**
 * Signed, exact-key client for farm-service's internal CDSE credentials.
 * It is intentionally not a generic config writer.
 */
@Injectable()
export class MarineProviderCredentialClient {
  private readonly timeoutMs: number;
  private readonly audience = serviceIdentityAudienceForService('config-service');

  constructor(
    @Inject(MARINE_PROVIDER_CREDENTIAL_NATS_CLIENT)
    private readonly client: ClientProxy,
    @Inject(MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE_TOKEN)
    private readonly consumerService: string,
  ) {
    this.timeoutMs = parseNatsRequestTimeout(
      process.env['MARINE_PROVIDER_CREDENTIAL_TIMEOUT_MS'],
      DEFAULT_TIMEOUT_MS,
      'MARINE_PROVIDER_CREDENTIAL_TIMEOUT_MS',
    );
  }

  async resolve(
    provider: 'CDSE',
    tenantId: string,
  ): Promise<MarineProviderCredentialResolveResult> {
    try {
      const rawResult = await this.send<unknown>(
        MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
        'resolve',
        provider,
        tenantId,
        MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
      );
      const result = parseMarineProviderCredentialResolveResult(rawResult);
      if (result === null) {
        throw new MarineProviderCredentialTransportError();
      }
      return result;
    } catch {
      throw new MarineProviderCredentialTransportError();
    }
  }

  async upsert(
    provider: 'CDSE',
    tenantId: string,
    bundle: CdseProviderCredentialBundle,
  ): Promise<MarineProviderCredentialMutationResult> {
    const bundleJson = serializeMarineProviderCdseCredentialBundle(bundle);
    try {
      const rawResult = await this.send<unknown>(
        MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT,
        'upsert',
        provider,
        tenantId,
        MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
        bundleJson,
      );
      const result = parseMarineProviderCredentialMutationResult(rawResult);
      if (result === null) {
        throw new MarineProviderCredentialTransportError();
      }
      return result;
    } catch {
      throw new MarineProviderCredentialTransportError();
    }
  }

  private async send<T>(
    subject: string,
    operation: MarineProviderCredentialOperation,
    provider: 'CDSE',
    tenantId: string,
    actorId: string,
    bundleJson?: string,
  ): Promise<T> {
    const key = marineProviderCredentialKey(provider);
    const body = canonicalMarineProviderCredentialBody({
      operation,
      tenantId,
      service: MARINE_PROVIDER_CREDENTIAL_SERVICE,
      key,
      actorId,
      bundleJson,
    });
    const identity = buildSignedInternalHeaders({
      serviceName: this.consumerService,
      tenantId,
      method: 'POST',
      path: subject,
      body,
      audience: this.audience,
    });
    const request: MarineProviderCredentialRequest = {
      tenantId,
      service: MARINE_PROVIDER_CREDENTIAL_SERVICE,
      key,
      actorId,
      ...(bundleJson === undefined ? {} : { bundleJson }),
      identity,
    };
    return firstValueFrom(
      this.client.send<T, MarineProviderCredentialRequest>(subject, request).pipe(
        timeout(this.timeoutMs),
        catchError((error: Error) => throwError(() => error)),
      ),
    );
  }
}
