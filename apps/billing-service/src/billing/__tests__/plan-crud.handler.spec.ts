import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CreatePlanHandler } from '../handlers/create-plan.handler';
import { UpdatePlanHandler } from '../handlers/update-plan.handler';
import { DeactivatePlanHandler } from '../handlers/deactivate-plan.handler';
import { CreatePlanCommand } from '../commands/create-plan.command';
import { UpdatePlanCommand } from '../commands/update-plan.command';
import { DeactivatePlanCommand } from '../commands/deactivate-plan.command';
import { Plan } from '../entities/plan.entity';
import { PlanTier, BillingCycle } from '../entities/subscription.entity';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';

describe('Plan CRUD Handlers', () => {
  let mockDataSource: Partial<DataSource>;
  let mockPlanRepo: Partial<Repository<Plan>>;
  let mockManager: Partial<EntityManager>;

  const userId = 'admin-001';

  beforeEach(() => {
    mockPlanRepo = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((data) => ({ ...data, id: 'new-plan-id', version: 1 })),
      save: jest.fn().mockImplementation((plan) => Promise.resolve({ ...plan, version: (plan.version || 0) + 1 })),
    };

    mockManager = {
      getRepository: jest.fn().mockReturnValue(mockPlanRepo),
    };

    mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
    };
  });

  describe('CreatePlanHandler', () => {
    let handler: CreatePlanHandler;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CreatePlanHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();
      handler = module.get(CreatePlanHandler);
    });

    it('should create a plan successfully', async () => {
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(null);

      const result = await handler.execute(
        new CreatePlanCommand(
          {
            name: 'Starter',
            tier: PlanTier.STARTER,
            basePrice: 49,
            currency: 'USD',
            billingCycle: BillingCycle.MONTHLY,
            limits: {
              maxFarms: 3,
              maxPonds: 30,
              maxSensors: 20,
              maxUsers: 5,
              dataRetentionDays: 90,
              alertsEnabled: true,
              reportsEnabled: false,
              apiAccessEnabled: false,
              customIntegrationsEnabled: false,
            },
            pricing: {
              basePrice: 49,
              perFarmPrice: 10,
              perSensorPrice: 2,
              perUserPrice: 5,
              currency: 'USD',
            },
            features: ['basic_monitoring'],
            isPublic: true,
            sortOrder: 1,
          },
          userId,
        ),
      );

      expect(result.name).toBe('Starter');
      expect(result.tier).toBe(PlanTier.STARTER);
      expect(mockPlanRepo.save).toHaveBeenCalled();
    });

    it('should throw ConflictException for duplicate plan name', async () => {
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue({ id: 'existing', name: 'Starter' });

      await expect(
        handler.execute(
          new CreatePlanCommand(
            {
              name: 'Starter',
              tier: PlanTier.STARTER,
              basePrice: 49,
              limits: {
                maxFarms: 3,
                maxPonds: 30,
                maxSensors: 20,
                maxUsers: 5,
                dataRetentionDays: 90,
                alertsEnabled: true,
                reportsEnabled: false,
                apiAccessEnabled: false,
                customIntegrationsEnabled: false,
              },
              pricing: {
                basePrice: 49,
              },
            },
            userId,
          ),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException when basePrice and pricing.basePrice mismatch', async () => {
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        handler.execute(
          new CreatePlanCommand(
            {
              name: 'Mismatch Plan',
              tier: PlanTier.STARTER,
              basePrice: 49,
              limits: {
                maxFarms: 3,
                maxPonds: 30,
                maxSensors: 20,
                maxUsers: 5,
                dataRetentionDays: 90,
                alertsEnabled: true,
                reportsEnabled: false,
                apiAccessEnabled: false,
                customIntegrationsEnabled: false,
              },
              pricing: {
                basePrice: 99, // Different from top-level basePrice
              },
            },
            userId,
          ),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('UpdatePlanHandler', () => {
    let handler: UpdatePlanHandler;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UpdatePlanHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();
      handler = module.get(UpdatePlanHandler);
    });

    it('should update plan name', async () => {
      const existingPlan = {
        id: 'plan-001',
        name: 'Starter',
        tier: PlanTier.STARTER,
        version: 1,
      };
      (mockPlanRepo.findOne as jest.Mock)
        .mockResolvedValueOnce(existingPlan) // lock query
        .mockResolvedValueOnce(null); // duplicate name check

      const result = await handler.execute(
        new UpdatePlanCommand(
          'plan-001',
          { name: 'Starter Plus', expectedVersion: 1 },
          userId,
        ),
      );

      expect(mockPlanRepo.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing plan', async () => {
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        handler.execute(
          new UpdatePlanCommand(
            'nonexistent',
            { name: 'New Name', expectedVersion: 1 },
            userId,
          ),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException for version mismatch', async () => {
      const existingPlan = { id: 'plan-001', name: 'Starter', version: 3 };
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(existingPlan);

      await expect(
        handler.execute(
          new UpdatePlanCommand(
            'plan-001',
            { name: 'New Name', expectedVersion: 1 },
            userId,
          ),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('DeactivatePlanHandler', () => {
    let handler: DeactivatePlanHandler;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DeactivatePlanHandler,
          { provide: DataSource, useValue: mockDataSource },
        ],
      }).compile();
      handler = module.get(DeactivatePlanHandler);
    });

    it('should deactivate an active plan', async () => {
      const plan = { id: 'plan-001', name: 'Starter', isActive: true, isPublic: true };
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

      await handler.execute(new DeactivatePlanCommand('plan-001', userId));

      expect(mockPlanRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false, isPublic: false }),
      );
    });

    it('should throw NotFoundException for missing plan', async () => {
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        handler.execute(new DeactivatePlanCommand('nonexistent', userId)),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for already deactivated plan', async () => {
      const plan = { id: 'plan-001', name: 'Starter', isActive: false };
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

      await expect(
        handler.execute(new DeactivatePlanCommand('plan-001', userId)),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
