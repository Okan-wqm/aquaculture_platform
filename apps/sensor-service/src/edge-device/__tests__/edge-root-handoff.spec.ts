/**
 * EdgeRootHandoffService — the cloud-signed statements a Suderra OS agent
 * carries to root (ADR-048 DEC-5.8, DEC-5.14): delivered from the row, paced,
 * until the agent reports the statement handed; settled from the response by
 * the digest it names, by whichever replica receives it.
 */
import { collaborator } from '@aquaculture/testing';

import { type DeviceDirectoryService } from '../device-directory.service';
import { type EdgeCommandPublisher } from '../edge-command-publisher.service';
import { EdgeRootHandoffService } from '../edge-root-handoff.service';
import { DeviceLifecycleState, EdgeAgentChannel, EdgeDevice } from '../entities/edge-device.entity';
import {
  HANDOFF_REDELIVERY_INTERVAL_MS,
  type ProvisioningReservationService,
} from '../provisioning-reservation.service';

const TENANT = '7e570000-0000-4000-8000-000000000001';
const DEVICE = '7e570000-0000-4000-8000-0000000000d1';
const DEVICE_CODE = 'RPI-7E57C0DE';
const NOW = new Date('2026-10-20T12:00:00Z');
const RECEIPT = '{"payloadType":"application/vnd.suderra.edge-activation-receipt.v1+json"}';
const LIFECYCLE = '{"payloadType":"application/vnd.suderra.device-lifecycle.v1+json"}';
const DIGEST = 'ab'.repeat(32);

type Holder = Parameters<EdgeRootHandoffService['onHeartbeat']>[0];

const owed: Holder = {
  id: DEVICE,
  tenantId: TENANT,
  agentChannel: EdgeAgentChannel.SUDERRA_OS,
  lifecycleState: DeviceLifecycleState.ACTIVE,
  activationReceipt: RECEIPT,
  activationReceiptSentAt: null,
  activationReceiptHandedAt: null,
  lifecycleRequest: null,
  lifecycleRequestSentAt: null,
  lifecycleRequestHandedAt: null,
  maintenanceExpiresAt: null,
};

const inWindow: Holder = {
  ...owed,
  lifecycleState: DeviceLifecycleState.MAINTENANCE,
  activationReceipt: null,
  lifecycleRequest: LIFECYCLE,
  maintenanceExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
};

function harness(
  options: {
    publish?: () => Promise<void>;
    receipt?: string | null;
    lifecycle?: string | null;
    settled?: 'activation_receipt' | 'lifecycle_request' | null;
    lapsed?: boolean;
  } = {},
): {
  service: EdgeRootHandoffService;
  publish: jest.Mock;
  claimReceiptDelivery: jest.Mock;
  claimLifecycleDelivery: jest.Mock;
  settleHandoff: jest.Mock;
  settleLapsedMaintenance: jest.Mock;
  findDevice: jest.Mock;
} {
  const publish = jest.fn(options.publish ?? (async (): Promise<void> => undefined));
  const claimReceiptDelivery = jest.fn(async () => options.receipt ?? RECEIPT);
  const claimLifecycleDelivery = jest.fn(async () => options.lifecycle ?? LIFECYCLE);
  const settleHandoff = jest.fn(async () => options.settled ?? 'activation_receipt');
  const settleLapsedMaintenance = jest.fn(async () => options.lapsed ?? true);
  const findDevice = jest.fn(async (column: string, value: string) =>
    (column === 'id' && value === DEVICE) || (column === 'device_code' && value === DEVICE_CODE)
      ? Object.assign(new EdgeDevice(), { id: DEVICE, tenantId: TENANT })
      : null,
  );
  const service = new EdgeRootHandoffService(
    collaborator<EdgeCommandPublisher>({ publish }, 'EdgeCommandPublisher'),
    collaborator<ProvisioningReservationService>(
      { claimReceiptDelivery, claimLifecycleDelivery, settleHandoff, settleLapsedMaintenance },
      'ProvisioningReservationService',
    ),
    collaborator<DeviceDirectoryService>({ findDevice }, 'DeviceDirectoryService'),
  );
  return {
    service,
    publish,
    claimReceiptDelivery,
    claimLifecycleDelivery,
    settleHandoff,
    settleLapsedMaintenance,
    findDevice,
  };
}

const handed = {
  commandId: 'c1',
  success: true,
  result: { handed_to_root: true, statement_digest: { sha256: DIGEST } },
};

describe('EdgeRootHandoffService (ADR-048 DEC-5.8, DEC-5.14)', () => {
  it('delivers the claimed receipt as the statement parameter of activation_receipt', async () => {
    const { service, publish, claimReceiptDelivery } = harness({ receipt: '{"resigned":true}' });
    await service.deliverPending(owed, NOW);
    expect(claimReceiptDelivery).toHaveBeenCalledWith(owed, NOW);
    expect(publish).toHaveBeenCalledWith(
      { tenantId: TENANT, deviceId: DEVICE },
      {
        commandId: expect.any(String),
        command: 'activation_receipt',
        params: { statement: '{"resigned":true}' },
      },
    );
  });

  it('claims nothing for a generic device, a handed receipt, or one sent within the pace', async () => {
    const { service, claimReceiptDelivery, claimLifecycleDelivery, publish } = harness();
    for (const device of [
      { ...owed, agentChannel: EdgeAgentChannel.GENERIC_LINUX },
      { ...owed, activationReceipt: null },
      { ...owed, activationReceiptHandedAt: NOW },
      {
        ...owed,
        activationReceiptSentAt: new Date(NOW.getTime() - HANDOFF_REDELIVERY_INTERVAL_MS + 1),
      },
    ]) {
      await service.deliverPending(device, NOW);
    }
    expect(claimReceiptDelivery).not.toHaveBeenCalled();
    expect(claimLifecycleDelivery).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('redelivers once the pace has passed, and publishes nothing when the claim is taken elsewhere', async () => {
    const lost = {
      ...owed,
      activationReceiptSentAt: new Date(NOW.getTime() - HANDOFF_REDELIVERY_INTERVAL_MS),
    };
    const first = harness();
    await first.service.deliverPending(lost, NOW);
    expect(first.publish).toHaveBeenCalledTimes(1);

    const raced = harness({ receipt: null });
    raced.claimReceiptDelivery.mockResolvedValue(null);
    await raced.service.deliverPending(lost, NOW);
    expect(raced.claimReceiptDelivery).toHaveBeenCalledTimes(1);
    expect(raced.publish).not.toHaveBeenCalled();
  });

  it('delivers the lifecycle statement only while its window is open', async () => {
    const { service, publish, claimLifecycleDelivery } = harness();
    await service.deliverPending(inWindow, NOW);
    expect(publish).toHaveBeenCalledWith(
      { tenantId: TENANT, deviceId: DEVICE },
      {
        commandId: expect.any(String),
        command: 'lifecycle_request',
        params: { statement: LIFECYCLE },
      },
    );
    await service.deliverPending({ ...inWindow, maintenanceExpiresAt: NOW }, NOW);
    await service.deliverPending({ ...inWindow, lifecycleRequestHandedAt: NOW }, NOW);
    expect(claimLifecycleDelivery).toHaveBeenCalledTimes(1);
  });

  it('a refused publish never fails the trigger: it is logged and the next paced heartbeat retries', async () => {
    const { service, publish } = harness({
      publish: async () => {
        throw new Error('broker down');
      },
    });
    await expect(service.deliverPending(owed, NOW)).resolves.toBeUndefined();
    await expect(service.deliverLifecycleRequest(owed, NOW)).resolves.toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('a lapsed re-provisioning window is closed instead of delivering into it', async () => {
    const lapsed = { ...inWindow, maintenanceExpiresAt: new Date(NOW.getTime() - 1000) };
    const closed = harness({ lapsed: true });
    await closed.service.onHeartbeat(lapsed, NOW);
    expect(closed.settleLapsedMaintenance).toHaveBeenCalledWith(lapsed, NOW);
    expect(closed.publish).not.toHaveBeenCalled();

    // An activation was issued under the window's token: nothing to close,
    // and the commit at the device's CONNECT finishes it.
    const pending = harness({ lapsed: false });
    await pending.service.onHeartbeat({ ...lapsed, activationReceipt: RECEIPT }, NOW);
    expect(pending.publish).toHaveBeenCalledTimes(1);

    const open = harness();
    await open.service.onHeartbeat(inWindow, NOW);
    expect(open.settleLapsedMaintenance).not.toHaveBeenCalled();
    expect(open.publish).toHaveBeenCalledTimes(1);
  });

  it('settles the statement the agent names by digest, on the responding device', async () => {
    const { service, settleHandoff, findDevice } = harness();
    await expect(
      service.handleResponse({ deviceCode: DEVICE, tenantId: TENANT }, handed),
    ).resolves.toBe(true);
    expect(findDevice).toHaveBeenCalledWith('id', DEVICE);
    expect(settleHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ id: DEVICE, tenantId: TENANT }),
      { sha256: DIGEST },
      expect.any(Date),
    );
    // A legacy tenant-less topic names the device by its code.
    await service.handleResponse({ deviceCode: DEVICE_CODE }, handed);
    expect(findDevice).toHaveBeenLastCalledWith('device_code', DEVICE_CODE);
    expect(settleHandoff).toHaveBeenCalledTimes(2);
  });

  it("settles nothing from another tenant's topic or for an unknown device", async () => {
    const { service, settleHandoff } = harness();
    await expect(
      service.handleResponse(
        { deviceCode: DEVICE, tenantId: '7e570000-0000-4000-8000-000000000002' },
        handed,
      ),
    ).resolves.toBe(true);
    await service.handleResponse({ deviceCode: '7e570000-0000-4000-8000-0000000000d9' }, handed);
    expect(settleHandoff).not.toHaveBeenCalled();
  });

  it('a refusal, a failed command or a missing digest settles nothing', async () => {
    const { service, settleHandoff, findDevice } = harness();
    for (const payload of [
      { commandId: 'c2', success: false, result: { handed_to_root: false, reasons: ['expired'] } },
      // success=false is a failure whatever the result claims.
      {
        commandId: 'c3',
        success: false,
        result: { handed_to_root: true, statement_digest: { sha256: DIGEST } },
      },
      { commandId: 'c4', success: true, result: { handed_to_root: true } },
      {
        commandId: 'c5',
        success: true,
        result: { handed_to_root: true, statement_digest: { sha256: 'xyz' } },
      },
    ]) {
      await expect(
        service.handleResponse({ deviceCode: DEVICE, tenantId: TENANT }, payload),
      ).resolves.toBe(true);
    }
    expect(findDevice).not.toHaveBeenCalled();
    expect(settleHandoff).not.toHaveBeenCalled();
  });

  it('answers false for a response that is not a hand-over', async () => {
    const { service, findDevice } = harness();
    for (const payload of [
      { commandId: 'p', success: true, result: { pong: true } },
      { commandId: 'p', success: true },
      { success: true, result: [] },
    ]) {
      await expect(service.handleResponse({ deviceCode: DEVICE }, payload)).resolves.toBe(false);
    }
    expect(findDevice).not.toHaveBeenCalled();
  });
});
