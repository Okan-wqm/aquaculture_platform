/**
 * VFD Device Service Unit Tests
 */

 
 

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../../entities/vfd.enums';
import { VfdDeviceService, CreateVfdDeviceInput, UpdateVfdDeviceInput } from '../vfd-device.service';
import { VfdDriveBindingService } from '../vfd-drive-binding.service';

describe('VfdDeviceService', () => {
  let service: VfdDeviceService;
  let repository: jest.Mocked<Repository<VfdDevice>>;
  let driveBindingService: jest.Mocked<VfdDriveBindingService>;

  const tenantId = 'tenant-123';

  const mockDevice: Partial<VfdDevice> = {
    id: 'device-123',
    name: 'Test VFD',
    brand: VfdBrand.DANFOSS,
    model: 'FC302',
    protocol: VfdProtocol.MODBUS_TCP,
    protocolConfiguration: {
      host: '192.168.1.100',
      port: 502,
      unitId: 1,
      connectionTimeout: 3000,
      responseTimeout: 1000,
    },
    status: VfdDeviceStatus.DRAFT,
    tenantId,
    connectionStatus: { isConnected: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createMockQueryBuilder = () => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[mockDevice], 1]),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([{ status: VfdDeviceStatus.ACTIVE, count: '5' }]),
    // findByTank resolves through the binding join, so it terminates in getMany.
    getMany: jest.fn().mockResolvedValue([mockDevice]),
  });

  let mockQueryBuilder: ReturnType<typeof createMockQueryBuilder>;

  beforeEach(async () => {
    mockQueryBuilder = createMockQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdDeviceService,
        {
          provide: VfdDriveBindingService,
          useValue: {
            bind: jest.fn().mockResolvedValue(undefined),
            unbind: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: getRepositoryToken(VfdDevice),
          useValue: {
            create: jest.fn().mockImplementation((dto) => ({ ...dto })),
            save: jest.fn().mockImplementation((device) => Promise.resolve({ id: 'device-123', ...device })),
            findOne: jest.fn(),
            find: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get<VfdDeviceService>(VfdDeviceService);
    repository = module.get(getRepositoryToken(VfdDevice));
    driveBindingService = module.get(VfdDriveBindingService);
  });

  describe('create', () => {
    const createInput: CreateVfdDeviceInput = {
      name: 'New VFD',
      brand: VfdBrand.ABB,
      model: 'ACS580',
      protocol: VfdProtocol.MODBUS_TCP,
      protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
    };

    it('should create a new VFD device', async () => {
      const result = await service.create(createInput, tenantId);

      expect(repository.create).toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalled();
      expect(result.id).toBeDefined();
      expect(result.name).toBe(createInput.name);
    });

    it('should set default status to DRAFT', async () => {
      const result = await service.create(createInput, tenantId);

      expect(result.status).toBe(VfdDeviceStatus.DRAFT);
    });

    it('should initialize connection status', async () => {
      const result = await service.create(createInput, tenantId);

      expect(result.connectionStatus).toBeDefined();
      // `connectionStatus` is the JSON column's optional shape;
      // `toBeDefined()` narrows logically not at the type level.
      // `!` is safe because the assertion above guarantees presence.
      expect(result.connectionStatus!.isConnected).toBe(false);
    });

    it('should validate Modbus RTU configuration', async () => {
      const rtuInput: CreateVfdDeviceInput = {
        ...createInput,
        protocol: VfdProtocol.MODBUS_RTU,
        protocolConfiguration: { invalidConfig: true },
      };

      await expect(service.create(rtuInput, tenantId)).rejects.toThrow(BadRequestException);
    });

    it('should validate Modbus TCP configuration', async () => {
      const tcpInput: CreateVfdDeviceInput = {
        ...createInput,
        protocol: VfdProtocol.MODBUS_TCP,
        protocolConfiguration: { noHost: true },
      };

      await expect(service.create(tcpInput, tenantId)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findById', () => {
    it('should return a device by ID', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);

      const result = await service.findById('device-123', tenantId);

      expect(result).toEqual(mockDevice);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'device-123', tenantId },
      });
    });

    it('should throw NotFoundException if device not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findById('non-existent', tenantId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return paginated devices', async () => {
      const result = await service.findAll(tenantId);

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });

    it('should apply filters', async () => {
      const mockQueryBuilder = createMockQueryBuilder();
      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.findAll(tenantId, {
        status: VfdDeviceStatus.ACTIVE,
        brand: VfdBrand.DANFOSS,
        protocol: VfdProtocol.MODBUS_TCP,
        search: 'test',
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalled();
    });

    it('should apply pagination', async () => {
      const mockQueryBuilder = createMockQueryBuilder();
      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.findAll(tenantId, undefined, { page: 2, limit: 10 });

      expect(mockQueryBuilder.skip).toHaveBeenCalledWith(10);
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(10);
    });

    it('should apply sorting', async () => {
      const mockQueryBuilder = createMockQueryBuilder();
      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      await service.findAll(tenantId, undefined, { sortBy: 'name', sortOrder: 'ASC' });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('vfd.name', 'ASC');
    });
  });

  describe('update', () => {
    it('should update a device', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);

      const updateInput: UpdateVfdDeviceInput = { name: 'Updated VFD' };
      const result = await service.update('device-123', tenantId, updateInput);

      expect(repository.save).toHaveBeenCalled();
      expect(result.name).toBe('Updated VFD');
    });

    it('should throw NotFoundException if device not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.update('non-existent', tenantId, {})).rejects.toThrow(NotFoundException);
    });

    it('should validate protocol configuration when updating', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);

      const updateInput: UpdateVfdDeviceInput = {
        protocol: VfdProtocol.MODBUS_RTU,
        protocolConfiguration: { invalidConfig: true },
      };

      await expect(service.update('device-123', tenantId, updateInput)).rejects.toThrow(BadRequestException);
    });
  });

  describe('edge binding (SENSOR-CRITICAL-007)', () => {
    const baseInput: CreateVfdDeviceInput = {
      name: 'Edge VFD',
      brand: VfdBrand.ABB,
      protocol: VfdProtocol.MODBUS_TCP,
      protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
    };

    it('persists both binding fields when provided together', async () => {
      const result = await service.create(
        { ...baseInput, edgeDeviceId: 'edge-1', edgeModbusDeviceName: 'vfd-pump-1' },
        tenantId,
      );

      expect(result.edgeDeviceId).toBe('edge-1');
      expect(result.edgeModbusDeviceName).toBe('vfd-pump-1');
    });

    it('creates an unbound drive when neither binding field is provided', async () => {
      const result = await service.create(baseInput, tenantId);

      expect(result.edgeDeviceId).toBeUndefined();
      expect(result.edgeModbusDeviceName).toBeUndefined();
    });

    it('rejects a create with only the gateway (no Modbus device name)', async () => {
      await expect(
        service.create({ ...baseInput, edgeDeviceId: 'edge-1' }, tenantId),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a create with only the Modbus device name (no gateway)', async () => {
      await expect(
        service.create({ ...baseInput, edgeModbusDeviceName: 'vfd-pump-1' }, tenantId),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects clearing only one half of an existing binding', async () => {
      repository.findOne.mockResolvedValue({
        ...mockDevice,
        edgeDeviceId: 'edge-1',
        edgeModbusDeviceName: 'vfd-pump-1',
      } as VfdDevice);

      // Clearing the device name alone leaves a gateway with no target — refused.
      await expect(
        service.update('device-123', tenantId, { edgeModbusDeviceName: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows clearing both halves of a binding together', async () => {
      repository.findOne.mockResolvedValue({
        ...mockDevice,
        edgeDeviceId: 'edge-1',
        edgeModbusDeviceName: 'vfd-pump-1',
      } as VfdDevice);

      const result = await service.update('device-123', tenantId, {
        edgeDeviceId: undefined,
        edgeModbusDeviceName: undefined,
      });

      expect(repository.save).toHaveBeenCalled();
      expect(result.edgeDeviceId).toBeUndefined();
      expect(result.edgeModbusDeviceName).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should delete a device', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);
      repository.remove.mockResolvedValue(mockDevice as VfdDevice);

      const result = await service.delete('device-123', tenantId);

      expect(result).toBe(true);
      expect(repository.remove).toHaveBeenCalled();
    });

    it('should throw NotFoundException if device not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.delete('non-existent', tenantId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('should update device status', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);

      const result = await service.updateStatus('device-123', tenantId, VfdDeviceStatus.ACTIVE);

      expect(repository.save).toHaveBeenCalled();
      expect(result.status).toBe(VfdDeviceStatus.ACTIVE);
    });
  });

  describe('updateConnectionStatus', () => {
    it('should update connection status', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);

      const result = await service.updateConnectionStatus('device-123', tenantId, {
        isConnected: true,
        lastTestedAt: new Date(),
        latencyMs: 25,
      });

      expect(repository.save).toHaveBeenCalled();
      expect(result.connectionStatus!.isConnected).toBe(true);
    });
  });

  describe('activate', () => {
    it('should activate a device with successful connection', async () => {
      const deviceWithConnection = {
        ...mockDevice,
        connectionStatus: { isConnected: true },
      };
      repository.findOne.mockResolvedValue(deviceWithConnection as VfdDevice);

      const result = await service.activate('device-123', tenantId);

      expect(result.status).toBe(VfdDeviceStatus.ACTIVE);
    });

    it('should return already active device unchanged', async () => {
      const activeDevice = {
        ...mockDevice,
        status: VfdDeviceStatus.ACTIVE,
        connectionStatus: { isConnected: true },
      };
      repository.findOne.mockResolvedValue(activeDevice as VfdDevice);

      const result = await service.activate('device-123', tenantId);

      expect(result.status).toBe(VfdDeviceStatus.ACTIVE);
    });

    it('should throw if device has no successful connection', async () => {
      const deviceWithoutConnection = {
        ...mockDevice,
        // Pin status explicitly: activate()/updateStatus() mutate the fetched
        // entity, and a sibling test can leave the shared mockDevice at ACTIVE
        // (which would early-return here). Being explicit keeps this test
        // order-independent.
        status: VfdDeviceStatus.DRAFT,
        connectionStatus: { isConnected: false },
      };
      repository.findOne.mockResolvedValue(deviceWithoutConnection as VfdDevice);

      await expect(service.activate('device-123', tenantId)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getCountByStatus', () => {
    it('should return device counts by status', async () => {
      const result = await service.getCountByStatus(tenantId);

      expect(result).toBeDefined();
      expect(typeof result[VfdDeviceStatus.ACTIVE]).toBe('number');
    });
  });

  describe('findByFarm', () => {
    it('should return devices for a farm', async () => {
      repository.find.mockResolvedValue([mockDevice as VfdDevice]);

      const result = await service.findByFarm('farm-123', tenantId);

      expect(repository.find).toHaveBeenCalledWith({
        where: { farmId: 'farm-123', tenantId },
        order: { name: 'ASC' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findByTank', () => {
    it('resolves through the attested binding, not through a column on the drive', async () => {
      // The old form read `vfd_devices.tank_id` — a uuid an operator typed. That
      // column is gone, so a drive can only be found by a unit its DRIVEN
      // EQUIPMENT is attested to serve.
      const result = await service.findByTank('tank-456', tenantId);

      expect(repository.find).not.toHaveBeenCalled();
      const predicate = mockQueryBuilder.andWhere.mock.calls[0]![0] as string;
      expect(predicate).toContain('vfd_drive_binding_units');
      expect(predicate).toContain('u.unit_id = :tankId');
      expect(result).toHaveLength(1);
    });
  });

  describe('registration binding', () => {
    it('opens a binding for the equipment the drive turns, instead of storing a uuid on the row', async () => {
      const input: CreateVfdDeviceInput = {
        name: 'Feeder drive',
        brand: VfdBrand.DANFOSS,
        protocol: VfdProtocol.MODBUS_TCP,
        protocolConfiguration: {
          host: '192.168.1.100',
          port: 502,
          unitId: 1,
          connectionTimeout: 3000,
          responseTimeout: 1000,
        },
        drivenEquipmentId: 'equipment-789',
      };

      await service.create(input, tenantId);

      expect(driveBindingService.bind).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        'equipment-789',
      );
      // And it never reached the device row: the saved entity carries no
      // equipment/unit id of its own.
      const saved = (repository.save as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(saved['drivenEquipmentId']).toBeUndefined();
      expect(saved['tankId']).toBeUndefined();
      expect(saved['pumpId']).toBeUndefined();
    });

    it('closes the binding when the drive is deleted', async () => {
      repository.findOne.mockResolvedValue(mockDevice as VfdDevice);

      await service.delete('device-123', tenantId);

      expect(driveBindingService.unbind).toHaveBeenCalledWith('device-123', tenantId);
    });
  });
});
