/**
 * EdgeRootHandoffService — the cloud-signed statements a Suderra OS agent
 * carries to root (ADR-048 DEC-5.8, DEC-5.14): the activation receipt until
 * the agent reports it handed, and the device-lifecycle request.
 */
import { collaborator } from '@aquaculture/testing';

import { buildEnterMaintenance } from '../device-lifecycle-statement.service';
import { STATEMENT } from '../edge-contract';
import { type EdgeCommandPublisher } from '../edge-command-publisher.service';
import { EdgeRootHandoffService } from '../edge-root-handoff.service';
import { EdgeAgentChannel } from '../entities/edge-device.entity';
import { Ed25519SigningKey, ManifestSigner } from '../manifest-signer';
import { type ProvisioningReservationService } from '../provisioning-reservation.service';

const TENANT = '7e570000-0000-4000-8000-000000000001';
const DEVICE = '7e570000-0000-4000-8000-0000000000d1';
const RECEIPT = '{"payload":"e30=","payloadType":"application/vnd.suderra.x+json","signatures":[]}';

const DEVICE_CODE = 'RPI-7E57C0DE';
const FROM_DEVICE = { deviceCode: DEVICE, tenantId: TENANT };

const pendingDevice = {
  id: DEVICE,
  tenantId: TENANT,
  deviceCode: DEVICE_CODE,
  agentChannel: EdgeAgentChannel.SUDERRA_OS,
  activationReceipt: RECEIPT,
  activationReceiptHandedAt: null,
};

function harness(publishImpl: () => Promise<void> = async () => undefined): {
  service: EdgeRootHandoffService;
  publish: jest.Mock;
  markReceiptHanded: jest.Mock;
} {
  const publish = jest.fn(publishImpl);
  const markReceiptHanded = jest.fn(async (): Promise<void> => undefined);
  const service = new EdgeRootHandoffService(
    collaborator<EdgeCommandPublisher>({ publish }, 'EdgeCommandPublisher'),
    collaborator<ProvisioningReservationService>(
      { markReceiptHanded },
      'ProvisioningReservationService',
    ),
  );
  return { service, publish, markReceiptHanded };
}

function publishedCommandId(publish: jest.Mock): string {
  const call = publish.mock.calls[0] as [unknown, { commandId: string }];
  return call[1].commandId;
}

describe('EdgeRootHandoffService (ADR-048 DEC-5.8, DEC-5.14)', () => {
  afterEach(() => jest.useRealTimers());

  it('delivers a pending receipt as the statement parameter of activation_receipt', async () => {
    const { service, publish } = harness();
    await expect(service.deliverActivationReceipt(pendingDevice)).resolves.toBe(true);
    expect(publish).toHaveBeenCalledWith(
      { tenantId: TENANT, deviceId: DEVICE },
      {
        commandId: expect.any(String),
        command: 'activation_receipt',
        params: { statement: RECEIPT },
      },
    );
  });

  it('delivers nothing to a generic device, without a receipt, or once handed', async () => {
    const { service, publish } = harness();
    for (const device of [
      { ...pendingDevice, agentChannel: EdgeAgentChannel.GENERIC_LINUX },
      { ...pendingDevice, activationReceipt: null },
      { ...pendingDevice, activationReceiptHandedAt: new Date() },
    ]) {
      await expect(service.deliverActivationReceipt(device)).resolves.toBe(false);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('records the hand-over only when the agent reports handed_to_root', async () => {
    const { service, publish, markReceiptHanded } = harness();
    await service.deliverActivationReceipt(pendingDevice);
    const commandId = publishedCommandId(publish);
    await expect(
      service.handleResponse(FROM_DEVICE, {
        commandId,
        success: true,
        result: { handed_to_root: true },
      }),
    ).resolves.toBe(true);
    expect(markReceiptHanded).toHaveBeenCalledWith(
      { id: DEVICE, tenantId: TENANT },
      expect.any(Date),
    );
    // Settled once: a replayed response answers nothing.
    await expect(
      service.handleResponse(FROM_DEVICE, {
        commandId,
        success: true,
        result: { handed_to_root: true },
      }),
    ).resolves.toBe(false);
    expect(markReceiptHanded).toHaveBeenCalledTimes(1);
  });

  it('settles only from the device the receipt went to', async () => {
    const { service, publish, markReceiptHanded } = harness();
    await service.deliverActivationReceipt(pendingDevice);
    const commandId = publishedCommandId(publish);
    const handed = { commandId, success: true, result: { handed_to_root: true } };
    await expect(
      service.handleResponse({ deviceCode: '7e570000-0000-4000-8000-0000000000d9' }, handed),
    ).resolves.toBe(false);
    await expect(
      service.handleResponse(
        { deviceCode: DEVICE, tenantId: '7e570000-0000-4000-8000-000000000002' },
        handed,
      ),
    ).resolves.toBe(false);
    expect(markReceiptHanded).not.toHaveBeenCalled();
    // A legacy tenant-less topic naming the device code still settles it.
    await expect(service.handleResponse({ deviceCode: DEVICE_CODE }, handed)).resolves.toBe(true);
    expect(markReceiptHanded).toHaveBeenCalledTimes(1);
  });

  it('leaves the receipt pending when the agent refuses it', async () => {
    const { service, publish, markReceiptHanded } = harness();
    await service.deliverActivationReceipt(pendingDevice);
    const commandId = publishedCommandId(publish);
    await expect(
      service.handleResponse(FROM_DEVICE, { commandId, success: false, error: 'receipt refused' }),
    ).resolves.toBe(true);
    await service.deliverActivationReceipt(pendingDevice);
    const retry = publish.mock.calls[1] as [unknown, { commandId: string }];
    await expect(
      service.handleResponse(FROM_DEVICE, {
        commandId: retry[1].commandId,
        success: true,
        result: {},
      }),
    ).resolves.toBe(true);
    expect(markReceiptHanded).not.toHaveBeenCalled();
  });

  it('ignores responses to commands it did not send, and forgets unanswered ones', async () => {
    jest.useFakeTimers();
    const { service, publish, markReceiptHanded } = harness();
    await expect(
      service.handleResponse(FROM_DEVICE, {
        commandId: 'other',
        success: true,
        result: { handed_to_root: true },
      }),
    ).resolves.toBe(false);
    await expect(service.handleResponse(FROM_DEVICE, { success: true })).resolves.toBe(false);
    await service.deliverActivationReceipt(pendingDevice);
    const commandId = publishedCommandId(publish);
    jest.advanceTimersByTime(60_001);
    await expect(
      service.handleResponse(FROM_DEVICE, {
        commandId,
        success: true,
        result: { handed_to_root: true },
      }),
    ).resolves.toBe(false);
    expect(markReceiptHanded).not.toHaveBeenCalled();
  });

  it('a refused publish leaves nothing pending and reaches the caller', async () => {
    const refused = new Error('broker down');
    const { service, publish, markReceiptHanded } = harness(async () => {
      throw refused;
    });
    await expect(service.deliverActivationReceipt(pendingDevice)).rejects.toBe(refused);
    const commandId = publishedCommandId(publish);
    await expect(
      service.handleResponse(FROM_DEVICE, {
        commandId,
        success: true,
        result: { handed_to_root: true },
      }),
    ).resolves.toBe(false);
    expect(markReceiptHanded).not.toHaveBeenCalled();
  });

  it('hands a lifecycle statement to the agent as the DSSE envelope JSON', async () => {
    const { service, publish } = harness();
    const key = Ed25519SigningKey.fromSeed('device-lifecycle', 1, Buffer.alloc(32, 9));
    const statement = new ManifestSigner(key).sign(
      STATEMENT.deviceLifecycle,
      buildEnterMaintenance({
        tenantId: TENANT,
        deviceId: DEVICE,
        binding: { method: 'tpm-ek-sha256', digest: { sha256: 'ab'.repeat(32) } },
        updateSeq: 3,
        notBefore: '2026-10-20T11:00:00Z',
        expiresAt: '2026-10-20T13:00:00Z',
      }),
    );
    await service.requestLifecycle({ id: DEVICE, tenantId: TENANT }, statement);
    expect(publish).toHaveBeenCalledWith(
      { tenantId: TENANT, deviceId: DEVICE },
      {
        commandId: expect.any(String),
        command: 'lifecycle_request',
        params: { statement: JSON.stringify(statement.envelope) },
      },
    );
  });
});
