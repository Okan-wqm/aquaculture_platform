/**
 * SensorTypeService Unit Tests
 */

 
 

import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  SensorDataChannel,
  ChannelDataType,
  DiscoverySource,
} from '../../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { SensorTypeService } from '../sensor-type.service';

describe('SensorTypeService', () => {
  let service: SensorTypeService;
  let sensorTypeRepo: jest.Mocked<Repository<SensorTypeDefinition>>;
  let templateRepo: jest.Mocked<Repository<IndustryTemplate>>;
  let channelRepo: jest.Mocked<Repository<SensorDataChannel>>;

  const tenantId = 'tenant-123';

  const mockSensorType: Partial<SensorTypeDefinition> = {
    id: 'type-1',
    tenantId,
    typeKey: 'water_quality',
    displayName: 'Water Quality Sensor',
    description: 'Multi-parameter water quality',
    icon: 'water',
    category: 'environmental',
    industry: 'aquaculture',
    isSystem: false,
    defaultChannels: [
      {
        channelKey: 'temperature',
        displayLabel: 'Temperature',
        dataType: ChannelDataType.NUMBER,
        unit: 'Celsius',
        unitSymbol: '°C',
      },
    ],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSystemType: Partial<SensorTypeDefinition> = {
    ...mockSensorType,
    id: 'system-type-1',
    typeKey: 'system_ph',
    displayName: 'pH Sensor (System)',
    isSystem: true,
  };

  const mockTemplate: Partial<IndustryTemplate> = {
    id: 'template-1',
    templateKey: 'shrimp_farming',
    displayName: 'Shrimp Farming',
    description: 'Template for shrimp farming operations',
    isActive: true,
    sensorTypes: [
      {
        typeKey: 'water_quality',
        displayName: 'Water Quality Sensor',
        description: 'Multi-parameter water quality',
        category: 'environmental',
        defaultChannels: [
          {
            channelKey: 'temperature',
            displayLabel: 'Temperature',
            dataType: ChannelDataType.NUMBER,
            unit: 'Celsius',
            unitSymbol: '°C',
          },
        ],
      },
      {
        typeKey: 'dissolved_oxygen',
        displayName: 'Dissolved Oxygen',
        category: 'environmental',
        defaultChannels: [],
      },
    ],
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorTypeService,
        {
          provide: getRepositoryToken(SensorTypeDefinition),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn().mockImplementation((dto) => ({ ...dto })),
            save: jest.fn().mockImplementation((entity) =>
              Promise.resolve({ id: 'new-id', ...entity }),
            ),
            remove: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getRepositoryToken(IndustryTemplate),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(SensorDataChannel),
          useValue: {
            find: jest.fn(),
            create: jest.fn().mockImplementation((dto) => ({ ...dto })),
            // Array-aware: the service batch-saves channel ARRAYS
            // (save(channels) is idiomatic TypeORM); spreading an array
            // into an object was the original mock's error.
            save: jest.fn().mockImplementation((entity) =>
              Array.isArray(entity)
                ? Promise.resolve(entity.map((e, i) => ({ id: `channel-${i}`, ...e })))
                : Promise.resolve({ id: 'channel-id', ...entity }),
            ),
          },
        },
      ],
    }).compile();

    service = module.get<SensorTypeService>(SensorTypeService);
    sensorTypeRepo = module.get(getRepositoryToken(SensorTypeDefinition));
    templateRepo = module.get(getRepositoryToken(IndustryTemplate));
    channelRepo = module.get(getRepositoryToken(SensorDataChannel));
  });

  describe('getSensorTypes', () => {
    it('should return tenant types and system types ordered by displayName', async () => {
      const types = [mockSensorType, mockSystemType] as SensorTypeDefinition[];
      sensorTypeRepo.find.mockResolvedValue(types);

      const result = await service.getSensorTypes(tenantId);

      expect(result).toEqual(types);
      expect(sensorTypeRepo.find).toHaveBeenCalledWith({
        where: [
          { tenantId },
          { isSystem: true },
        ],
        order: { displayName: 'ASC' },
      });
    });
  });

  describe('createSensorType', () => {
    const createInput = {
      typeKey: 'new_type',
      displayName: 'New Type',
      description: 'A new sensor type',
      icon: 'sensor',
      category: 'custom',
      industry: 'aquaculture',
    };

    it('should create a custom sensor type', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(null);

      const result = await service.createSensorType(tenantId, createInput);

      expect(sensorTypeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          typeKey: 'new_type',
          displayName: 'New Type',
          isSystem: false,
        }),
      );
      expect(sensorTypeRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should reject duplicate typeKey for same tenant', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSensorType as SensorTypeDefinition,
      );

      await expect(
        service.createSensorType(tenantId, {
          ...createInput,
          typeKey: 'water_quality',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should default defaultChannels to empty array', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(null);

      await service.createSensorType(tenantId, {
        typeKey: 'minimal',
        displayName: 'Minimal',
      });

      expect(sensorTypeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultChannels: [],
          metadata: {},
        }),
      );
    });
  });

  describe('updateSensorType', () => {
    it('should update a custom sensor type', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSensorType as SensorTypeDefinition,
      );

      const result = await service.updateSensorType(tenantId, 'type-1', {
        displayName: 'Updated Name',
      });

      expect(result).toBeDefined();
      expect(sensorTypeRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: 'Updated Name',
        }),
      );
    });

    it('should throw NotFoundException for non-existent type', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSensorType(tenantId, 'missing-id', {
          displayName: 'X',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject updating system types', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSystemType as SensorTypeDefinition,
      );

      await expect(
        service.updateSensorType(tenantId, 'system-type-1', {
          displayName: 'Hacked',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteSensorType', () => {
    it('should delete a custom sensor type', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSensorType as SensorTypeDefinition,
      );

      const result = await service.deleteSensorType(tenantId, 'type-1');

      expect(result).toBe(true);
      expect(sensorTypeRepo.remove).toHaveBeenCalledWith(mockSensorType);
    });

    it('should throw NotFoundException for non-existent type', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteSensorType(tenantId, 'missing-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject deleting system types', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSystemType as SensorTypeDefinition,
      );

      await expect(
        service.deleteSensorType(tenantId, 'system-type-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getTemplates', () => {
    it('should return active templates ordered by displayName', async () => {
      const templates = [mockTemplate] as IndustryTemplate[];
      templateRepo.find.mockResolvedValue(templates);

      const result = await service.getTemplates();

      expect(result).toEqual(templates);
      expect(templateRepo.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { displayName: 'ASC' },
      });
    });
  });

  describe('applyTemplate', () => {
    it('should create sensor types from template', async () => {
      templateRepo.findOne.mockResolvedValue(
        mockTemplate as IndustryTemplate,
      );
      sensorTypeRepo.find.mockResolvedValue([]);

      const result = await service.applyTemplate(tenantId, 'shrimp_farming');

      expect(result).toHaveLength(2);
      expect(sensorTypeRepo.save).toHaveBeenCalledTimes(2);
    });

    it('should skip types that already exist for the tenant', async () => {
      templateRepo.findOne.mockResolvedValue(
        mockTemplate as IndustryTemplate,
      );
      // water_quality already exists
      sensorTypeRepo.find.mockResolvedValue([
        { typeKey: 'water_quality' } as SensorTypeDefinition,
      ]);

      const result = await service.applyTemplate(tenantId, 'shrimp_farming');

      // Only dissolved_oxygen should be created
      expect(result).toHaveLength(1);
      expect(sensorTypeRepo.save).toHaveBeenCalledTimes(1);
      expect(sensorTypeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ typeKey: 'dissolved_oxygen' }),
      );
    });

    it('should throw NotFoundException for non-existent template', async () => {
      templateRepo.findOne.mockResolvedValue(null);

      await expect(
        service.applyTemplate(tenantId, 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return empty array for template with no sensor types', async () => {
      templateRepo.findOne.mockResolvedValue({
        ...mockTemplate,
        sensorTypes: [],
      } as IndustryTemplate);

      const result = await service.applyTemplate(tenantId, 'shrimp_farming');
      expect(result).toHaveLength(0);
    });
  });

  describe('createChannelsFromTypeDefinition', () => {
    const sensorId = 'sensor-456';
    const typeDefId = 'type-1';

    it('should create channels from type definition defaultChannels', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSensorType as SensorTypeDefinition,
      );
      channelRepo.find.mockResolvedValue([]);

      const result = await service.createChannelsFromTypeDefinition(
        sensorId,
        tenantId,
        typeDefId,
      );

      expect(result).toHaveLength(1);
      expect(channelRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sensorId,
          tenantId,
          channelKey: 'temperature',
          displayLabel: 'Temperature',
          dataType: ChannelDataType.NUMBER,
          unit: 'Celsius',
          unitSymbol: '°C',
          discoverySource: DiscoverySource.TEMPLATE,
          isEnabled: true,
        }),
      );
    });

    it('should skip existing channels', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(
        mockSensorType as SensorTypeDefinition,
      );
      channelRepo.find.mockResolvedValue([
        { channelKey: 'temperature' } as SensorDataChannel,
      ]);

      const result = await service.createChannelsFromTypeDefinition(
        sensorId,
        tenantId,
        typeDefId,
      );

      expect(result).toHaveLength(0);
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent type definition', async () => {
      sensorTypeRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createChannelsFromTypeDefinition(sensorId, tenantId, 'bad-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return empty array for type with no default channels', async () => {
      sensorTypeRepo.findOne.mockResolvedValue({
        ...mockSensorType,
        defaultChannels: [],
      } as SensorTypeDefinition);
      channelRepo.find.mockResolvedValue([]);

      const result = await service.createChannelsFromTypeDefinition(
        sensorId,
        tenantId,
        typeDefId,
      );

      expect(result).toHaveLength(0);
    });
  });
});
