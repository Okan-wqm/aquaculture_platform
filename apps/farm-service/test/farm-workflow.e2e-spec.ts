/**
 * Farm Workflow E2E Tests
 *
 * Tam farm workflow'unun uçtan uca testi.
 * Batch oluşturma, büyüme takibi, yemleme ve hasat döngüsü.
 *
 * @module Farm-Service/E2E
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Farm Workflow E2E Tests', () => {
  let app: INestApplication;
  let httpServer: any;

  const tenantId = 'workflow-test-tenant';
  const testUser = 'workflow-test-user';

  // Test data IDs
  let speciesId: string;
  let siteId: string;
  let tankId: string;
  let feedId: string;

  // Created entities
  let batchId: string;
  let batchCode: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    httpServer = app.getHttpServer();

    // Setup prerequisite data
    // In a real test, these would be created via API or database seeding
    speciesId = 'wf-species-001';
    siteId = 'wf-site-001';
    tankId = 'wf-tank-001';
    feedId = 'wf-feed-001';
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Complete Production Cycle', () => {
    it('Step 1: Should create new batch (stocking)', async () => {
      const stockingDate = new Date('2024-01-15');

      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation CreateBatch($tenantId: ID!, $input: CreateBatchInput!) {
              createBatch(tenantId: $tenantId, input: $input) {
                id
                batchCode
                name
                status
                currentQuantity
                initialBiomassKg
                stockingDate
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              name: 'Production Batch 2024-Q1',
              speciesId,
              siteId,
              initialQuantity: 50000,
              initialAvgWeightG: 10, // 10g fingerlings
              stockingDate: stockingDate.toISOString(),
              sourceType: 'hatchery',
              supplierId: 'supplier-001',
              createdBy: testUser,
              notes: 'Q1 2024 production batch',
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.createBatch.status).toBe('stocked');
      expect(data.createBatch.currentQuantity).toBe(50000);
      expect(data.createBatch.initialBiomassKg).toBe(500); // 50000 * 10 / 1000

      batchId = data.createBatch.id;
      batchCode = data.createBatch.batchCode;

      console.log(`Created batch: ${batchCode} (${batchId})`);
    });

    it('Step 2: Should allocate batch to tank', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation AllocateBatchToTank($tenantId: ID!, $input: AllocateToTankInput!) {
              allocateBatchToTank(tenantId: $tenantId, input: $input) {
                id
                tankId
                quantity
                biomassKg
                allocationType
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId,
              tankId,
              quantity: 50000,
              biomassKg: 500,
              allocationType: 'initial',
              allocationDate: new Date().toISOString(),
              allocatedBy: testUser,
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.allocateBatchToTank.quantity).toBe(50000);
    });

    it('Step 3: Should activate batch for production', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation UpdateBatchStatus($tenantId: ID!, $id: ID!, $status: BatchStatus!, $reason: String) {
              updateBatchStatus(tenantId: $tenantId, id: $id, status: $status, reason: $reason) {
                id
                status
              }
            }
          `,
          variables: {
            tenantId,
            id: batchId,
            status: 'active',
            reason: 'Starting production phase',
          },
        })
        .expect(200);

      expect(response.body.data.updateBatchStatus.status).toBe('active');
    });

    it('Step 4: Should record daily feeding', async () => {
      const feedingDate = new Date();

      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation CreateFeedingRecord($tenantId: ID!, $input: CreateFeedingRecordInput!) {
              createFeedingRecord(tenantId: $tenantId, input: $input) {
                id
                feedingDate
                plannedAmount
                actualAmount
                variance
                fishBehavior
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId,
              tankId,
              feedingDate: feedingDate.toISOString(),
              feedingTime: '08:00',
              feedingSequence: 1,
              totalMealsToday: 3,
              feedId,
              plannedAmount: 15, // kg
              actualAmount: 14.5, // kg
              feedingMethod: 'manual',
              fedBy: testUser,
              fishBehavior: {
                appetite: 'good',
                feedingIntensity: 8,
              },
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.createFeedingRecord.actualAmount).toBe(14.5);
    });

    it('Step 5: Should record growth measurement', async () => {
      const measurementDate = new Date();

      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation RecordGrowthSample($tenantId: ID!, $input: RecordGrowthSampleInput!) {
              recordGrowthSample(tenantId: $tenantId, input: $input) {
                id
                measurementDate
                sampleSize
                averageWeight
                weightCV
                estimatedBiomass
                performance
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId,
              tankId,
              measurementDate: measurementDate.toISOString(),
              measurementType: 'routine',
              measurementMethod: 'manual_scale',
              sampleSize: 50,
              populationSize: 49500, // After some mortality
              individualMeasurements: [
                { sampleNumber: 1, weight: 95 },
                { sampleNumber: 2, weight: 102 },
                { sampleNumber: 3, weight: 98 },
                // ... more measurements
              ],
              conditions: {
                waterTemp: 14.5,
                dissolvedOxygen: 8.2,
                feedingStatus: 'fasted_24h',
                timeOfDay: '09:00',
              },
              measuredBy: testUser,
              updateBatchWeight: true,
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.recordGrowthSample.sampleSize).toBe(50);
    });

    it('Step 6: Should record mortality event', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation RecordMortality($tenantId: ID!, $input: RecordMortalityInput!) {
              recordMortality(tenantId: $tenantId, input: $input) {
                id
                quantity
                cause
                notes
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId,
              tankId,
              quantity: 500,
              cause: 'disease',
              mortalityDate: new Date().toISOString(),
              symptoms: 'Observed fin erosion and lethargy',
              suspectedPathogen: 'Bacterial',
              notes: 'Treated with antibiotics',
              recordedBy: testUser,
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.recordMortality.quantity).toBe(500);
    });

    it('Step 7: Should get batch performance summary', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            query GetBatchPerformance($tenantId: ID!, $id: ID!) {
              batchPerformance(tenantId: $tenantId, id: $id) {
                batchId
                currentMetrics {
                  currentQuantity
                  currentBiomassKg
                  survivalRate
                  mortalityRate
                }
                fcrMetrics {
                  currentFCR
                  targetFCR
                  fcrVariancePercent
                  fcrTrend
                }
                growthMetrics {
                  avgWeightG
                  dailyGrowthRate
                  specificGrowthRate
                }
                recommendations
              }
            }
          `,
          variables: {
            tenantId,
            id: batchId,
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.batchPerformance.batchId).toBe(batchId);
      expect(data.batchPerformance.currentMetrics.currentQuantity).toBeLessThan(50000);
    });

    it('Step 8: Should start harvesting phase', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation UpdateBatchStatus($tenantId: ID!, $id: ID!, $status: BatchStatus!, $reason: String) {
              updateBatchStatus(tenantId: $tenantId, id: $id, status: $status, reason: $reason) {
                id
                status
              }
            }
          `,
          variables: {
            tenantId,
            id: batchId,
            status: 'harvesting',
            reason: 'Fish reached market size',
          },
        })
        .expect(200);

      expect(response.body.data.updateBatchStatus.status).toBe('harvesting');
    });

    it('Step 9: Should close batch after harvest', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation CloseBatch($tenantId: ID!, $id: ID!, $reason: String) {
              closeBatch(tenantId: $tenantId, id: $id, reason: $reason) {
                id
                status
                isActive
                closedAt
                closeReason
              }
            }
          `,
          variables: {
            tenantId,
            id: batchId,
            reason: 'Harvest complete - total 48,000 fish harvested',
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.closeBatch.status).toBe('closed');
      expect(data.closeBatch.isActive).toBe(false);
    });

    it('Step 10: Should get final batch history', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            query GetBatchHistory($tenantId: ID!, $id: ID!) {
              batchHistory(tenantId: $tenantId, id: $id) {
                timestamp
                eventType
                description
                performedBy
              }
            }
          `,
          variables: {
            tenantId,
            id: batchId,
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.batchHistory.length).toBeGreaterThanOrEqual(3);

      // Should include: creation, status changes, mortality
      const eventTypes = data.batchHistory.map((h: any) => h.eventType);
      expect(eventTypes).toContain('CREATED');
      expect(eventTypes).toContain('STATUS_CHANGED');
    });
  });

  describe('Multi-Tank Management', () => {
    let multiTankBatchId: string;
    const tank1Id = 'mt-tank-001';
    const tank2Id = 'mt-tank-002';

    it('Should create and split batch across tanks', async () => {
      // Create batch
      const createResponse = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation CreateBatch($tenantId: ID!, $input: CreateBatchInput!) {
              createBatch(tenantId: $tenantId, input: $input) {
                id
                currentQuantity
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              name: 'Multi-Tank Batch',
              speciesId,
              siteId,
              initialQuantity: 20000,
              initialAvgWeightG: 50,
              stockingDate: new Date().toISOString(),
              createdBy: testUser,
            },
          },
        })
        .expect(200);

      multiTankBatchId = createResponse.body.data.createBatch.id;

      // Allocate to first tank (60%)
      await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation AllocateBatchToTank($tenantId: ID!, $input: AllocateToTankInput!) {
              allocateBatchToTank(tenantId: $tenantId, input: $input) {
                id
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId: multiTankBatchId,
              tankId: tank1Id,
              quantity: 12000,
              biomassKg: 600,
              allocationType: 'initial',
              allocationDate: new Date().toISOString(),
              allocatedBy: testUser,
            },
          },
        })
        .expect(200);

      // Allocate to second tank (40%)
      await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation AllocateBatchToTank($tenantId: ID!, $input: AllocateToTankInput!) {
              allocateBatchToTank(tenantId: $tenantId, input: $input) {
                id
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId: multiTankBatchId,
              tankId: tank2Id,
              quantity: 8000,
              biomassKg: 400,
              allocationType: 'initial',
              allocationDate: new Date().toISOString(),
              allocatedBy: testUser,
            },
          },
        })
        .expect(200);
    });

    it('Should transfer fish between tanks', async () => {
      const transferResponse = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation TransferBatch($tenantId: ID!, $input: TransferBatchInput!) {
              transferBatch(tenantId: $tenantId, input: $input) {
                id
                operationType
                quantity
                biomassKg
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              batchId: multiTankBatchId,
              sourceTankId: tank1Id,
              destinationTankId: tank2Id,
              quantity: 2000,
              biomassKg: 100, // 2000 * 50g / 1000
              transferDate: new Date().toISOString(),
              reason: 'Density balancing',
              performedBy: testUser,
            },
          },
        })
        .expect(200);

      const { data, errors } = transferResponse.body;
      expect(errors).toBeUndefined();
      expect(data.transferBatch.operationType).toBe('transfer');
      expect(data.transferBatch.quantity).toBe(2000);
    });
  });

  describe('Feed Inventory Management', () => {
    let inventoryId: string;

    it('Should add feed to inventory', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation AddFeedInventory($tenantId: ID!, $input: AddFeedInventoryInput!) {
              addFeedInventory(tenantId: $tenantId, input: $input) {
                id
                feedId
                quantityKg
                status
                lotNumber
                expiryDate
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              feedId,
              siteId,
              quantityKg: 1000,
              lotNumber: 'LOT-2024-001',
              manufacturingDate: new Date('2024-01-01').toISOString(),
              expiryDate: new Date('2024-07-01').toISOString(),
              receivedDate: new Date().toISOString(),
              unitPricePerKg: 2.5,
              currency: 'TRY',
              storageLocation: 'Warehouse A, Rack 3',
              createdBy: testUser,
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.addFeedInventory.quantityKg).toBe(1000);
      expect(data.addFeedInventory.status).toBe('available');

      inventoryId = data.addFeedInventory.id;
    });

    it('Should consume feed from inventory', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation ConsumeFeedInventory($tenantId: ID!, $input: ConsumeFeedInventoryInput!) {
              consumeFeedInventory(tenantId: $tenantId, input: $input) {
                id
                quantityKg
                status
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              inventoryId,
              quantityKg: 50,
              notes: 'Daily feeding',
              consumedBy: testUser,
            },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.consumeFeedInventory.quantityKg).toBe(950); // 1000 - 50
    });

    it('Should get feed inventory status', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            query GetFeedInventory($tenantId: ID!, $filter: FeedInventoryFilterInput) {
              feedInventory(tenantId: $tenantId, filter: $filter) {
                items {
                  id
                  feedId
                  quantityKg
                  status
                  isLowStock
                  daysUntilExpiry
                }
                total
              }
            }
          `,
          variables: {
            tenantId,
            filter: { siteId },
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.feedInventory.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Growth Analysis', () => {
    it('Should get comprehensive growth analysis', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            query GetGrowthAnalysis($tenantId: ID!, $batchId: ID!) {
              growthAnalysis(tenantId: $tenantId, batchId: $batchId) {
                batchId
                batchCode
                analysisDate
                daysInProduction
                currentMetrics {
                  currentAvgWeightG
                  currentBiomassKg
                  survivalRate
                  mortalityRate
                  currentFCR
                  dailyGrowthRateG
                  specificGrowthRate
                }
                trend {
                  direction
                  avgDailyGrowthLast7Days
                  fcrTrend
                }
                projection {
                  projectedWeightIn30Days
                  estimatedHarvestDate
                  daysToHarvest
                }
                recommendations {
                  priority
                  type
                  description
                  reason
                }
              }
            }
          `,
          variables: {
            tenantId,
            batchId,
          },
        })
        .expect(200);

      const { data, errors } = response.body;
      expect(errors).toBeUndefined();
      expect(data.growthAnalysis.batchId).toBe(batchId);
      expect(data.growthAnalysis.currentMetrics).toBeDefined();
      expect(data.growthAnalysis.recommendations).toBeInstanceOf(Array);
    });
  });
});
