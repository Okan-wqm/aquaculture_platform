/**
 * VfdCommandService — command audit trail (DB-SENSOR-HIGH-003).
 *
 * Every dispatched runtime control command must leave a durable, immutable
 * audit row (who/when/what/result), and audit durability must NEVER block the
 * actuator command — an EMERGENCY_STOP cannot be gated by an audit-store
 * outage. These tests pin both guarantees.
 */
import { VfdCommandService, VfdCommandActor } from '../vfd-command.service';
import { VfdBrand, VfdCommandType, VfdDeviceStatus } from '../../entities/vfd.enums';

type Repo = { create: jest.Mock; save: jest.Mock; find: jest.Mock };

const ACTOR: VfdCommandActor = { userId: 'user-42', email: 'op@farm.test' };
const TENANT = 'tenant-1';
const DEVICE = 'device-1';

type WriteResult = { success: boolean; commandId: string; error?: string; latencyMs?: number };

/**
 * Build the service with a controllable edge-write mock. `writeRegister` drives
 * command success/failure — the write path is edge-delegated (SENSOR-CRITICAL-007).
 */
function makeService(repo: Repo, writeRegister?: jest.Mock<Promise<WriteResult>>) {
  const deviceService = {
    findById: jest.fn().mockResolvedValue({
      id: DEVICE,
      brand: VfdBrand.DANFOSS,
      status: VfdDeviceStatus.ACTIVE,
      edgeDeviceId: 'edge-1',
      edgeModbusDeviceName: 'vfd-pump-1',
    }),
  };
  const registerMapping = {
    getControlWordMapping: jest.fn().mockResolvedValue({ registerAddress: 49999, scalingFactor: 1 }),
    getSpeedReferenceMapping: jest.fn().mockResolvedValue({ registerAddress: 50000, scalingFactor: 1 }),
  };
  const edgeWriteService = {
    writeRegister:
      writeRegister ??
      jest.fn().mockResolvedValue({ success: true, commandId: 'cmd-1', latencyMs: 5 }),
  };
  // The drive is attested, so the actuation gate passes and these tests can go
  // on being about audit records. The gate itself is proven in
  // vfd-command.service.spec.ts and vfd-drive-binding.service.spec.ts.
  const driveBinding = { assertActuable: jest.fn().mockResolvedValue(undefined) };
  const service = new VfdCommandService(
    deviceService as never,
    driveBinding as never,
    registerMapping as never,
    edgeWriteService as never,
    repo as never,
  );
  return { service, edgeWriteService };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    create: jest.fn((x: unknown) => x),
    save: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('VfdCommandService — command audit', () => {
  it('writes an audit row on a successful command with the actor and result', async () => {
    const repo = makeRepo();
    // Default edge-write mock resolves a real success ack.
    const { service } = makeService(repo);

    const result = await service.executeCommand(
      DEVICE,
      TENANT,
      { command: VfdCommandType.START },
      ACTOR,
    );

    expect(result.success).toBe(true);
    expect(repo.save).toHaveBeenCalledTimes(1);
    const audited = repo.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(audited).toMatchObject({
      tenantId: TENANT,
      vfdDeviceId: DEVICE,
      command: VfdCommandType.START,
      success: true,
      performedBy: 'user-42',
      performedByEmail: 'op@farm.test',
      source: 'operator',
    });
  });

  it('writes an audit row on a failed command (success=false)', async () => {
    const repo = makeRepo();
    // Edge write rejects (e.g. drive unreachable) → command fails closed.
    const { service } = makeService(
      repo,
      jest.fn().mockRejectedValue(new Error('device unreachable')),
    );

    const result = await service.executeCommand(
      DEVICE,
      TENANT,
      { command: VfdCommandType.STOP },
      ACTOR,
    );

    expect(result.success).toBe(false);
    expect(repo.save).toHaveBeenCalledTimes(1);
    const audited = repo.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(audited).toMatchObject({ command: VfdCommandType.STOP, success: false, performedBy: 'user-42' });
  });

  it('does NOT block the command when the audit write fails (best-effort)', async () => {
    const repo = makeRepo({ save: jest.fn().mockRejectedValue(new Error('audit db down')) });
    const { service } = makeService(
      repo,
      jest.fn().mockRejectedValue(new Error('device unreachable')),
    );

    // Must resolve (not throw) even though the audit write rejected.
    const result = await service.executeCommand(
      DEVICE,
      TENANT,
      { command: VfdCommandType.EMERGENCY_STOP },
      ACTOR,
    );

    expect(result.command).toBe(VfdCommandType.EMERGENCY_STOP);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('falls back to a system identity when no actor is supplied', async () => {
    const repo = makeRepo();
    const { service } = makeService(
      repo,
      jest.fn().mockRejectedValue(new Error('device unreachable')),
    );

    await service.executeCommand(DEVICE, TENANT, { command: VfdCommandType.STOP });

    const audited = repo.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(audited.performedBy).toBe('system');
  });

  it('getCommandAuditLog reads tenant + device scoped, newest first', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    await service.getCommandAuditLog(DEVICE, TENANT, 25);

    expect(repo.find).toHaveBeenCalledWith({
      where: { vfdDeviceId: DEVICE, tenantId: TENANT },
      order: { timestamp: 'DESC' },
      take: 25,
    });
  });
});
