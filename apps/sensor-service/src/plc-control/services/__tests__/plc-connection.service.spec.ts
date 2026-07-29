import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { AuditLog } from '../../../infrastructure/audit';
import { OpcUaAdapter } from '../../../protocol/adapters/industrial/opcua.adapter';
import {
  PlcAuthMode,
  PlcConnection,
  PlcConnectionStatus,
  PlcSecurityMode,
} from '../../entities/plc-connection.entity';
import { PlcConnectionService } from '../plc-connection.service';

type OpcUaHandle = { id: string };

describe('PlcConnectionService OPC UA writes', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const connectionId = '22222222-2222-2222-2222-222222222222';
  const actorUserId = '33333333-3333-3333-3333-333333333333';
  const correlationId = 'corr-opcua-write-1';
  const allowedNodeId = 'ns=2;s=Feeding.Setpoint';

  let service: PlcConnectionService;
  let findOne: jest.MockedFunction<(options: unknown) => Promise<PlcConnection | null>>;
  let auditCreate: jest.MockedFunction<(entry: Partial<AuditLog>) => AuditLog>;
  let auditSave: jest.MockedFunction<(entry: AuditLog) => Promise<AuditLog>>;
  let connect: jest.MockedFunction<(config: unknown) => Promise<OpcUaHandle>>;
  let writeData: jest.MockedFunction<
    (handle: OpcUaHandle, nodeId: string, value: unknown, dataType: string) => Promise<void>
  >;
  let disconnect: jest.MockedFunction<(handle: OpcUaHandle) => Promise<void>>;

  const makeConnection = (overrides: Partial<PlcConnection> = {}): PlcConnection => ({
    id: connectionId,
    tenantId,
    siteId: 'site-1',
    name: 'Feed PLC',
    endpointUrl: 'opc.tcp://plc.local:4840',
    securityMode: PlcSecurityMode.NONE,
    authMode: PlcAuthMode.ANONYMOUS,
    status: PlcConnectionStatus.ONLINE,
    publishingIntervalMs: 1000,
    samplingIntervalMs: 500,
    sessionTimeoutMs: 60000,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 60000,
    autoReconnect: true,
    maxReconnectAttempts: -1,
    reconnectDelayMs: 1000,
    maxReconnectDelayMs: 30000,
    keepAliveIntervalMs: 5000,
    parametersNodeId: allowedNodeId,
    isActive: true,
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    updatedAt: new Date('2026-05-12T00:00:00.000Z'),
    ...overrides,
  });

  const auditPayloads = (): Array<Record<string, unknown> | undefined> =>
    auditSave.mock.calls.map(([entry]) => entry.newValue);

  beforeEach(() => {
    findOne = jest.fn();
    auditCreate = jest.fn((entry: Partial<AuditLog>) => entry as AuditLog);
    auditSave = jest.fn((entry: AuditLog) => Promise.resolve(entry));
    connect = jest.fn();
    writeData = jest.fn();
    disconnect = jest.fn();

    service = new PlcConnectionService(
      { findOne } as unknown as Repository<PlcConnection>,
      { create: auditCreate, save: auditSave } as unknown as Repository<AuditLog>,
      { connect, writeData, disconnect } as unknown as OpcUaAdapter,
    );
  });

  it('writes an allowlisted node only after attempt audit succeeds', async () => {
    const handle = { id: 'handle-1' };
    findOne.mockResolvedValue(makeConnection());
    connect.mockResolvedValue(handle);
    writeData.mockResolvedValue(undefined);
    disconnect.mockResolvedValue(undefined);

    await service.writeNodeValue(
      connectionId,
      tenantId,
      allowedNodeId,
      42.5,
      'Double',
      actorUserId,
      correlationId,
    );

    expect(auditPayloads()).toEqual([
      expect.objectContaining({
        semanticAction: 'writeOpcUaNode',
        connectionId,
        nodeId: allowedNodeId,
        dataType: 'Double',
        result: 'attempt',
        correlationId,
      }),
      expect.objectContaining({
        semanticAction: 'writeOpcUaNode',
        connectionId,
        nodeId: allowedNodeId,
        dataType: 'Double',
        result: 'success',
        correlationId,
      }),
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(writeData).toHaveBeenCalledWith(handle, allowedNodeId, 42.5, 'Double');
    expect(disconnect).toHaveBeenCalledWith(handle);
  });

  it('denies inactive or offline connections before adapter access', async () => {
    findOne.mockResolvedValue(
      makeConnection({
        isActive: false,
        status: PlcConnectionStatus.OFFLINE,
      }),
    );

    await expect(
      service.writeNodeValue(
        connectionId,
        tenantId,
        allowedNodeId,
        42.5,
        'Double',
        actorUserId,
        correlationId,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(auditPayloads()).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'connection_not_active_or_online',
        correlationId,
      }),
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
  });

  it('denies nodes outside the exact write allowlist before adapter access', async () => {
    findOne.mockResolvedValue(makeConnection());

    await expect(
      service.writeNodeValue(
        connectionId,
        tenantId,
        'ns=2;s=Unapproved.Setpoint',
        42.5,
        'Double',
        actorUserId,
        correlationId,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(auditPayloads()).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'node_not_allowlisted',
        nodeId: 'ns=2;s=Unapproved.Setpoint',
        correlationId,
      }),
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
  });

  it('audits unsupported data types as denied before adapter access', async () => {
    findOne.mockResolvedValue(makeConnection());

    await expect(
      service.writeNodeValue(
        connectionId,
        tenantId,
        allowedNodeId,
        42.5,
        'Variant',
        actorUserId,
        correlationId,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(auditPayloads()).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'unsupported_data_type',
        dataType: 'Variant',
        correlationId,
      }),
    ]);
    expect(connect).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
  });

  it('fails closed when the pre-write audit append fails', async () => {
    findOne.mockResolvedValue(makeConnection());
    auditSave.mockRejectedValueOnce(new Error('audit down'));

    await expect(
      service.writeNodeValue(
        connectionId,
        tenantId,
        allowedNodeId,
        42.5,
        'Double',
        actorUserId,
        correlationId,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(connect).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
  });

  it('requires an authenticated actor and correlation id', async () => {
    findOne.mockResolvedValue(makeConnection());

    await expect(
      service.writeNodeValue(
        connectionId,
        tenantId,
        allowedNodeId,
        42.5,
        'Double',
        undefined,
        correlationId,
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.writeNodeValue(
        connectionId,
        tenantId,
        allowedNodeId,
        42.5,
        'Double',
        actorUserId,
        undefined,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(auditSave).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
  });

  // SENSOR-HIGH-072: a PLC endpoint pointed at internal infrastructure must be
  // rejected on save, before any connection is opened, so it cannot become an
  // internal port-scan oracle. (The connect path is additionally guarded by
  // the OPC UA adapter's DNS-resolving SSRF check.)
  describe('endpoint SSRF validation', () => {
    it.each([
      'opc.tcp://127.0.0.1:4840',
      'opc.tcp://localhost:4840',
      'opc.tcp://10.0.0.5:4840',
      'opc.tcp://192.168.1.10:4840',
      'opc.tcp://172.16.0.9:4840',
      'opc.tcp://169.254.169.254:4840',
    ])(
      'rejects a private/loopback/metadata endpoint before touching the repository: %s',
      async (endpointUrl) => {
        await expect(
          service.create({ name: 'plc', endpointUrl, siteId: 'site-1' }, tenantId),
        ).rejects.toThrow(ForbiddenException);
      },
    );

    it('rejects a non-opc.tcp scheme', async () => {
      await expect(
        service.create(
          { name: 'plc', endpointUrl: 'http://10.0.0.1:80', siteId: 'site-1' },
          tenantId,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
