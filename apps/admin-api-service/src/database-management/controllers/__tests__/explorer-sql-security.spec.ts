/**
 * Explorer SQL Security Tests
 *
 * Unit tests for the SQL validation logic in DatabaseExplorerController.executeQuery().
 * Tests the security controls added in Sprint 1 fixes:
 *   C1  - Multi-statement (semicolon) blocking
 *   C2  - SET statement blocking
 *   C3  - DO $$ / PERFORM / COPY blocking
 *   C11 - pg_catalog / information_schema schema blocking
 *   H25 - pg_sleep / set_config / current_setting function blocking
 *
 * These are integration-level tests using NestJS TestingModule with mocked DataSource.
 * No real database connection is required.
 */

import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';

import { AuditLogService } from '../../../audit/audit.service';
import { PlatformAdminGuard } from '../../../guards/platform-admin.guard';
import { DatabaseExplorerController } from '../explorer.controller';

describe('Explorer SQL Security', () => {
  let app: INestApplication;

  const mockQueryRunner = {
    connect: jest.fn(),
    release: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  const mockAuditLogService = {
    log: jest.fn().mockResolvedValue({ id: 'audit-log-id' }),
  };

  const mockGuard = { canActivate: jest.fn().mockReturnValue(true) };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DatabaseExplorerController],
      providers: [
        { provide: getDataSourceToken('explorer-readonly'), useValue: mockDataSource },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    })
      .overrideGuard(PlatformAdminGuard)
      .useValue(mockGuard)
      .compile();

    app = module.createNestApplication();
    // Production attaches the verified operator before the controller runs, and
    // every audited read here records who performed it. Injecting it at the
    // edge — rather than through the guard double — keeps the spec honest no
    // matter which guard the controller resolves.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = {
        id: 'super-admin-1',
        sub: 'super-admin-1',
        email: 'ops@example.com',
        name: 'Ops Admin',
        roles: ['SUPER_ADMIN'],
      };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRunner.query.mockResolvedValue([]);
    mockAuditLogService.log.mockResolvedValue({ id: 'audit-log-id' });
    process.env['NODE_ENV'] = 'development';
    process.env['ENABLE_RAW_SQL_EXPLORER'] = 'true';
  });

  afterEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['ENABLE_RAW_SQL_EXPLORER'];
  });

  /**
   * Helper: POST a raw SQL query and return the supertest response
   */
  function postQuery(sql: string, params?: unknown[]) {
    const body: Record<string, unknown> = { sql };
    if (params) body['params'] = params;
    return request(app.getHttpServer()).post('/database/explorer/query').send(body);
  }

  // ==========================================================================
  // C1 - Semicolon / multi-statement blocking
  // ==========================================================================
  describe('Semicolon kontrolu (C1)', () => {
    it('should reject multi-statement queries', async () => {
      const res = await postQuery('SELECT 1; DROP TABLE users');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Multi-statement');
    });

    it('should reject semicolon even at end of query', async () => {
      const res = await postQuery('SELECT 1;');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Multi-statement');
    });

    it('should reject semicolon hidden inside comments', async () => {
      // Comment is stripped first, then semicolon check runs
      const res = await postQuery('SELECT 1 /* comment */; DROP TABLE x');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should allow single SELECT without semicolon', async () => {
      mockQueryRunner.query.mockResolvedValue([{ result: 1 }]);

      const res = await postQuery('SELECT 1');

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.rows).toBeDefined();
    });
  });

  // ==========================================================================
  // C2, C3 - Dangerous statements blocking
  // ==========================================================================
  describe('Dangerous statements (C2, C3)', () => {
    it('should reject SET statements', async () => {
      const res = await postQuery("SELECT * FROM (SET role = 'superuser') AS x");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject DO $$ blocks', async () => {
      const res = await postQuery("SELECT 1 WHERE EXISTS (DO $$ BEGIN RAISE NOTICE 'x' END $$)");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject PERFORM', async () => {
      const res = await postQuery('SELECT PERFORM pg_advisory_lock(1)');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject COPY', async () => {
      const res = await postQuery("SELECT * FROM COPY users TO '/tmp/data.csv'");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject RESET', async () => {
      const res = await postQuery('SELECT 1 FROM (RESET ALL) AS x');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject SHOW', async () => {
      const res = await postQuery('SELECT 1 FROM (SHOW server_version) AS x');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject DROP wrapped in SELECT', async () => {
      const res = await postQuery('SELECT * FROM (DROP TABLE users) AS x');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });

    it('should reject DELETE wrapped in SELECT', async () => {
      const res = await postQuery('SELECT * FROM (DELETE FROM users WHERE 1=1) AS x');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed');
    });
  });

  // ==========================================================================
  // H25 - Dangerous function blocking
  // ==========================================================================
  describe('Dangerous functions (H25)', () => {
    it('should reject pg_sleep', async () => {
      const res = await postQuery('SELECT pg_sleep(10)');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });

    it('should reject set_config', async () => {
      const res = await postQuery("SELECT set_config('role', 'superuser', false)");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });

    it('should reject current_setting', async () => {
      const res = await postQuery("SELECT current_setting('server_version')");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });

    it('should reject pg_read_file', async () => {
      const res = await postQuery("SELECT pg_read_file('/etc/passwd')");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });

    it('should reject pg_terminate_backend', async () => {
      const res = await postQuery('SELECT pg_terminate_backend(12345)');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });

    it('should reject dblink', async () => {
      const res = await postQuery("SELECT * FROM dblink('host=evil.com', 'SELECT 1')");

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });
  });

  // ==========================================================================
  // C11 - Blocked schema access
  // ==========================================================================
  describe('Blocked schemas (C11)', () => {
    it('should reject pg_catalog access', async () => {
      const res = await postQuery('SELECT * FROM pg_catalog.pg_roles');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('restricted schemas');
    });

    it('should reject information_schema access', async () => {
      const res = await postQuery('SELECT * FROM information_schema.tables');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('restricted schemas');
    });

    it('should reject tenant schema access', async () => {
      const res = await postQuery('SELECT * FROM tenant_abc123.users');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('restricted tenant schemas');
    });

    it('should reject module schema access (sensor)', async () => {
      const res = await postQuery('SELECT * FROM sensor.readings');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('restricted schemas');
    });

    it('should reject module schema access (farm)', async () => {
      // Phase 4.3 pre-work: the test originally targeted
      // `farm.ponds`, a legacy table superseded by `farm.tanks` in
      // the farm-service v2 taxonomy. `farm.ponds` is kept as a
      // read-only view today but the taxonomy-cleanup phase (4.3)
      // will migrate it away — updating the test to reference the
      // post-migration target (`farm.sites`) decouples this test's
      // green state from whichever legacy table is or isn't present
      // on the active schema.
      const res = await postQuery('SELECT * FROM farm.sites');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('restricted schemas');
    });

    it('should reject module table names through allowed schemas', async () => {
      const res = await postQuery('SELECT * FROM public.sensors');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('restricted module tables');
    });

    it('should allow public schema access', async () => {
      mockQueryRunner.query.mockResolvedValue([{ id: 1 }]);

      const res = await postQuery('SELECT * FROM public.tenants');

      expect(res.status).toBe(HttpStatus.CREATED);
    });
  });

  // ==========================================================================
  // Feature flag / environment controls
  // ==========================================================================
  describe('Feature flag controls', () => {
    it('should reject raw queries when ENABLE_RAW_SQL_EXPLORER is not set', async () => {
      delete process.env['ENABLE_RAW_SQL_EXPLORER'];

      const res = await postQuery('SELECT 1');

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.message).toContain('disabled');
    });

    it('should reject raw queries in production even with flag enabled', async () => {
      process.env['NODE_ENV'] = 'production';
      process.env['ENABLE_RAW_SQL_EXPLORER'] = 'true';

      const res = await postQuery('SELECT 1');

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.message).toContain('production');
    });
  });

  // ==========================================================================
  // Comment stripping bypass attempts
  // ==========================================================================
  describe('Comment stripping bypass', () => {
    it('should strip block comments hiding DROP', async () => {
      const res = await postQuery('SELECT /* safe */ 1 /* */ DROP TABLE users');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should strip line comments hiding dangerous SQL', async () => {
      const res = await postQuery('SELECT 1 -- safe query\nDROP TABLE users');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject pg_sleep hidden in case variation', async () => {
      const res = await postQuery('SELECT PG_SLEEP(5)');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('disallowed functions');
    });
  });
});
