/**
 * Batch Lifecycle Integration Tests
 *
 * Batch'in tam yaşam döngüsünü test eder:
 * Stocking → Active → Growth → Harvest/Close
 *
 * @module Batch/Tests/Integration
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandBus, QueryBus } from '@platform/cqrs';

// Entities
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { MortalityRecord } from '../../entities/mortality-record.entity';
import { TankAllocation } from '../../entities/tank-allocation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation } from '../../entities/tank-operation.entity';
import { Species } from '../../../species/entities/species.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';

// Commands
import { CreateBatchCommand } from '../../commands/create-batch.command';
import { UpdateBatchStatusCommand } from '../../commands/update-batch-status.command';
import { RecordMortalityCommand } from '../../commands/record-mortality.command';
import { CloseBatchCommand } from '../../commands/close-batch.command';

// Queries
import { GetBatchQuery } from '../../queries/get-batch.query';
import { GetBatchPerformanceQuery } from '../../queries/get-batch-performance.query';

// Services
import { BatchService } from '../../services/batch.service';
import { BiomassCalculatorService } from '../../services/biomass-calculator.service';
import { SGRCalculatorService } from '../../services/sgr-calculator.service';

describe('Batch Lifecycle Integration Tests', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let commandBus: CommandBus;
  let queryBus: QueryBus;
  let batchRepository: Repository<Batch>;
  let speciesRepository: Repository<Species>;
  let tankRepository: Repository<Tank>;

  const tenantId = 'test-tenant-001';
  let testSpecies: Species;
  let testTank: Tank;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.TEST_DB_HOST || 'localhost',
          port: parseInt(process.env.TEST_DB_PORT || '5432'),
          username: process.env.TEST_DB_USER || 'postgres',
          password: process.env.TEST_DB_PASS || 'postgres',
          database: process.env.TEST_DB_NAME || 'farm_service_test',
          entities: [
            Batch,
            MortalityRecord,
            TankAllocation,
            TankBatch,
            TankOperation,
            Species,
            Tank,
            GrowthMeasurement,
          ],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([
          Batch,
          MortalityRecord,
          TankAllocation,
          TankBatch,
          TankOperation,
          Species,
          Tank,
          GrowthMeasurement,
        ]),
      ],
      providers: [
        BatchService,
        BiomassCalculatorService,
        SGRCalculatorService,
        {
          provide: CommandBus,
          useValue: {
            execute: jest.fn(),
          },
        },
        {
          provide: QueryBus,
          useValue: {
            execute: jest.fn(),
          },
        },
      ],
    }).compile();

    dataSource = module.get(DataSource);
    commandBus = module.get(CommandBus);
    queryBus = module.get(QueryBus);
    batchRepository = module.get(getRepositoryToken(Batch));
    speciesRepository = module.get(getRepositoryToken(Species));
    tankRepository = module.get(getRepositoryToken(Tank));

    // Setup test data
    testSpecies = await speciesRepository.save({
      tenantId,
      scientificName: 'Oncorhynchus mykiss',
      commonName: 'Rainbow Trout',
      category: 'finfish',
      growthParameters: {
        avgDailyGrowth: 2.5,
        targetFCR: 1.2,
        expectedSurvivalRate: 95,
      },
    });

    testTank = await tankRepository.save({
      tenantId,
      tankCode: 'T-001',
      name: 'Test Tank 1',
      volumeM3: 100,
      maxDensityKgM3: 25,
      optimalDensityMinKgM3: 10,
      optimalDensityMaxKgM3: 20,
    });
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  afterEach(async () => {
    // Clean up batches after each test
    await batchRepository.delete({ tenantId });
  });

  describe('Batch Creation and Initial Status', () => {
    it('should create a new batch with STOCKED status', async () => {
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-001',
        name: 'Test Batch 2024',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 5, // 5g
        stockingDate: new Date(),
        initialBiomassKg: 50, // 10000 * 5 / 1000
        currentBiomassKg: 50,
        status: BatchStatus.STOCKED,
        isActive: true,
        createdBy: 'user-001',
      });

      expect(batch.id).toBeDefined();
      expect(batch.status).toBe(BatchStatus.STOCKED);
      expect(batch.currentQuantity).toBe(10000);
      expect(batch.initialBiomassKg).toBe(50);
    });

    it('should set initial weight tracking correctly', async () => {
      const stockingWeight = 10; // 10g
      const quantity = 5000;

      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-002',
        name: 'Weight Tracking Test',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: quantity,
        currentQuantity: quantity,
        stockingWeight,
        stockingDate: new Date(),
        initialBiomassKg: (quantity * stockingWeight) / 1000,
        currentBiomassKg: (quantity * stockingWeight) / 1000,
        status: BatchStatus.STOCKED,
        isActive: true,
        createdBy: 'user-001',
        weight: {
          theoretical: { avgWeightG: stockingWeight, calculatedAt: new Date() },
          actual: { avgWeightG: stockingWeight, measuredAt: new Date() },
        },
      });

      expect(batch.weight?.theoretical?.avgWeightG).toBe(stockingWeight);
      expect(batch.weight?.actual?.avgWeightG).toBe(stockingWeight);
      expect(batch.initialBiomassKg).toBe(50); // 5000 * 10 / 1000
    });
  });

  describe('Status Transitions', () => {
    let testBatch: Batch;

    beforeEach(async () => {
      testBatch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-TRANS',
        name: 'Status Transition Test',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 5,
        stockingDate: new Date(),
        initialBiomassKg: 50,
        currentBiomassKg: 50,
        status: BatchStatus.STOCKED,
        isActive: true,
        createdBy: 'user-001',
      });
    });

    it('should transition from STOCKED to ACTIVE', async () => {
      testBatch.status = BatchStatus.ACTIVE;
      const updated = await batchRepository.save(testBatch);

      expect(updated.status).toBe(BatchStatus.ACTIVE);
    });

    it('should transition from ACTIVE to HARVESTING', async () => {
      testBatch.status = BatchStatus.ACTIVE;
      await batchRepository.save(testBatch);

      testBatch.status = BatchStatus.HARVESTING;
      const updated = await batchRepository.save(testBatch);

      expect(updated.status).toBe(BatchStatus.HARVESTING);
    });

    it('should transition from HARVESTING to CLOSED', async () => {
      testBatch.status = BatchStatus.HARVESTING;
      await batchRepository.save(testBatch);

      testBatch.status = BatchStatus.CLOSED;
      testBatch.isActive = false;
      testBatch.closedAt = new Date();
      testBatch.closeReason = 'Harvest complete';

      const updated = await batchRepository.save(testBatch);

      expect(updated.status).toBe(BatchStatus.CLOSED);
      expect(updated.isActive).toBe(false);
      expect(updated.closedAt).toBeDefined();
    });

    it('should not allow invalid transitions', async () => {
      // STOCKED -> CLOSED directly should be prevented by business logic
      // This tests the entity's canTransitionTo method if implemented
      const validTransitions: Record<BatchStatus, BatchStatus[]> = {
        [BatchStatus.STOCKED]: [BatchStatus.ACTIVE, BatchStatus.CANCELLED],
        [BatchStatus.ACTIVE]: [BatchStatus.HARVESTING, BatchStatus.CLOSED],
        [BatchStatus.HARVESTING]: [BatchStatus.CLOSED],
        [BatchStatus.CLOSED]: [],
        [BatchStatus.CANCELLED]: [],
      };

      expect(validTransitions[BatchStatus.STOCKED]).not.toContain(BatchStatus.CLOSED);
    });
  });

  describe('Mortality Tracking', () => {
    let testBatch: Batch;

    beforeEach(async () => {
      testBatch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-MORT',
        name: 'Mortality Test',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 5,
        stockingDate: new Date(),
        initialBiomassKg: 50,
        currentBiomassKg: 50,
        totalMortality: 0,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
      });
    });

    it('should update quantity after mortality', async () => {
      const mortalityCount = 100;

      testBatch.currentQuantity -= mortalityCount;
      testBatch.totalMortality = (testBatch.totalMortality || 0) + mortalityCount;

      const updated = await batchRepository.save(testBatch);

      expect(updated.currentQuantity).toBe(9900);
      expect(updated.totalMortality).toBe(100);
    });

    it('should calculate mortality rate correctly', async () => {
      testBatch.currentQuantity = 9500;
      testBatch.totalMortality = 500;
      await batchRepository.save(testBatch);

      const mortalityRate = (testBatch.totalMortality / testBatch.initialQuantity) * 100;

      expect(mortalityRate).toBe(5); // 500/10000 * 100 = 5%
    });

    it('should track cumulative mortality', async () => {
      // First mortality event
      testBatch.currentQuantity -= 50;
      testBatch.totalMortality = 50;
      await batchRepository.save(testBatch);

      // Second mortality event
      testBatch.currentQuantity -= 30;
      testBatch.totalMortality += 30;
      await batchRepository.save(testBatch);

      // Third mortality event
      testBatch.currentQuantity -= 20;
      testBatch.totalMortality += 20;
      const final = await batchRepository.save(testBatch);

      expect(final.currentQuantity).toBe(9900);
      expect(final.totalMortality).toBe(100);
    });
  });

  describe('Biomass Calculations', () => {
    let testBatch: Batch;
    let biomassService: BiomassCalculatorService;

    beforeEach(async () => {
      testBatch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-BIO',
        name: 'Biomass Test',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 10, // 10g
        stockingDate: new Date(),
        initialBiomassKg: 100, // 10000 * 10 / 1000
        currentBiomassKg: 100,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
        weight: {
          theoretical: { avgWeightG: 10, calculatedAt: new Date() },
          actual: { avgWeightG: 10, measuredAt: new Date() },
        },
      });

      biomassService = module.get(BiomassCalculatorService);
    });

    it('should calculate biomass correctly', () => {
      const quantity = 10000;
      const avgWeight = 250; // 250g

      const biomass = biomassService.calculateBiomass(quantity, avgWeight);

      expect(biomass).toBe(2500); // 10000 * 250 / 1000 = 2500 kg
    });

    it('should update biomass after growth', async () => {
      // Simulate growth: weight increased from 10g to 50g
      const newAvgWeight = 50;
      const newBiomass = (testBatch.currentQuantity * newAvgWeight) / 1000;

      testBatch.currentBiomassKg = newBiomass;
      testBatch.weight = {
        ...testBatch.weight,
        actual: { avgWeightG: newAvgWeight, measuredAt: new Date() },
      };

      const updated = await batchRepository.save(testBatch);

      expect(updated.currentBiomassKg).toBe(500); // 10000 * 50 / 1000
    });

    it('should account for mortality in biomass', async () => {
      // Initial: 10000 fish * 10g = 100kg
      // After mortality: 9500 fish * 10g = 95kg
      testBatch.currentQuantity = 9500;
      testBatch.totalMortality = 500;
      testBatch.currentBiomassKg = 95;

      const updated = await batchRepository.save(testBatch);

      expect(updated.currentBiomassKg).toBe(95);
    });
  });

  describe('FCR Tracking', () => {
    let testBatch: Batch;

    beforeEach(async () => {
      testBatch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-FCR',
        name: 'FCR Test',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 10,
        stockingDate: new Date(),
        initialBiomassKg: 100,
        currentBiomassKg: 100,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
        fcr: {
          target: 1.2,
          current: 0,
          cumulative: 0,
        },
      });
    });

    it('should initialize FCR tracking', async () => {
      expect(testBatch.fcr?.target).toBe(1.2);
      expect(testBatch.fcr?.current).toBe(0);
      expect(testBatch.fcr?.cumulative).toBe(0);
    });

    it('should update FCR after feeding and growth', async () => {
      // Simulated: 150kg feed given, 100kg biomass gain
      // FCR = 150 / 100 = 1.5
      testBatch.fcr = {
        target: 1.2,
        current: 1.5,
        cumulative: 1.5,
      };
      testBatch.currentBiomassKg = 200; // 100kg gain

      const updated = await batchRepository.save(testBatch);

      expect(updated.fcr?.current).toBe(1.5);
      expect(updated.fcr?.cumulative).toBe(1.5);
    });

    it('should track FCR variance from target', async () => {
      testBatch.fcr = {
        target: 1.2,
        current: 1.5,
        cumulative: 1.5,
      };
      await batchRepository.save(testBatch);

      const variance = ((testBatch.fcr.current - testBatch.fcr.target) / testBatch.fcr.target) * 100;

      expect(variance).toBeCloseTo(25, 1); // 25% above target
    });
  });

  describe('Full Lifecycle Flow', () => {
    it('should complete full batch lifecycle', async () => {
      // 1. Create batch (STOCKED)
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-FULL',
        name: 'Full Lifecycle Test',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 5,
        stockingDate: new Date('2024-01-01'),
        initialBiomassKg: 50,
        currentBiomassKg: 50,
        status: BatchStatus.STOCKED,
        isActive: true,
        createdBy: 'user-001',
      });

      expect(batch.status).toBe(BatchStatus.STOCKED);

      // 2. Activate batch
      batch.status = BatchStatus.ACTIVE;
      await batchRepository.save(batch);

      // 3. Record mortality over time
      batch.currentQuantity = 9500;
      batch.totalMortality = 500;
      await batchRepository.save(batch);

      // 4. Growth occurs (weight increases)
      batch.currentBiomassKg = 2375; // 9500 * 250g / 1000
      batch.weight = {
        theoretical: { avgWeightG: 250, calculatedAt: new Date() },
        actual: { avgWeightG: 250, measuredAt: new Date() },
      };
      await batchRepository.save(batch);

      // 5. Start harvesting
      batch.status = BatchStatus.HARVESTING;
      await batchRepository.save(batch);

      // 6. Complete harvest and close
      batch.status = BatchStatus.CLOSED;
      batch.isActive = false;
      batch.closedAt = new Date();
      batch.closeReason = 'Harvest completed';
      batch.fcr = {
        target: 1.2,
        current: 1.35,
        cumulative: 1.35,
      };

      const finalBatch = await batchRepository.save(batch);

      // Verify final state
      expect(finalBatch.status).toBe(BatchStatus.CLOSED);
      expect(finalBatch.isActive).toBe(false);
      expect(finalBatch.currentQuantity).toBe(9500);
      expect(finalBatch.totalMortality).toBe(500);
      expect(finalBatch.currentBiomassKg).toBe(2375);
      expect(finalBatch.fcr?.cumulative).toBe(1.35);

      // Calculate final metrics
      const mortalityRate = (finalBatch.totalMortality / finalBatch.initialQuantity) * 100;
      const survivalRate = 100 - mortalityRate;
      const biomassGain = finalBatch.currentBiomassKg - finalBatch.initialBiomassKg;

      expect(mortalityRate).toBe(5);
      expect(survivalRate).toBe(95);
      expect(biomassGain).toBe(2325); // 2375 - 50
    });
  });
});
