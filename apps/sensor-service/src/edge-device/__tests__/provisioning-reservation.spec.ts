/**
 * The Suderra OS provisioning surface (ADR-048 DEC-5.5–5.7, DEC-22;
 * contracts/suderra-edge/v1/delivery.json): what the public endpoint answers
 * and how the service drives the two-phase token. The transitions themselves
 * — the conditional updates and their races — are proven on real Postgres in
 * provisioning-reservation.rls.postgres.spec.ts; here the collaborators are
 * doubles and the subject is the decision logic around them.
 */
import { createHash } from 'crypto';

import { collaborator, stub, stubMember } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { DataSource, Repository } from 'typeorm';

import { DeviceDirectoryService } from '../device-directory.service';
import type { DeviceEventService } from '../device-event.service';
import {
  DELIVERY_CONTENT_TYPE,
  type EdgeProvisioningManifestService,
  ProvisioningRefusal,
  type ProvisioningRefusalReason,
} from '../edge-provisioning-manifest.service';
import type { AdmittedRelease } from '../edge-release-catalog.service';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeAgentChannel,
  EdgeDevice,
} from '../entities/edge-device.entity';
import type { InstallerScriptService } from '../installer-script.service';
import type { MqttAuthService } from '../mqtt-auth.service';
import { PROVISIONING_REFUSAL_BODY, ProvisioningController } from '../provisioning.controller';
import type {
  ProvisioningReservationService,
  Reservation,
} from '../provisioning-reservation.service';
import { ProvisioningService } from '../provisioning.service';
import type { TenantKeyService } from '../tenant-key.service';

const TOKEN = 'ab'.repeat(32);
const TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const QUERY = {
  binding_method: 'tpm-ek-sha256',
  binding_sha256: 'cd'.repeat(32),
  nonce: 'ef'.repeat(16),
  board_profile: 'revpi-connect4',
  os_version: '1.0.0',
  agent_abi: '1-1',
};
const RELEASE = stub<AdmittedRelease>({ version: '1.6.0' });

function device(overrides: Partial<EdgeDevice> = {}): EdgeDevice {
  return Object.assign(new EdgeDevice(), {
    id: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
    tenantId: TENANT,
    deviceCode: 'RPI-0E0E0E0E',
    lifecycleState: DeviceLifecycleState.REGISTERED,
    provisioningToken: createHash('sha256').update(TOKEN).digest('hex'),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    tokenUsedAt: null,
    credentialsIssuedAt: null,
    reservedBindingMethod: null,
    reservedBindingSha256: null,
    reservationExpiresAt: null,
    deviceBindingMethod: null,
    deviceBindingSha256: null,
    agentChannel: EdgeAgentChannel.GENERIC_LINUX,
    mqttClientId: 'edge-dddddddd-rpi-0e0e0e0e',
    deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4,
    ...overrides,
  });
}

interface Harness {
  service: ProvisioningService;
  findDevice: jest.Mock;
  reserve: jest.Mock;
  issueCredentials: jest.Mock;
  preflight: jest.Mock;
  issue: jest.Mock;
}

function harness(found: EdgeDevice | null): Harness {
  const findDevice = jest.fn().mockResolvedValue(found);
  const reserve = jest.fn(
    async (
      _device: unknown,
      _token: string,
      binding: Reservation['binding'],
      _ttl: number,
      now: Date,
      issue: (r: Reservation) => { result: string },
    ) =>
      issue({
        tenantId: TENANT,
        deviceId: found?.id ?? '',
        deviceCode: found?.deviceCode ?? '',
        binding,
        manifestSeq: 7,
        siteConfigSeq: 8,
        window: { notBefore: now, expiresAt: new Date(now.getTime() + 1_800_000) },
      }).result,
  );
  const issueCredentials = jest.fn().mockResolvedValue(true);
  const preflight = jest.fn().mockResolvedValue(RELEASE);
  const issue = jest.fn(() => ({
    body: '{"_type":"delivery"}',
    manifest: { digest: { sha256: '0'.repeat(64) } },
  }));
  const service = new ProvisioningService(
    collaborator<Repository<EdgeDevice>>({}, 'EdgeDeviceRepository'),
    stub<DataSource>({}),
    new ConfigService({}),
    collaborator<MqttAuthService>(
      {
        generateCredentials: jest.fn().mockResolvedValue({ password: 'pw', hash: 'hash' }),
        addDeviceCredentials: jest.fn().mockResolvedValue(true),
      },
      'MqttAuthService',
    ),
    collaborator<InstallerScriptService>(
      {
        getProvisioningConfig: jest.fn().mockResolvedValue({
          mqttBroker: 'mqtt.example.com',
          mqttPort: 8883,
          mqttTlsEnabled: true,
        }),
      },
      'InstallerScriptService',
    ),
    collaborator<TenantKeyService>({}, 'TenantKeyService'),
    collaborator<DeviceEventService>({}, 'DeviceEventService'),
    collaborator<DeviceDirectoryService>(
      { findDevice: stubMember<DeviceDirectoryService['findDevice']>(findDevice) },
      'DeviceDirectoryService',
    ),
    collaborator<ProvisioningReservationService>(
      {
        reserve: stubMember<ProvisioningReservationService['reserve']>(reserve),
        issueCredentials:
          stubMember<ProvisioningReservationService['issueCredentials']>(issueCredentials),
      },
      'ProvisioningReservationService',
    ),
    collaborator<EdgeProvisioningManifestService>(
      {
        preflight: stubMember<EdgeProvisioningManifestService['preflight']>(preflight),
        issue: stubMember<EdgeProvisioningManifestService['issue']>(issue),
        reservationTtlMs: 1_800_000,
        deviceBroker: () => ({ host: 'mqtt-devices.example.com', port: 8883, tls: true }),
      },
      'EdgeProvisioningManifestService',
    ),
  );
  return { service, findDevice, reserve, issueCredentials, preflight, issue };
}

async function refusalOf(promise: Promise<unknown>): Promise<ProvisioningRefusalReason> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProvisioningRefusal) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('Suderra OS provisioning delivery (ADR-048 DEC-5.5–5.7)', () => {
  it('issues the delivery under a reservation for the presented binding and nonce', async () => {
    const h = harness(device());
    await expect(h.service.deliverSuderraOsManifest('RPI-0E0E0E0E', TOKEN, QUERY)).resolves.toBe(
      '{"_type":"delivery"}',
    );
    expect(h.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      TOKEN,
      { method: 'tpm-ek-sha256', digest: { sha256: QUERY.binding_sha256 } },
      1_800_000,
      expect.any(Date),
      expect.any(Function),
    );
    expect(h.issue).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSeq: 7, siteConfigSeq: 8, provisioningToken: TOKEN }),
      RELEASE,
      QUERY.nonce,
    );
  });

  it.each<
    [
      string,
      Partial<EdgeDevice> | null,
      Record<string, string>,
      string | undefined,
      ProvisioningRefusalReason,
    ]
  >([
    ['a token in the query', {}, { ...QUERY, token: TOKEN }, TOKEN, 'request-invalid'],
    ['a short nonce', {}, { ...QUERY, nonce: '7e57' }, TOKEN, 'request-invalid'],
    ['no token header', {}, QUERY, undefined, 'request-invalid'],
    ['an unknown device', null, QUERY, TOKEN, 'device-unknown'],
    ['a wrong token', {}, QUERY, 'cd'.repeat(32), 'token-invalid'],
    [
      'a revoked device',
      { lifecycleState: DeviceLifecycleState.REVOKED },
      QUERY,
      TOKEN,
      'device-terminal',
    ],
    ['a spent token', { tokenUsedAt: new Date() }, QUERY, TOKEN, 'token-spent'],
    [
      'an expired token',
      { tokenExpiresAt: new Date(Date.now() - 1000) },
      QUERY,
      TOKEN,
      'token-expired',
    ],
    [
      'other hardware than the device committed',
      { deviceBindingMethod: 'tpm-ek-sha256', deviceBindingSha256: '99'.repeat(32) },
      QUERY,
      TOKEN,
      'binding-differs-from-device',
    ],
  ])(
    'refuses %s before any reservation is taken',
    async (_label, overrides, query, token, reason) => {
      const h = harness(overrides === null ? null : device(overrides));
      await expect(
        refusalOf(h.service.deliverSuderraOsManifest('RPI-0E0E0E0E', token, query)),
      ).resolves.toBe(reason);
      expect(h.reserve).not.toHaveBeenCalled();
    },
  );

  it('refuses when the reservation guard matches no row (the binding is reserved elsewhere)', async () => {
    const h = harness(device());
    h.reserve.mockResolvedValueOnce(null);
    await expect(
      refusalOf(h.service.deliverSuderraOsManifest('RPI-0E0E0E0E', TOKEN, QUERY)),
    ).resolves.toBe('binding-reserved-elsewhere');
  });

  it('refuses without reserving when the board, release or tenant cannot be served', async () => {
    const h = harness(device());
    h.preflight.mockRejectedValueOnce(new ProvisioningRefusal('release-incompatible'));
    await expect(
      refusalOf(h.service.deliverSuderraOsManifest('RPI-0E0E0E0E', TOKEN, QUERY)),
    ).resolves.toBe('release-incompatible');
    expect(h.reserve).not.toHaveBeenCalled();
  });
});

describe('activation issues credentials without spending the token (ADR-048 DEC-5.7)', () => {
  const request = {
    deviceId: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
    token: TOKEN,
    fingerprint: { hostname: 'pond' },
    agentVersion: '1.6.0',
  };

  it('issues through the conditional transition and never writes token_used_at itself', async () => {
    const h = harness(device());
    const response = await h.service.activateDevice(request);
    expect(h.issueCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ id: request.deviceId }),
      TOKEN,
      { fingerprint: request.fingerprint, agentVersion: '1.6.0', mqttPasswordHash: 'hash' },
      expect.any(Date),
    );
    expect(response).toMatchObject({ success: true, mqtt_password: 'pw', mqtt_tls_enabled: true });
  });

  it('names the 8883 TLS device broker to a Suderra OS device', async () => {
    const h = harness(device({ agentChannel: EdgeAgentChannel.SUDERRA_OS }));
    await expect(h.service.activateDevice(request)).resolves.toMatchObject({
      mqtt_broker: 'mqtt-devices.example.com',
      mqtt_port: 8883,
      mqtt_tls_enabled: true,
    });
  });

  it('refuses when the transition guard does not hold (no reservation, token regenerated)', async () => {
    const h = harness(device({ agentChannel: EdgeAgentChannel.SUDERRA_OS }));
    h.issueCredentials.mockResolvedValueOnce(false);
    await expect(h.service.activateDevice(request)).rejects.toMatchObject({ status: 409 });
  });
});

describe('the public endpoint answers every refusal identically (DEC-22, delivery.json refusal)', () => {
  function response(): {
    res: Response;
    sent: { status?: number; type?: string; body?: string; headers: Record<string, string> };
  } {
    const sent: { status?: number; type?: string; body?: string; headers: Record<string, string> } =
      { headers: {} };
    const res = stub<Response>({});
    Object.assign(res, {
      status: (code: number) => {
        sent.status = code;
        return res;
      },
      set: (name: string, value: string) => {
        sent.headers[name] = value;
        return res;
      },
      contentType: (type: string) => {
        sent.type = type;
        return res;
      },
      send: (body: string) => {
        sent.body = body;
        return res;
      },
    });
    return { res, sent };
  }

  it.each<ProvisioningRefusalReason>([
    'device-unknown',
    'token-invalid',
    'binding-reserved-elsewhere',
    'channel-unconfigured',
  ])('answers %s with 404 {"error":"unavailable"}', async (reason) => {
    const controller = new ProvisioningController(
      collaborator<ProvisioningService>(
        { deliverSuderraOsManifest: jest.fn().mockRejectedValue(new ProvisioningRefusal(reason)) },
        'ProvisioningService',
      ),
    );
    const { res, sent } = response();
    await controller.getSuderraOsProvisioningDelivery('RPI-0E0E0E0E', TOKEN, QUERY, res);
    expect(sent).toEqual({
      status: 404,
      type: 'application/json',
      body: PROVISIONING_REFUSAL_BODY,
      headers: { 'Cache-Control': 'no-store' },
    });
  });

  it('answers an unexpected failure exactly like a refusal', async () => {
    const controller = new ProvisioningController(
      collaborator<ProvisioningService>(
        { deliverSuderraOsManifest: jest.fn().mockRejectedValue(new Error('db down')) },
        'ProvisioningService',
      ),
    );
    const { res, sent } = response();
    await controller.getSuderraOsProvisioningDelivery('RPI-0E0E0E0E', TOKEN, QUERY, res);
    expect(sent.status).toBe(404);
    expect(sent.body).toBe('{"error":"unavailable"}');
  });

  it('serves the delivery with the contract media type and no caching', async () => {
    const controller = new ProvisioningController(
      collaborator<ProvisioningService>(
        { deliverSuderraOsManifest: jest.fn().mockResolvedValue('{"_type":"delivery"}') },
        'ProvisioningService',
      ),
    );
    const { res, sent } = response();
    await controller.getSuderraOsProvisioningDelivery('RPI-0E0E0E0E', TOKEN, QUERY, res);
    expect(sent).toEqual({
      status: 200,
      type: DELIVERY_CONTENT_TYPE,
      body: '{"_type":"delivery"}',
      headers: { 'Cache-Control': 'no-store' },
    });
  });
});
