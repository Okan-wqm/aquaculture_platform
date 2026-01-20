/**
 * Batch E2E Tests
 *
 * Batch GraphQL API'nin uçtan uca testleri.
 *
 * @module Farm-Service/E2E
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Batch GraphQL API (e2e)', () => {
  let app: INestApplication;
  let httpServer: any;

  const tenantId = 'test-tenant-e2e';
  let createdBatchId: string;
  let speciesId: string;
  let siteId: string;
  let tankId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    httpServer = app.getHttpServer();

    // Setup test data
    // Note: In real tests, these would be created via API or seeded
    speciesId = 'test-species-001';
    siteId = 'test-site-001';
    tankId = 'test-tank-001';
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Batch Mutations', () => {
    describe('createBatch', () => {
      it('should create a new batch', async () => {
        const createBatchMutation = `
          mutation CreateBatch($tenantId: ID!, $input: CreateBatchInput!) {
            createBatch(tenantId: $tenantId, input: $input) {
              id
              batchCode
              name
              status
              currentQuantity
              initialBiomassKg
              createdAt
            }
          }
        `;

        const variables = {
          tenantId,
          input: {
            name: 'E2E Test Batch',
            speciesId,
            siteId,
            initialQuantity: 10000,
            initialAvgWeightG: 5,
            stockingDate: new Date().toISOString(),
            sourceType: 'hatchery',
            createdBy: 'e2e-test-user',
          },
        };

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: createBatchMutation,
            variables,
          })
          .expect(200);

        const { data, errors } = response.body;

        if (errors) {
          console.log('GraphQL Errors:', JSON.stringify(errors, null, 2));
        }

        expect(errors).toBeUndefined();
        expect(data.createBatch).toBeDefined();
        expect(data.createBatch.name).toBe('E2E Test Batch');
        expect(data.createBatch.status).toBe('stocked');
        expect(data.createBatch.currentQuantity).toBe(10000);
        expect(data.createBatch.initialBiomassKg).toBe(50); // 10000 * 5 / 1000

        createdBatchId = data.createBatch.id;
      });

      it('should validate required fields', async () => {
        const createBatchMutation = `
          mutation CreateBatch($tenantId: ID!, $input: CreateBatchInput!) {
            createBatch(tenantId: $tenantId, input: $input) {
              id
            }
          }
        `;

        const variables = {
          tenantId,
          input: {
            name: 'Invalid Batch',
            // Missing required fields
          },
        };

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: createBatchMutation,
            variables,
          });

        expect(response.body.errors).toBeDefined();
      });
    });

    describe('updateBatchStatus', () => {
      it('should update batch status from STOCKED to ACTIVE', async () => {
        const updateStatusMutation = `
          mutation UpdateBatchStatus($tenantId: ID!, $id: ID!, $status: BatchStatus!, $reason: String) {
            updateBatchStatus(tenantId: $tenantId, id: $id, status: $status, reason: $reason) {
              id
              status
            }
          }
        `;

        const variables = {
          tenantId,
          id: createdBatchId,
          status: 'active',
          reason: 'Starting production',
        };

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: updateStatusMutation,
            variables,
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.updateBatchStatus.status).toBe('active');
      });
    });

    describe('recordMortality', () => {
      it('should record mortality for batch', async () => {
        const recordMortalityMutation = `
          mutation RecordMortality($tenantId: ID!, $input: RecordMortalityInput!) {
            recordMortality(tenantId: $tenantId, input: $input) {
              id
              quantity
              cause
              mortalityDate
            }
          }
        `;

        const variables = {
          tenantId,
          input: {
            batchId: createdBatchId,
            quantity: 50,
            cause: 'disease',
            mortalityDate: new Date().toISOString(),
            notes: 'E2E test mortality',
            recordedBy: 'e2e-test-user',
          },
        };

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: recordMortalityMutation,
            variables,
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.recordMortality).toBeDefined();
        expect(data.recordMortality.quantity).toBe(50);
        expect(data.recordMortality.cause).toBe('disease');
      });
    });

    describe('allocateBatchToTank', () => {
      it('should allocate batch to tank', async () => {
        const allocateMutation = `
          mutation AllocateBatchToTank($tenantId: ID!, $input: AllocateToTankInput!) {
            allocateBatchToTank(tenantId: $tenantId, input: $input) {
              id
              tankId
              batchId
              quantity
              biomassKg
              allocationType
            }
          }
        `;

        const variables = {
          tenantId,
          input: {
            batchId: createdBatchId,
            tankId,
            quantity: 5000,
            biomassKg: 25, // 5000 * 5 / 1000
            allocationType: 'initial',
            allocationDate: new Date().toISOString(),
            allocatedBy: 'e2e-test-user',
          },
        };

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: allocateMutation,
            variables,
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.allocateBatchToTank).toBeDefined();
        expect(data.allocateBatchToTank.quantity).toBe(5000);
        expect(data.allocateBatchToTank.allocationType).toBe('initial');
      });
    });

    describe('closeBatch', () => {
      it('should close batch successfully', async () => {
        // First set status to harvesting
        await request(httpServer)
          .post('/graphql')
          .send({
            query: `
              mutation UpdateBatchStatus($tenantId: ID!, $id: ID!, $status: BatchStatus!) {
                updateBatchStatus(tenantId: $tenantId, id: $id, status: $status) {
                  id
                  status
                }
              }
            `,
            variables: {
              tenantId,
              id: createdBatchId,
              status: 'harvesting',
            },
          });

        const closeBatchMutation = `
          mutation CloseBatch($tenantId: ID!, $id: ID!, $reason: String) {
            closeBatch(tenantId: $tenantId, id: $id, reason: $reason) {
              id
              status
              isActive
              closedAt
              closeReason
            }
          }
        `;

        const variables = {
          tenantId,
          id: createdBatchId,
          reason: 'E2E Test - Harvest Complete',
        };

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: closeBatchMutation,
            variables,
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.closeBatch.status).toBe('closed');
        expect(data.closeBatch.isActive).toBe(false);
        expect(data.closeBatch.closedAt).toBeDefined();
        expect(data.closeBatch.closeReason).toBe('E2E Test - Harvest Complete');
      });
    });
  });

  describe('Batch Queries', () => {
    let testBatchId: string;

    beforeAll(async () => {
      // Create a test batch for queries
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation CreateBatch($tenantId: ID!, $input: CreateBatchInput!) {
              createBatch(tenantId: $tenantId, input: $input) {
                id
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              name: 'Query Test Batch',
              speciesId,
              siteId,
              initialQuantity: 5000,
              initialAvgWeightG: 10,
              stockingDate: new Date().toISOString(),
              createdBy: 'e2e-test-user',
            },
          },
        });

      testBatchId = response.body.data?.createBatch?.id;
    });

    describe('batch', () => {
      it('should fetch batch by ID', async () => {
        const batchQuery = `
          query GetBatch($tenantId: ID!, $id: ID!) {
            batch(tenantId: $tenantId, id: $id) {
              id
              batchCode
              name
              status
              currentQuantity
              currentBiomassKg
              initialBiomassKg
              mortalityRate
              survivalRate
              daysInProduction
            }
          }
        `;

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: batchQuery,
            variables: { tenantId, id: testBatchId },
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.batch).toBeDefined();
        expect(data.batch.id).toBe(testBatchId);
        expect(data.batch.name).toBe('Query Test Batch');
        expect(data.batch.currentQuantity).toBe(5000);
      });

      it('should return null for non-existent batch', async () => {
        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: `
              query GetBatch($tenantId: ID!, $id: ID!) {
                batch(tenantId: $tenantId, id: $id) {
                  id
                }
              }
            `,
            variables: { tenantId, id: 'non-existent-id' },
          })
          .expect(200);

        expect(response.body.data.batch).toBeNull();
      });
    });

    describe('batches', () => {
      it('should list batches with pagination', async () => {
        const batchesQuery = `
          query ListBatches($tenantId: ID!, $pagination: PaginationInput) {
            batches(tenantId: $tenantId, pagination: $pagination) {
              items {
                id
                batchCode
                name
                status
              }
              total
              hasMore
            }
          }
        `;

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: batchesQuery,
            variables: {
              tenantId,
              pagination: { offset: 0, limit: 10 },
            },
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.batches).toBeDefined();
        expect(data.batches.items).toBeInstanceOf(Array);
        expect(data.batches.total).toBeGreaterThanOrEqual(0);
      });

      it('should filter batches by status', async () => {
        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: `
              query ListBatches($tenantId: ID!, $filter: BatchFilterInput) {
                batches(tenantId: $tenantId, filter: $filter) {
                  items {
                    id
                    status
                  }
                  total
                }
              }
            `,
            variables: {
              tenantId,
              filter: { status: 'stocked' },
            },
          })
          .expect(200);

        const { data } = response.body;

        expect(data.batches.items.every((b: any) => b.status === 'stocked')).toBe(true);
      });

      it('should filter batches by site', async () => {
        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: `
              query ListBatches($tenantId: ID!, $filter: BatchFilterInput) {
                batches(tenantId: $tenantId, filter: $filter) {
                  items {
                    id
                    name
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

        expect(response.body.data.batches).toBeDefined();
      });
    });

    describe('batchPerformance', () => {
      it('should return batch performance metrics', async () => {
        const performanceQuery = `
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
              }
              growthMetrics {
                avgWeightG
                dailyGrowthRate
              }
            }
          }
        `;

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: performanceQuery,
            variables: { tenantId, id: testBatchId },
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.batchPerformance).toBeDefined();
        expect(data.batchPerformance.batchId).toBe(testBatchId);
        expect(data.batchPerformance.currentMetrics).toBeDefined();
      });
    });

    describe('batchHistory', () => {
      it('should return batch history entries', async () => {
        const historyQuery = `
          query GetBatchHistory($tenantId: ID!, $id: ID!) {
            batchHistory(tenantId: $tenantId, id: $id) {
              timestamp
              eventType
              description
              previousValue
              newValue
              performedBy
            }
          }
        `;

        const response = await request(httpServer)
          .post('/graphql')
          .send({
            query: historyQuery,
            variables: { tenantId, id: testBatchId },
          })
          .expect(200);

        const { data, errors } = response.body;

        expect(errors).toBeUndefined();
        expect(data.batchHistory).toBeInstanceOf(Array);
      });
    });
  });

  describe('Field Resolvers', () => {
    it('should resolve computed fields', async () => {
      const query = `
        query GetBatch($tenantId: ID!, $id: ID!) {
          batch(tenantId: $tenantId, id: $id) {
            id
            currentBiomassKg
            currentAvgWeightG
            mortalityRate
            survivalRate
            daysInProduction
          }
        }
      `;

      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query,
          variables: { tenantId, id: createdBatchId },
        })
        .expect(200);

      const { data } = response.body;

      expect(data.batch).toBeDefined();
      // These should be computed by field resolvers
      expect(typeof data.batch.mortalityRate).toBe('number');
      expect(typeof data.batch.survivalRate).toBe('number');
      expect(typeof data.batch.daysInProduction).toBe('number');
    });
  });

  describe('Error Handling', () => {
    it('should handle unauthorized tenant access', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            query GetBatch($tenantId: ID!, $id: ID!) {
              batch(tenantId: $tenantId, id: $id) {
                id
              }
            }
          `,
          variables: {
            tenantId: 'unauthorized-tenant',
            id: createdBatchId,
          },
        })
        .expect(200);

      // Batch should not be found because of tenant isolation
      expect(response.body.data.batch).toBeNull();
    });

    it('should return validation errors for invalid input', async () => {
      const response = await request(httpServer)
        .post('/graphql')
        .send({
          query: `
            mutation CreateBatch($tenantId: ID!, $input: CreateBatchInput!) {
              createBatch(tenantId: $tenantId, input: $input) {
                id
              }
            }
          `,
          variables: {
            tenantId,
            input: {
              name: 'Invalid Batch',
              speciesId,
              siteId,
              initialQuantity: -100, // Invalid: negative quantity
              initialAvgWeightG: 10,
              stockingDate: new Date().toISOString(),
              createdBy: 'e2e-test-user',
            },
          },
        });

      expect(response.body.errors).toBeDefined();
    });
  });
});
