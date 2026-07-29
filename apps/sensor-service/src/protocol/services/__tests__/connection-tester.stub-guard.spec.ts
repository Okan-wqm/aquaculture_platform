import { Test, TestingModule } from '@nestjs/testing';

import { ConnectionTesterService } from '../connection-tester.service';
import { ProtocolRegistryService } from '../protocol-registry.service';
import { ProtocolValidatorService } from '../protocol-validator.service';

/**
 * SENSOR-CRITICAL-008 guard: a sensor may only reach ACTIVE through a real
 * connection attempt. The registration flow flips ACTIVE on a successful
 * connection test, so the tester must never return success for a stub
 * (UNSUPPORTED) or edge-delegated protocol whose cloud adapter cannot actually
 * reach the device.
 */
describe('ConnectionTesterService — implementation-status guard', () => {
  let service: ConnectionTesterService;
  let registry: { getAdapter: jest.Mock };
  let validator: { validate: jest.Mock };

  const makeAdapter = () => ({
    testConnection: jest.fn().mockResolvedValue({ success: true, latencyMs: 5 }),
    connect: jest.fn().mockResolvedValue({ id: 'h1' }),
    readData: jest
      .fn()
      .mockResolvedValue({ timestamp: new Date(), values: { v: 1 }, quality: 100 }),
    disconnect: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectionTesterService,
        { provide: ProtocolRegistryService, useValue: { getAdapter: jest.fn() } },
        {
          provide: ProtocolValidatorService,
          useValue: { validate: jest.fn().mockReturnValue({ isValid: true, errors: [] }) },
        },
      ],
    }).compile();

    service = module.get(ConnectionTesterService);
    registry = module.get(ProtocolRegistryService);
    validator = module.get(ProtocolValidatorService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns an honest failure for an UNSUPPORTED (stub) protocol without calling the adapter', async () => {
    const adapter = makeAdapter();
    registry.getAdapter.mockReturnValue(adapter);

    const result = await service.testConnection(
      'PROFIBUS_DP',
      { host: '10.0.0.5' },
      { fetchSampleData: false },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no supported connection/i);
    expect(adapter.testConnection).not.toHaveBeenCalled();
  });

  it('returns an honest failure for an EDGE_DELEGATED protocol without calling the adapter', async () => {
    const adapter = makeAdapter();
    registry.getAdapter.mockReturnValue(adapter);

    const result = await service.testConnection(
      'I2C',
      { bus: 1, address: 72 },
      { fetchSampleData: false },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/edge gateway/i);
    expect(adapter.testConnection).not.toHaveBeenCalled();
  });

  it('runs the real adapter test for a CLOUD_REAL protocol', async () => {
    const adapter = makeAdapter();
    registry.getAdapter.mockReturnValue(adapter);

    const result = await service.testConnection(
      'MODBUS_TCP',
      { host: '10.0.0.5', port: 502 },
      { fetchSampleData: false },
    );

    expect(adapter.testConnection).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('does not reach the status guard when config validation fails', async () => {
    validator.validate.mockReturnValue({ isValid: false, errors: [{ message: 'bad host' }] });

    const result = await service.testConnection('MODBUS_TCP', {}, { fetchSampleData: false });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/validation failed/i);
    expect(registry.getAdapter).not.toHaveBeenCalled();
  });
});
