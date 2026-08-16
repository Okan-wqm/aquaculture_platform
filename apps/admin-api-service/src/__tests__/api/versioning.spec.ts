import {
  INestApplication,
  Controller,
  Get,
  HttpStatus,
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
  Version,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { Public } from '@aquaculture/backend-common/decorators';

/**
 * Test controller that exposes versioned and unversioned routes.
 * Uses @Public() to bypass auth — we're testing the versioning layer, not guards.
 */
@Controller('test-versioning')
class TestVersioningController {
  @Get('ping')
  @Public()
  ping() {
    return { version: 'default', message: 'pong' };
  }

  @Get('v2-only')
  @Public()
  @Version('2')
  v2Only() {
    return { version: '2', message: 'v2 only' };
  }
}

describe('API Versioning', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [TestVersioningController],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror the exact versioning config from main.ts
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: ['1', VERSION_NEUTRAL],
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('URI-based versioning configuration', () => {
    it('should respond at unversioned path (VERSION_NEUTRAL backward compat)', async () => {
      const response = await request(app.getHttpServer()).get('/test-versioning/ping');

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ version: 'default', message: 'pong' });
    });

    it('should respond at /v1/ prefixed path', async () => {
      const response = await request(app.getHttpServer()).get('/v1/test-versioning/ping');

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ version: 'default', message: 'pong' });
    });

    it('should return 404 for unknown version prefix', async () => {
      const response = await request(app.getHttpServer()).get('/v99/test-versioning/ping');

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('should serve @Version("2") endpoint at /v2/ prefix only', async () => {
      const response = await request(app.getHttpServer()).get('/v2/test-versioning/v2-only');

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ version: '2', message: 'v2 only' });
    });

    it('should NOT serve @Version("2") endpoint at /v1/ prefix', async () => {
      const response = await request(app.getHttpServer()).get('/v1/test-versioning/v2-only');

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('should NOT serve @Version("2") endpoint at unversioned path', async () => {
      const response = await request(app.getHttpServer()).get('/test-versioning/v2-only');

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('Backward compatibility', () => {
    it('both /v1/ and unversioned paths return identical response bodies', async () => {
      const [unversioned, versioned] = await Promise.all([
        request(app.getHttpServer()).get('/test-versioning/ping'),
        request(app.getHttpServer()).get('/v1/test-versioning/ping'),
      ]);

      expect(unversioned.status).toBe(HttpStatus.OK);
      expect(versioned.status).toBe(HttpStatus.OK);
      expect(unversioned.body).toEqual(versioned.body);
    });
  });
});
