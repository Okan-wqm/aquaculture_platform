/**
 * Create Farm Handler Unit Tests
 *
 * Tests for farm CRUD operations via CQRS command handler
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { CreateFarmHandler } from '../handlers/create-farm.handler';
import { CreateFarmCommand } from '../commands/create-farm.command';
import { Farm } from '../entities/farm.entity';

describe('CreateFarmHandler', () => {
  let handler: CreateFarmHandler;
  let farmRepository: jest.Mocked<Repository<Farm>>;

  const mockTenantId = 'tenant-123';
  const mockUserId = 'user-456';

  const createMockFarm = (overrides: Partial<Farm> = {}): Farm => ({
    id: 'farm-uuid-123',
    name: 'Test Farm',
    location: { lat: 10.5, lng: 20.5 },
    tenantId: mockTenantId,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  } as Farm);

  beforeEach(async () => {
    const mockFarmRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateFarmHandler,
        {
          provide: getRepositoryToken(Farm),
          useValue: mockFarmRepository,
        },
        {
          provide: 'EVENT_BUS',
          useValue: { publish: jest.fn() },
        },
      ],
    }).compile();

    handler = module.get<CreateFarmHandler>(CreateFarmHandler);
    farmRepository = module.get(getRepositoryToken(Farm));
  });

  describe('execute', () => {
    it('should create a new farm successfully', async () => {
      const command = new CreateFarmCommand(
        'New Farm',
        { lat: 10.5, lng: 20.5 },
        mockTenantId,
        mockUserId,
      );

      const createdFarm = createMockFarm({ name: 'New Farm' });

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockReturnValue(createdFarm);
      farmRepository.save.mockResolvedValue(createdFarm);

      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.name).toBe('New Farm');
      expect(result.tenantId).toBe(mockTenantId);
      expect(farmRepository.findOne).toHaveBeenCalledWith({
        where: { name: 'New Farm', tenantId: mockTenantId },
      });
    });

    it('should throw ConflictException if farm with same name exists', async () => {
      const command = new CreateFarmCommand(
        'Existing Farm',
        { lat: 10.5, lng: 20.5 },
        mockTenantId,
        mockUserId,
      );

      farmRepository.findOne.mockResolvedValue(
        createMockFarm({ name: 'Existing Farm' }),
      );

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(
        'Farm with name "Existing Farm" already exists',
      );
    });

    it('should create farm with optional fields', async () => {
      const command = new CreateFarmCommand(
        'Full Farm',
        { lat: 10.5, lng: 20.5 },
        mockTenantId,
        mockUserId,
        '123 Farm Road',
        'John Doe',
        '+1234567890',
        'john@farm.com',
        'A test farm',
        100.5,
      );

      const createdFarm = createMockFarm({
        name: 'Full Farm',
        address: '123 Farm Road',
        contactPerson: 'John Doe',
        contactPhone: '+1234567890',
        contactEmail: 'john@farm.com',
        description: 'A test farm',
        totalArea: 100.5,
      });

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockReturnValue(createdFarm);
      farmRepository.save.mockResolvedValue(createdFarm);

      const result = await handler.execute(command);

      expect(result.address).toBe('123 Farm Road');
      expect(result.contactPerson).toBe('John Doe');
      expect(result.contactPhone).toBe('+1234567890');
      expect(result.contactEmail).toBe('john@farm.com');
      expect(result.description).toBe('A test farm');
      expect(result.totalArea).toBe(100.5);
    });

    it('should set createdBy from userId', async () => {
      const command = new CreateFarmCommand(
        'User Farm',
        { lat: 10.5, lng: 20.5 },
        mockTenantId,
        mockUserId,
      );

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockImplementation((data) => data as Farm);
      farmRepository.save.mockImplementation(async (farm) => ({
        ...farm,
        id: 'new-farm-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      } as Farm));

      await handler.execute(command);

      expect(farmRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: mockUserId,
        }),
      );
    });

    it('should set isActive to true by default', async () => {
      const command = new CreateFarmCommand(
        'Active Farm',
        { lat: 10.5, lng: 20.5 },
        mockTenantId,
        mockUserId,
      );

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockImplementation((data) => data as Farm);
      farmRepository.save.mockImplementation(async (farm) => ({
        ...farm,
        id: 'new-farm-id',
      } as Farm));

      await handler.execute(command);

      expect(farmRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isActive: true,
        }),
      );
    });

    it('should handle different tenants with same farm name', async () => {
      const tenant1Command = new CreateFarmCommand(
        'Shared Name Farm',
        { lat: 10.5, lng: 20.5 },
        'tenant-1',
        mockUserId,
      );

      const tenant2Command = new CreateFarmCommand(
        'Shared Name Farm',
        { lat: 15.0, lng: 25.0 },
        'tenant-2',
        mockUserId,
      );

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockImplementation((data) => data as Farm);
      farmRepository.save.mockImplementation(async (farm) => ({
        ...farm,
        id: `farm-${farm.tenantId}`,
      } as Farm));

      const result1 = await handler.execute(tenant1Command);
      const result2 = await handler.execute(tenant2Command);

      expect(result1.tenantId).toBe('tenant-1');
      expect(result2.tenantId).toBe('tenant-2');
      expect(result1.name).toBe(result2.name);
    });
  });

  describe('duplicate check', () => {
    it('should check for duplicates in same tenant only', async () => {
      const command = new CreateFarmCommand(
        'Test Farm',
        { lat: 10.5, lng: 20.5 },
        mockTenantId,
        mockUserId,
      );

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockReturnValue(createMockFarm());
      farmRepository.save.mockResolvedValue(createMockFarm());

      await handler.execute(command);

      expect(farmRepository.findOne).toHaveBeenCalledWith({
        where: {
          name: 'Test Farm',
          tenantId: mockTenantId,
        },
      });
    });
  });

  describe('location validation', () => {
    it('should accept valid latitude and longitude', async () => {
      const command = new CreateFarmCommand(
        'Geo Farm',
        { lat: -33.8688, lng: 151.2093 }, // Sydney coordinates
        mockTenantId,
        mockUserId,
      );

      farmRepository.findOne.mockResolvedValue(null);
      farmRepository.create.mockImplementation((data) => data as Farm);
      farmRepository.save.mockImplementation(async (farm) => ({
        ...farm,
        id: 'geo-farm-id',
      } as Farm));

      await handler.execute(command);

      expect(farmRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          location: { lat: -33.8688, lng: 151.2093 },
        }),
      );
    });
  });
});
