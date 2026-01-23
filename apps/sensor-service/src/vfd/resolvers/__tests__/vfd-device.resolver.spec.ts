/**
 * VFD Device Resolver Unit Tests
 */

/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';

import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdReading } from '../../entities/vfd-reading.entity';
import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../../entities/vfd.enums';
import { VfdConnectionTesterService } from '../../services/vfd-connection-tester.service';
import { VfdDataReaderService } from '../../services/vfd-data-reader.service';
import { VfdDeviceService } from '../../services/vfd-device.service';
import { VfdDeviceResolver } from '../vfd-device.resolver';

describe('VfdDeviceResolver', () => {
  let resolver: VfdDeviceResolver;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let connectionTesterService: jest.Mocked<VfdConnectionTesterService>;
  let dataReaderService: jest.Mocked<VfdDataReaderService>;

  const tenantId = 'tenant-123';
  const mockContext = { tenantId };

  const mockDevice: Partial<VfdDevice> = {
    id: 'device-123',
    name: 'Test VFD',
    brand: VfdBrand.DANFOSS,
    model: 'FC302',
    protocol: VfdProtocol.MODBUS_TCP,
    protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
    status: VfdDeviceStatus.ACTIVE,
    tenantId,
    connectionStatus: { isConnected: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockReading: Partial<VfdReading> = {
    id: 'reading-123',
    vfdDeviceId: 'device-123',
    tenantId,
    parameters: { outputFrequency: 50, motorCurrent: 12.5 },
    statusBits: { running: true, fault: false },
    timestamp: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdDeviceResolver,
        {
          provide: VfdDeviceService,
          useValue: {
            findById: jest.fn().mockResolvedValue(mockDevice),
            findAll: jest.fn().mockResolvedValue({
              items: [mockDevice],
              total: 1,
              page: 1,
              limit: 20,
              totalPages: 1,
            }),
            findByFarm: jest.fn().mockResolvedValue([mockDevice]),
            findByTank: jest.fn().mockResolvedValue([mockDevice]),
            getCountByStatus: jest.fn().mockResolvedValue({
              [VfdDeviceStatus.ACTIVE]: 5,
              [VfdDeviceStatus.DRAFT]: 2,
            }),
            create: jest.fn().mockResolvedValue(mockDevice),
            update: jest.fn().mockResolvedValue(mockDevice),
            delete: jest.fn().mockResolvedValue(true),
            activate: jest.fn().mockResolvedValue(mockDevice),
            deactivate: jest.fn().mockResolvedValue(mockDevice),
          },
        },
        {
          provide: VfdConnectionTesterService,
          useValue: {
            testDeviceConnection: jest.fn().mockResolvedValue({
              success: true,
              latencyMs: 25,
              testedAt: new Date(),
            }),
            testConnection: jest.fn().mockResolvedValue({
              success: true,
              latencyMs: 25,
            }),
          },
        },
        {
          provide: VfdDataReaderService,
          useValue: {
            getLatestReading: jest.fn().mockResolvedValue(mockReading),
          },
        },
      ],
    }).compile();

    resolver = module.get<VfdDeviceResolver>(VfdDeviceResolver);
    deviceService = module.get(VfdDeviceService);
    connectionTesterService = module.get(VfdConnectionTesterService);
    dataReaderService = module.get(VfdDataReaderService);
  });

  describe('Queries', () => {
    describe('getVfdDevice', () => {
      it('should return a single device by ID', async () => {
        const result = await resolver.getVfdDevice('device-123', mockContext);

        expect(result).toEqual(mockDevice);
        expect(deviceService.findById).toHaveBeenCalledWith('device-123', tenantId);
      });
    });

    describe('getVfdDevices', () => {
      it('should return paginated devices', async () => {
        const result = await resolver.getVfdDevices({}, { page: 1, limit: 20 }, mockContext);

        expect(result.items).toHaveLength(1);
        expect(result.total).toBe(1);
        expect(deviceService.findAll).toHaveBeenCalledWith(tenantId, {}, { page: 1, limit: 20 });
      });

      it('should apply filters', async () => {
        const filter = { status: VfdDeviceStatus.ACTIVE, brand: VfdBrand.DANFOSS };
        await resolver.getVfdDevices(filter, {}, mockContext);

        expect(deviceService.findAll).toHaveBeenCalledWith(tenantId, filter, {});
      });
    });

    describe('getVfdDevicesByFarm', () => {
      it('should return devices for a farm', async () => {
        const result = await resolver.getVfdDevicesByFarm('farm-123', mockContext);

        expect(result).toHaveLength(1);
        expect(deviceService.findByFarm).toHaveBeenCalledWith('farm-123', tenantId);
      });
    });

    describe('getVfdDevicesByTank', () => {
      it('should return devices for a tank', async () => {
        const result = await resolver.getVfdDevicesByTank('tank-456', mockContext);

        expect(result).toHaveLength(1);
        expect(deviceService.findByTank).toHaveBeenCalledWith('tank-456', tenantId);
      });
    });

    describe('getVfdDeviceCountByStatus', () => {
      it('should return device counts by status', async () => {
        const result = await resolver.getVfdDeviceCountByStatus(mockContext);

        expect(result[VfdDeviceStatus.ACTIVE]).toBe(5);
        expect(result[VfdDeviceStatus.DRAFT]).toBe(2);
      });
    });
  });

  describe('Mutations', () => {
    describe('registerVfdDevice', () => {
      const createInput = {
        name: 'New VFD',
        brand: VfdBrand.ABB,
        protocol: VfdProtocol.MODBUS_TCP,
        protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
      };

      it('should register a new VFD device', async () => {
        const result = await resolver.registerVfdDevice(createInput, mockContext);

        expect(result.device).toBeDefined();
        expect(deviceService.create).toHaveBeenCalledWith(createInput, tenantId);
      });

      it('should test connection after registration', async () => {
        const result = await resolver.registerVfdDevice(createInput, mockContext);

        expect(result.connectionTest).toBeDefined();
        expect(connectionTesterService.testDeviceConnection).toHaveBeenCalled();
      });

      it('should handle connection test failure gracefully', async () => {
        connectionTesterService.testDeviceConnection.mockRejectedValueOnce(
          new Error('Connection failed')
        );

        const result = await resolver.registerVfdDevice(createInput, mockContext);

        expect(result.device).toBeDefined();
        expect(result.connectionTest.success).toBe(false);
        expect(result.connectionTest.error).toBe('Connection failed');
      });
    });

    describe('updateVfdDevice', () => {
      it('should update a device', async () => {
        const updateInput = { name: 'Updated VFD' };
        const result = await resolver.updateVfdDevice('device-123', updateInput, mockContext);

        expect(result).toEqual(mockDevice);
        expect(deviceService.update).toHaveBeenCalledWith('device-123', tenantId, updateInput);
      });
    });

    describe('deleteVfdDevice', () => {
      it('should delete a device', async () => {
        const result = await resolver.deleteVfdDevice('device-123', mockContext);

        expect(result).toBe(true);
        expect(deviceService.delete).toHaveBeenCalledWith('device-123', tenantId);
      });
    });

    describe('testVfdConnection', () => {
      it('should test connection for a device', async () => {
        const result = await resolver.testVfdConnection('device-123', mockContext);

        expect(result.success).toBe(true);
        expect(connectionTesterService.testDeviceConnection).toHaveBeenCalledWith(
          'device-123',
          tenantId
        );
      });
    });

    describe('testVfdConnectionConfig', () => {
      it('should test connection configuration', async () => {
        const result = await resolver.testVfdConnectionConfig(
          VfdProtocol.MODBUS_TCP,
          { host: '192.168.1.100', port: 502 },
          VfdBrand.DANFOSS
        );

        expect(result.success).toBe(true);
        expect(connectionTesterService.testConnection).toHaveBeenCalledWith({
          protocol: VfdProtocol.MODBUS_TCP,
          configuration: { host: '192.168.1.100', port: 502 },
          brand: VfdBrand.DANFOSS,
        });
      });
    });

    describe('activateVfdDevice', () => {
      it('should activate a device', async () => {
        const result = await resolver.activateVfdDevice('device-123', mockContext);

        expect(result).toEqual(mockDevice);
        expect(deviceService.activate).toHaveBeenCalledWith('device-123', tenantId);
      });
    });

    describe('deactivateVfdDevice', () => {
      it('should deactivate a device', async () => {
        const result = await resolver.deactivateVfdDevice('device-123', mockContext);

        expect(result).toEqual(mockDevice);
        expect(deviceService.deactivate).toHaveBeenCalledWith('device-123', tenantId);
      });
    });
  });

  describe('Field Resolvers', () => {
    describe('getLatestReading', () => {
      it('should resolve latest reading for a device', async () => {
        const result = await resolver.getLatestReading(mockDevice as VfdDevice, mockContext);

        expect(result).toEqual(mockReading);
        expect(dataReaderService.getLatestReading).toHaveBeenCalledWith('device-123', tenantId);
      });

      it('should return null if no reading found', async () => {
        dataReaderService.getLatestReading.mockResolvedValueOnce(null);

        const result = await resolver.getLatestReading(mockDevice as VfdDevice, mockContext);

        expect(result).toBeNull();
      });
    });
  });
});
