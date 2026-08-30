import { ClientProxy } from '@nestjs/microservices';
import {
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_SUBJECTS,
  MarineProviderCredentialMutationOutcome,
  MarineProviderCredentialResolveOutcome,
  canonicalMarineProviderCredentialBody,
  type MarineProviderCredentialRequest,
} from '@platform/event-contracts';
import { of, throwError } from 'rxjs';

import { generateServiceIdentityHeadersV2 } from '../utils/service-identity.util';

import {
  MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
  MarineProviderCredentialClient,
  MarineProviderCredentialTransportError,
} from './marine-provider-credential.client';

jest.mock('../http/signed-http-client', () => ({
  buildSignedInternalHeaders: jest.fn(
    (input: {
      serviceName: string;
      tenantId: string;
      method: string;
      path: string;
      body: string;
    }) =>
      generateServiceIdentityHeadersV2({
        ...input,
        secret: 'client-test-secret',
        keyId: 'test',
      }),
  ),
}));

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('MarineProviderCredentialClient', () => {
  it('sends one canonical, signed atomic CDSE bundle to its exact key', async () => {
    const requests: MarineProviderCredentialRequest[] = [];
    const subjects: string[] = [];
    const send = jest.fn((subject: string, request: MarineProviderCredentialRequest) => {
      subjects.push(subject);
      requests.push(request);
      return of({
        outcome: MarineProviderCredentialMutationOutcome.APPLIED,
        success: true,
        sourceTenantId: TENANT_ID,
        configVersion: 3,
      });
    });
    const clientProxy = { send: send as ClientProxy['send'] };
    const client = new MarineProviderCredentialClient(
      clientProxy as ClientProxy,
      MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
    );

    await client.upsert('CDSE', TENANT_ID, {
      clientId: 'client',
      clientSecret: 'secret',
      instanceId: 'instance',
    });

    const subject = subjects[0];
    const payload = requests[0];
    if (!payload) {
      throw new Error('Expected a captured CDSE credential request');
    }
    expect(subject).toBe(MARINE_PROVIDER_CREDENTIAL_SUBJECTS.UPSERT);
    expect(payload).toMatchObject({
      tenantId: TENANT_ID,
      service: 'farm-service',
      key: 'marine.cdse.credentials',
      actorId: MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
      bundleJson: '{"clientId":"client","clientSecret":"secret","instanceId":"instance"}',
    });
    expect(payload.identity['X-Service-Body-Hash']).toBeDefined();
    expect(
      canonicalMarineProviderCredentialBody({
        operation: 'upsert',
        tenantId: payload.tenantId,
        service: payload.service,
        key: payload.key,
        actorId: payload.actorId,
        bundleJson: payload.bundleJson,
      }),
    ).toContain(payload.bundleJson);
  });

  it('passes through a terminal tenant-erased receipt and rejects expanded mutation replies', async () => {
    const send = jest.fn(() =>
      of({
        outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
        success: false,
        sourceTenantId: null,
        configVersion: null,
      }),
    );
    const client = new MarineProviderCredentialClient(
      { send } as Pick<ClientProxy, 'send'> as ClientProxy,
      MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
    );

    await expect(
      client.upsert('CDSE', TENANT_ID, { clientId: 'client', clientSecret: 'secret' }),
    ).resolves.toEqual({
      outcome: MarineProviderCredentialMutationOutcome.TENANT_ERASED,
      success: false,
      sourceTenantId: null,
      configVersion: null,
    });

    send.mockReturnValueOnce(
      of({
        outcome: MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE,
        success: false,
        sourceTenantId: null,
        configVersion: null,
        internalError: 'must not cross the trust boundary',
      }),
    );
    await expect(
      client.upsert('CDSE', TENANT_ID, { clientId: 'client', clientSecret: 'secret' }),
    ).rejects.toEqual(new MarineProviderCredentialTransportError());
  });

  it('resolves only the exact CDSE bundle key for the requested tenant', async () => {
    const send = jest.fn((_subject: string, request: MarineProviderCredentialRequest) =>
      of({
        outcome: MarineProviderCredentialResolveOutcome.RESOLVED,
        found: true,
        bundleJson: '{"clientId":"client","clientSecret":"secret"}',
        sourceTenantId: request.tenantId,
        configVersion: 4,
      }),
    );
    const clientProxy = { send: send as ClientProxy['send'] };
    const client = new MarineProviderCredentialClient(
      clientProxy as ClientProxy,
      MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
    );

    await expect(client.resolve('CDSE', TENANT_ID)).resolves.toMatchObject({
      found: true,
      sourceTenantId: TENANT_ID,
    });
    expect(send).toHaveBeenCalledWith(
      MARINE_PROVIDER_CREDENTIAL_SUBJECTS.RESOLVE,
      expect.objectContaining({
        tenantId: TENANT_ID,
        key: 'marine.cdse.credentials',
        actorId: MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID,
      }),
    );
  });

  it('passes through only the exact sanitized unavailable outcome', async () => {
    const send = jest.fn(() =>
      of({
        outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
        found: false,
        bundleJson: null,
        sourceTenantId: null,
        configVersion: null,
      }),
    );
    const client = new MarineProviderCredentialClient(
      { send } as Pick<ClientProxy, 'send'> as ClientProxy,
      MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
    );

    await expect(client.resolve('CDSE', TENANT_ID)).resolves.toEqual({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });

    send.mockReturnValueOnce(
      of({
        outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
        found: false,
        bundleJson: null,
        sourceTenantId: null,
        configVersion: null,
        internalError: 'must not cross the trust boundary',
      }),
    );
    await expect(client.resolve('CDSE', TENANT_ID)).rejects.toEqual(
      new MarineProviderCredentialTransportError(),
    );
  });

  it('redacts transport details from resolve and upsert failures', async () => {
    const send = jest.fn(() =>
      throwError(() => new Error('transport detail with credential bytes must not escape')),
    );
    const clientProxy: Pick<ClientProxy, 'send'> = { send };
    const client = new MarineProviderCredentialClient(
      clientProxy as ClientProxy,
      MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
    );

    await expect(client.resolve('CDSE', TENANT_ID)).rejects.toEqual(
      new MarineProviderCredentialTransportError(),
    );
    await expect(
      client.upsert('CDSE', TENANT_ID, {
        clientId: 'client',
        clientSecret: 'secret',
      }),
    ).rejects.toEqual(new MarineProviderCredentialTransportError());
  });
});
