/**
 * VFD Connection Tester Service Unit Tests
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';

import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdProtocol, VfdBrand, VfdDeviceStatus } from '../../entities/vfd.enums';
import { VfdConnectionTesterService, TestConnectionInput } from '../vfd-connection-tester.service';
import { VfdDeviceService } from '../vfd-device.service';
import { VfdRegisterMappingService } from '../vfd-register-mapping.service';

// Mock the adapters module
jest.mock('../../adapters', () => ({
  createVfdAdapter: jest.fn().mockImplementation(() => ({
    validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
    testConnection: jest.fn().mockResolvedValue({ success: true, latencyMs: 25 }),
    connect: jest.fn().mockResolvedValue({ id: 'connection-123' }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    readParameters: jest.fn().mockResolvedValue({ parameters: { outputFrequency: 50 } }),
    getConfigurationSchema: jest.fn().mockReturnValue({ type: 'object' }),
    getDefaultConfiguration: jest.fn().mockReturnValue({ port: 502 }),
  })),
  getProtocolInfoList: jest.fn().mockReturnValue([
    { protocol: 'modbus_tcp', name: 'Modbus TCP', connectionType: 'ethernet' },
  ]),
}));

describe('VfdConnectionTesterService', () => {
  let service: VfdConnectionTesterService;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;

  const tenantId = 'tenant-123';

  const mockDevice: Partial<VfdDevice> = {
    id: 'device-123',
    name: 'Test VFD',
    brand: VfdBrand.DANFOSS,
    protocol: VfdProtocol.MODBUS_TCP,
    protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
    status: VfdDeviceStatus.DRAFT,
    tenantId,
    connectionStatus: { isConnected: false },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdConnectionTesterService,
        {
          provide: VfdDeviceService,
          useValue: {
            findById: jest.fn().mockResolvedValue(mockDevice),
            updateConnectionStatus: jest.fn().mockResolvedValue(mockDevice),
            updateStatus: jest.fn().mockResolvedValue(mockDevice),
          },
        },
        {
          provide: VfdRegisterMappingService,
          useValue: {
            getCriticalMappings: jest.fn().mockResolvedValue([
              { parameterName: 'output_frequency', registerAddress: 16129 },
            ]),
          },
        },
      ],
    }).compile();

    service = module.get<VfdConnectionTesterService>(VfdConnectionTesterService);
    deviceService = module.get(VfdDeviceService);
    registerMappingService = module.get(VfdRegisterMappingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('testConnection', () => {
    const validInput: TestConnectionInput = {
      protocol: VfdProtocol.MODBUS_TCP,
      configuration: { host: '192.168.1.100', port: 502, unitId: 1 },
      brand: VfdBrand.DANFOSS,
    };

    it('should test a valid connection successfully', async () => {
      const result = await service.testConnection(validInput);

      expect(result.success).toBe(true);
      expect(result.protocol).toBe(VfdProtocol.MODBUS_TCP);
      expect(result.testedAt).toBeInstanceOf(Date);
    });

    it('should return latency for successful connection', async () => {
      const result = await service.testConnection(validInput);

      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe('number');
    });

    it('should include configuration in result', async () => {
      const result = await service.testConnection(validInput);

      expect(result.configuration).toEqual(validInput.configuration);
    });

    it('should handle validation failure', async () => {
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        validateConfiguration: jest.fn().mockReturnValue({
          valid: false,
          errors: ['Invalid host address'],
        }),
      }));

      const result = await service.testConnection(validInput);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Configuration validation failed');
    });

    it('should handle connection failure', async () => {
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
        testConnection: jest.fn().mockResolvedValue({
          success: false,
          error: 'Connection timeout',
        }),
      }));

      const result = await service.testConnection(validInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
    });

    it('should handle connection exception', async () => {
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
        testConnection: jest.fn().mockRejectedValue(new Error('Network error')),
      }));

      const result = await service.testConnection(validInput);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should read sample parameters when brand is specified', async () => {
      const result = await service.testConnection(validInput);

      expect(result.parameters).toBeDefined();
      expect(registerMappingService.getCriticalMappings).toHaveBeenCalledWith(VfdBrand.DANFOSS);
    });

    it('should not read parameters when brand is not specified', async () => {
      const inputWithoutBrand: TestConnectionInput = {
        protocol: VfdProtocol.MODBUS_TCP,
        configuration: { host: '192.168.1.100', port: 502, unitId: 1 },
      };

      await service.testConnection(inputWithoutBrand);

      expect(registerMappingService.getCriticalMappings).not.toHaveBeenCalled();
    });
  });

  describe('testDeviceConnection', () => {
    it('should test connection for an existing device', async () => {
      const result = await service.testDeviceConnection('device-123', tenantId);

      expect(deviceService.findById).toHaveBeenCalledWith('device-123', tenantId);
      expect(result.success).toBe(true);
    });

    it('should update device connection status', async () => {
      await service.testDeviceConnection('device-123', tenantId);

      expect(deviceService.updateConnectionStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        expect.objectContaining({
          isConnected: true,
          lastTestedAt: expect.any(Date),
        })
      );
    });

    it('should update device status to TESTING on first success', async () => {
      await service.testDeviceConnection('device-123', tenantId);

      expect(deviceService.updateStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        VfdDeviceStatus.TESTING
      );
    });

    it('should update device status to TEST_FAILED on failure during testing', async () => {
      const testingDevice = { ...mockDevice, status: VfdDeviceStatus.TESTING };
      deviceService.findById.mockResolvedValueOnce(testingDevice as VfdDevice);

      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        validateConfiguration: jest.fn().mockReturnValue({ valid: true, errors: [] }),
        testConnection: jest.fn().mockResolvedValue({ success: false, error: 'Failed' }),
      }));

      await service.testDeviceConnection('device-123', tenantId);

      expect(deviceService.updateStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        VfdDeviceStatus.TEST_FAILED
      );
    });
  });

  describe('validateConfiguration', () => {
    it('should validate protocol configuration', () => {
      const result = service.validateConfiguration(VfdProtocol.MODBUS_TCP, {
        host: '192.168.1.100',
        port: 502,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('getProtocolSchema', () => {
    it('should return protocol schema', () => {
      const result = service.getProtocolSchema(VfdProtocol.MODBUS_TCP);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });
  });

  describe('getDefaultConfiguration', () => {
    it('should return default configuration', () => {
      const result = service.getDefaultConfiguration(VfdProtocol.MODBUS_TCP);

      expect(result).toBeDefined();
    });
  });

  describe('getSupportedProtocols', () => {
    it('should return list of supported protocols', () => {
      const result = service.getSupportedProtocols();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('discoverDevices', () => {
    it('should return empty array for Modbus TCP discovery', async () => {
      const result = await service.discoverDevices(VfdProtocol.MODBUS_TCP, {
        startIp: '192.168.1.1',
        endIp: '192.168.1.254',
      });

      expect(Array.isArray(result)).toBe(true);
    });

    it('should return empty array for unsupported protocols', async () => {
      const result = await service.discoverDevices(VfdProtocol.MODBUS_RTU, {});

      expect(result).toEqual([]);
    });
  });
});
