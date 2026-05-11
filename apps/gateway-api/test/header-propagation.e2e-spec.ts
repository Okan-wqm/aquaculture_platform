import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';


// Mock ConfigService to avoid env vars dependency.
// `defaultValue` is `unknown` because ConfigService.get's overload returns
// either the typed value or whatever default the caller passes — we don't
// inspect it here, we just echo it.
const mockConfigService = {
  get: jest.fn((key: string, defaultValue: unknown): unknown => {
    if (key === 'JWT_SECRET') return 'test-secret-at-least-32-chars-long-for-safety';
    if (key === 'NODE_ENV') return 'test';
    if (key === 'ALLOW_DEV_JWT_SECRET') return 'true';
    if (key === 'DEV_JWT_SECRET') return 'test-secret-at-least-32-chars-long-for-safety';
    return defaultValue;
  }),
};

describe('Gateway Header Propagation (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue(mockConfigService)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Health endpoint', () => {
    it('should return 200 for health check', async () => {
      return request(app.getHttpServer() as App)
        .get('/health')
        .expect(200);
    });
  });

  describe('Correlation ID handling', () => {
    it('should generate correlation-id if not provided', async () => {
      const response = await request(app.getHttpServer() as App)
        .get('/health')
        .expect(200);

      expect(response.headers['x-correlation-id']).toBeDefined();
    });

    it('should preserve correlation-id if provided', async () => {
      const correlationId = 'test-correlation-id-12345';

      const response = await request(app.getHttpServer() as App)
        .get('/health')
        .set('x-correlation-id', correlationId)
        .expect(200);

      expect(response.headers['x-correlation-id']).toBe(correlationId);
    });
  });

  describe('Trace context handling', () => {
    it('should generate trace-id if not provided', async () => {
      const response = await request(app.getHttpServer() as App)
        .get('/health')
        .expect(200);

      expect(response.headers['x-trace-id']).toBeDefined();
      expect(response.headers['x-span-id']).toBeDefined();
    });

    it('should propagate W3C traceparent header', async () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

      const response = await request(app.getHttpServer() as App)
        .get('/health')
        .set('traceparent', traceparent)
        .expect(200);

      // Should have trace context in response
      expect(response.headers['traceparent']).toBeDefined();
      // Trace ID should be preserved from parent
      expect(response.headers['x-trace-id']).toBe('0af7651916cd43dd8448eb211c80319c');
    });
  });

  // TODO: Add subgraph header propagation tests using nock
  // These require mocking the downstream subgraph services to verify
  // that headers are correctly forwarded in federated GraphQL requests
  describe.skip('Subgraph header propagation', () => {
    it('should propagate x-tenant-id to subgraphs', async () => {
      // Requires nock or similar to mock subgraph endpoints
    });

    it('should propagate x-user-payload to subgraphs', async () => {
      // Requires nock or similar to mock subgraph endpoints
    });

    it('should propagate correlation-id to subgraphs', async () => {
      // Requires nock or similar to mock subgraph endpoints
    });
  });
});
