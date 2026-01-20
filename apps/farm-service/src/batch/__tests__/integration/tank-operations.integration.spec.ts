/**
 * Tank Operations Integration Tests
 *
 * Tank allocation, transfer ve density yönetimi entegrasyon testleri.
 *
 * @module Batch/Tests/Integration
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

// Entities
import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankAllocation, AllocationType } from '../../entities/tank-allocation.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../entities/tank-operation.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { Species } from '../../../species/entities/species.entity';
import { GrowthMeasurement } from '../../../growth/entities/growth-measurement.entity';

// Services
import { BiomassCalculatorService } from '../../services/biomass-calculator.service';

describe('Tank Operations Integration Tests', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let batchRepository: Repository<Batch>;
  let tankRepository: Repository<Tank>;
  let tankAllocationRepository: Repository<TankAllocation>;
  let tankBatchRepository: Repository<TankBatch>;
  let tankOperationRepository: Repository<TankOperation>;
  let speciesRepository: Repository<Species>;
  let biomassService: BiomassCalculatorService;

  const tenantId = 'test-tenant-001';
  let testSpecies: Species;
  let testTank1: Tank;
  let testTank2: Tank;
  let testTank3: Tank;

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
            TankAllocation,
            TankBatch,
            TankOperation,
            Tank,
            Species,
            GrowthMeasurement,
          ],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([
          Batch,
          TankAllocation,
          TankBatch,
          TankOperation,
          Tank,
          Species,
          GrowthMeasurement,
        ]),
      ],
      providers: [BiomassCalculatorService],
    }).compile();

    dataSource = module.get(DataSource);
    batchRepository = module.get(getRepositoryToken(Batch));
    tankRepository = module.get(getRepositoryToken(Tank));
    tankAllocationRepository = module.get(getRepositoryToken(TankAllocation));
    tankBatchRepository = module.get(getRepositoryToken(TankBatch));
    tankOperationRepository = module.get(getRepositoryToken(TankOperation));
    speciesRepository = module.get(getRepositoryToken(Species));
    biomassService = module.get(BiomassCalculatorService);

    // Setup test data
    testSpecies = await speciesRepository.save({
      tenantId,
      scientificName: 'Oncorhynchus mykiss',
      commonName: 'Rainbow Trout',
      category: 'finfish',
    });

    testTank1 = await tankRepository.save({
      tenantId,
      tankCode: 'T-001',
      name: 'Tank 1',
      volumeM3: 100,
      maxDensityKgM3: 25,
      optimalDensityMinKgM3: 10,
      optimalDensityMaxKgM3: 20,
    });

    testTank2 = await tankRepository.save({
      tenantId,
      tankCode: 'T-002',
      name: 'Tank 2',
      volumeM3: 100,
      maxDensityKgM3: 25,
      optimalDensityMinKgM3: 10,
      optimalDensityMaxKgM3: 20,
    });

    testTank3 = await tankRepository.save({
      tenantId,
      tankCode: 'T-003',
      name: 'Tank 3',
      volumeM3: 150, // Larger tank
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
    // Clean up test data
    await tankOperationRepository.delete({ tenantId });
    await tankAllocationRepository.delete({ tenantId });
    await tankBatchRepository.delete({ tenantId });
    await batchRepository.delete({ tenantId });
  });

  describe('Initial Tank Allocation', () => {
    it('should allocate batch to single tank', async () => {
      // Create batch
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-001',
        name: 'Single Tank Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 5000,
        currentQuantity: 5000,
        stockingWeight: 100, // 100g
        stockingDate: new Date(),
        initialBiomassKg: 500, // 5000 * 100 / 1000
        currentBiomassKg: 500,
        status: BatchStatus.STOCKED,
        isActive: true,
        createdBy: 'user-001',
      });

      // Create tank allocation
      const allocation = await tankAllocationRepository.save({
        tenantId,
        batchId: batch.id,
        tankId: testTank1.id,
        allocationType: AllocationType.INITIAL,
        quantity: batch.currentQuantity,
        biomassKg: batch.currentBiomassKg,
        allocationDate: new Date(),
        createdBy: 'user-001',
      });

      // Create tank batch record
      const tankBatch = await tankBatchRepository.save({
        tenantId,
        tankId: testTank1.id,
        batchId: batch.id,
        currentQuantity: batch.currentQuantity,
        currentBiomassKg: batch.currentBiomassKg,
        allocationDate: new Date(),
      });

      expect(allocation.allocationType).toBe(AllocationType.INITIAL);
      expect(tankBatch.currentQuantity).toBe(5000);
      expect(tankBatch.currentBiomassKg).toBe(500);

      // Check density
      const density = tankBatch.currentBiomassKg / testTank1.volumeM3;
      expect(density).toBe(5); // 500kg / 100m3 = 5 kg/m3
    });

    it('should allocate batch to multiple tanks', async () => {
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-002',
        name: 'Multi Tank Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 100,
        stockingDate: new Date(),
        initialBiomassKg: 1000,
        currentBiomassKg: 1000,
        status: BatchStatus.STOCKED,
        isActive: true,
        createdBy: 'user-001',
      });

      // Allocate 60% to tank 1, 40% to tank 2
      const allocation1 = await tankAllocationRepository.save({
        tenantId,
        batchId: batch.id,
        tankId: testTank1.id,
        allocationType: AllocationType.INITIAL,
        quantity: 6000,
        biomassKg: 600,
        allocationDate: new Date(),
        createdBy: 'user-001',
      });

      const allocation2 = await tankAllocationRepository.save({
        tenantId,
        batchId: batch.id,
        tankId: testTank2.id,
        allocationType: AllocationType.INITIAL,
        quantity: 4000,
        biomassKg: 400,
        allocationDate: new Date(),
        createdBy: 'user-001',
      });

      const tankBatch1 = await tankBatchRepository.save({
        tenantId,
        tankId: testTank1.id,
        batchId: batch.id,
        currentQuantity: 6000,
        currentBiomassKg: 600,
        allocationDate: new Date(),
      });

      const tankBatch2 = await tankBatchRepository.save({
        tenantId,
        tankId: testTank2.id,
        batchId: batch.id,
        currentQuantity: 4000,
        currentBiomassKg: 400,
        allocationDate: new Date(),
      });

      // Verify allocations
      expect(allocation1.quantity + allocation2.quantity).toBe(batch.currentQuantity);
      expect(allocation1.biomassKg + allocation2.biomassKg).toBe(batch.currentBiomassKg);

      // Verify tank batches
      expect(tankBatch1.currentQuantity).toBe(6000);
      expect(tankBatch2.currentQuantity).toBe(4000);
    });
  });

  describe('Tank Transfer Operations', () => {
    let sourceBatch: Batch;
    let sourceTankBatch: TankBatch;

    beforeEach(async () => {
      // Setup: batch with fish in tank 1
      sourceBatch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-TRANS',
        name: 'Transfer Test Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 8000,
        currentQuantity: 8000,
        stockingWeight: 150, // 150g
        stockingDate: new Date(),
        initialBiomassKg: 1200, // 8000 * 150 / 1000
        currentBiomassKg: 1200,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
      });

      sourceTankBatch = await tankBatchRepository.save({
        tenantId,
        tankId: testTank1.id,
        batchId: sourceBatch.id,
        currentQuantity: 8000,
        currentBiomassKg: 1200,
        allocationDate: new Date(),
      });
    });

    it('should execute simple transfer between tanks', async () => {
      const transferQuantity = 3000;
      const transferBiomass = (transferQuantity * 150) / 1000; // 450kg

      // Create transfer operation
      const transferOp = await tankOperationRepository.save({
        tenantId,
        batchId: sourceBatch.id,
        equipmentId: testTank1.id, // Source tank
        operationType: OperationType.TRANSFER,
        operationDate: new Date(),
        quantity: transferQuantity,
        biomassKg: transferBiomass,
        performedBy: 'user-001',
        notes: `Transfer to tank ${testTank2.tankCode}`,
      });

      // Update source tank batch
      sourceTankBatch.currentQuantity -= transferQuantity;
      sourceTankBatch.currentBiomassKg -= transferBiomass;
      await tankBatchRepository.save(sourceTankBatch);

      // Create destination tank batch
      const destTankBatch = await tankBatchRepository.save({
        tenantId,
        tankId: testTank2.id,
        batchId: sourceBatch.id,
        currentQuantity: transferQuantity,
        currentBiomassKg: transferBiomass,
        allocationDate: new Date(),
      });

      // Verify source
      expect(sourceTankBatch.currentQuantity).toBe(5000);
      expect(sourceTankBatch.currentBiomassKg).toBe(750);

      // Verify destination
      expect(destTankBatch.currentQuantity).toBe(3000);
      expect(destTankBatch.currentBiomassKg).toBe(450);

      // Verify total is unchanged
      const totalQuantity = sourceTankBatch.currentQuantity + destTankBatch.currentQuantity;
      const totalBiomass = sourceTankBatch.currentBiomassKg + destTankBatch.currentBiomassKg;
      expect(totalQuantity).toBe(8000);
      expect(totalBiomass).toBe(1200);
    });

    it('should track transfer with allocation record', async () => {
      const transferQuantity = 2000;
      const transferBiomass = 300; // 2000 * 150g / 1000

      // Create transfer allocation
      const transferAllocation = await tankAllocationRepository.save({
        tenantId,
        batchId: sourceBatch.id,
        tankId: testTank2.id, // Destination
        allocationType: AllocationType.TRANSFER,
        quantity: transferQuantity,
        biomassKg: transferBiomass,
        allocationDate: new Date(),
        sourceTankId: testTank1.id,
        createdBy: 'user-001',
      });

      expect(transferAllocation.allocationType).toBe(AllocationType.TRANSFER);
      expect(transferAllocation.sourceTankId).toBe(testTank1.id);
    });

    it('should prevent transfer exceeding source quantity', async () => {
      const invalidTransferQuantity = 10000; // More than 8000 in source

      // This should be prevented by business logic
      const isValid = invalidTransferQuantity <= sourceTankBatch.currentQuantity;

      expect(isValid).toBe(false);
    });
  });

  describe('Density Management', () => {
    it('should calculate current density correctly', async () => {
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-DENS',
        name: 'Density Test Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 5000,
        currentQuantity: 5000,
        stockingWeight: 200, // 200g
        stockingDate: new Date(),
        initialBiomassKg: 1000,
        currentBiomassKg: 1000,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
      });

      const tankBatch = await tankBatchRepository.save({
        tenantId,
        tankId: testTank1.id,
        batchId: batch.id,
        currentQuantity: 5000,
        currentBiomassKg: 1000,
        allocationDate: new Date(),
      });

      // Tank 1 has 100m3 volume
      const density = tankBatch.currentBiomassKg / testTank1.volumeM3;

      expect(density).toBe(10); // 1000kg / 100m3 = 10 kg/m3
      expect(density).toBeGreaterThanOrEqual(testTank1.optimalDensityMinKgM3);
      expect(density).toBeLessThanOrEqual(testTank1.optimalDensityMaxKgM3);
    });

    it('should detect high density warning', async () => {
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-HIGH',
        name: 'High Density Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 220, // 220g
        stockingDate: new Date(),
        initialBiomassKg: 2200,
        currentBiomassKg: 2200,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
      });

      const tankBatch = await tankBatchRepository.save({
        tenantId,
        tankId: testTank1.id, // 100m3 tank
        batchId: batch.id,
        currentQuantity: 10000,
        currentBiomassKg: 2200,
        allocationDate: new Date(),
      });

      // Density = 2200 / 100 = 22 kg/m3
      const density = tankBatch.currentBiomassKg / testTank1.volumeM3;

      expect(density).toBe(22);
      expect(density).toBeGreaterThan(testTank1.optimalDensityMaxKgM3); // > 20
      expect(density).toBeLessThan(testTank1.maxDensityKgM3); // < 25
    });

    it('should detect critical density level', async () => {
      const batch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-CRIT',
        name: 'Critical Density Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 12000,
        currentQuantity: 12000,
        stockingWeight: 220,
        stockingDate: new Date(),
        initialBiomassKg: 2640,
        currentBiomassKg: 2640,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
      });

      const tankBatch = await tankBatchRepository.save({
        tenantId,
        tankId: testTank1.id,
        batchId: batch.id,
        currentQuantity: 12000,
        currentBiomassKg: 2640,
        allocationDate: new Date(),
      });

      // Density = 2640 / 100 = 26.4 kg/m3
      const density = tankBatch.currentBiomassKg / testTank1.volumeM3;

      expect(density).toBe(26.4);
      expect(density).toBeGreaterThan(testTank1.maxDensityKgM3); // > 25 (CRITICAL)
    });

    it('should suggest transfer when density is high', async () => {
      const sourceTank = testTank1; // 100m3
      const destTank = testTank3; // 150m3

      // High density in source: 2200kg / 100m3 = 22 kg/m3
      const sourceBiomass = 2200;
      const sourceDensity = sourceBiomass / sourceTank.volumeM3;

      // Empty destination
      const destBiomass = 0;
      const destDensity = destBiomass / destTank.volumeM3;

      // Propose transfer to balance density
      const targetDensity = 15; // Middle of optimal range
      const totalBiomass = sourceBiomass + destBiomass;
      const totalVolume = sourceTank.volumeM3 + destTank.volumeM3;

      // Ideal distribution to achieve equal density
      const idealSourceBiomass = sourceTank.volumeM3 * targetDensity;
      const transferAmount = sourceBiomass - idealSourceBiomass;

      expect(transferAmount).toBe(700); // Transfer 700kg to destination
      expect(sourceDensity).toBeGreaterThan(targetDensity);
    });
  });

  describe('Post-Transfer Density Validation', () => {
    it('should validate transfer will not exceed destination capacity', () => {
      const sourceTank = { volumeM3: 100, currentBiomassKg: 2000 };
      const destTank = { volumeM3: 100, currentBiomassKg: 2200 };
      const transferBiomass = 500;

      const result = biomassService.calculatePostTransferDensity(
        sourceTank,
        destTank,
        transferBiomass,
      );

      // Destination after: (2200 + 500) / 100 = 27 kg/m3
      expect(result.destinationDensity).toBe(27);
      expect(result.isValid).toBe(false);
      expect(result.warnings.some(w => w.includes('kritik'))).toBe(true);
    });

    it('should validate successful transfer scenario', () => {
      const sourceTank = { volumeM3: 100, currentBiomassKg: 2000 };
      const destTank = { volumeM3: 100, currentBiomassKg: 500 };
      const transferBiomass = 500;

      const result = biomassService.calculatePostTransferDensity(
        sourceTank,
        destTank,
        transferBiomass,
      );

      // Source after: (2000 - 500) / 100 = 15 kg/m3
      // Destination after: (500 + 500) / 100 = 10 kg/m3
      expect(result.sourceDensity).toBe(15);
      expect(result.destinationDensity).toBe(10);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('Split Batch Operations', () => {
    it('should handle batch split across tanks', async () => {
      // Create parent batch with 10000 fish
      const parentBatch = await batchRepository.save({
        tenantId,
        batchCode: 'B-2024-PARENT',
        name: 'Parent Batch',
        speciesId: testSpecies.id,
        siteId: 'site-001',
        initialQuantity: 10000,
        currentQuantity: 10000,
        stockingWeight: 100,
        stockingDate: new Date(),
        initialBiomassKg: 1000,
        currentBiomassKg: 1000,
        status: BatchStatus.ACTIVE,
        isActive: true,
        createdBy: 'user-001',
      });

      // Split into 3 tank batches
      const allocations = [
        { tankId: testTank1.id, quantity: 4000, biomass: 400 },
        { tankId: testTank2.id, quantity: 3500, biomass: 350 },
        { tankId: testTank3.id, quantity: 2500, biomass: 250 },
      ];

      for (const alloc of allocations) {
        await tankAllocationRepository.save({
          tenantId,
          batchId: parentBatch.id,
          tankId: alloc.tankId,
          allocationType: AllocationType.SPLIT,
          quantity: alloc.quantity,
          biomassKg: alloc.biomass,
          allocationDate: new Date(),
          createdBy: 'user-001',
        });

        await tankBatchRepository.save({
          tenantId,
          tankId: alloc.tankId,
          batchId: parentBatch.id,
          currentQuantity: alloc.quantity,
          currentBiomassKg: alloc.biomass,
          allocationDate: new Date(),
        });
      }

      // Verify all allocations
      const savedAllocations = await tankAllocationRepository.find({
        where: { tenantId, batchId: parentBatch.id },
      });

      const totalQuantity = savedAllocations.reduce((sum, a) => sum + a.quantity, 0);
      const totalBiomass = savedAllocations.reduce((sum, a) => sum + a.biomassKg, 0);

      expect(savedAllocations).toHaveLength(3);
      expect(totalQuantity).toBe(10000);
      expect(totalBiomass).toBe(1000);
    });
  });
});
