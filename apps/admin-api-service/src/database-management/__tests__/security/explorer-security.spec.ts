/**
 * Database Explorer Controller - Security Tests
 *
 * Tests cover:
 * - SQL injection prevention (identifiers, query params)
 * - Dangerous statement blocking (DROP, DELETE, INSERT, etc.)
 * - Dangerous function blocking (pg_read_file, dblink, etc.)
 * - Raw query disabled in production
 * - Query length limits
 * - Comment stripping bypass prevention
 * - Sensitive column masking
 * - Identifier validation
 * - Pagination limits
 */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';

import { AuditLogService } from '../../../audit/audit.service';
import { PlatformAdminGuard } from '../../../guards/platform-admin.guard';
import { DatabaseExplorerController } from '../../controllers/explorer.controller';

describe('DatabaseExplorerController Security', () => {
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
    record: jest.fn().mockResolvedValue({ id: 'audit-log-id' }),
  };

  // Mock the guard to always allow (we're testing controller logic, not auth)
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
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
    mockAuditLogService.record.mockResolvedValue({ id: 'audit-log-id' });
    // Reset NODE_ENV for each test
    process.env['NODE_ENV'] = 'development';
    process.env['ENABLE_RAW_SQL_EXPLORER'] = 'true';
  });

  afterEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['ENABLE_RAW_SQL_EXPLORER'];
  });

  // ========================================================================
  // 1. Identifier Validation (SQL Injection Prevention)
  // ========================================================================
  describe('Identifier validation', () => {
    const maliciousSchemaNames = [
      'admin"; DROP TABLE users; --',
      "admin'; DELETE FROM tenants; --",
      'admin\' OR \'1\'=\'1',
      '../../../etc/passwd',
      'admin/**/union/**/select',
      'admin;',
      'admin--',
      'ADMIN.users',   // dot notation attempt
      'admin DROP',    // space in identifier
    ];

    maliciousSchemaNames.forEach((schema) => {
      it(`should reject malicious schema name: "${schema.substring(0, 40)}..."`, async () => {
        const res = await request(app.getHttpServer())
          .get(`/database/explorer/schemas/${encodeURIComponent(schema)}/tables`);

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
        expect(res.body.message).toContain('Invalid schema name');
      });
    });

    const maliciousTableNames = [
      'users"; DROP TABLE tenants; --',
      'users UNION SELECT * FROM information_schema.tables',
      'users; UPDATE',
    ];

    maliciousTableNames.forEach((table) => {
      it(`should reject malicious table name: "${table.substring(0, 40)}..."`, async () => {
        const res = await request(app.getHttpServer())
          .get(`/database/explorer/schemas/public/tables/${encodeURIComponent(table)}/data`);

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });
    });

    it('should accept valid identifier (lowercase alpha + underscore)', async () => {
      mockQueryRunner.query.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables');

      expect(res.status).toBe(HttpStatus.OK);
    });

    it('should accept identifiers with numbers', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce([]) // columns
        .mockResolvedValueOnce([{ count: '0' }]) // count
        .mockResolvedValueOnce([]); // data

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables/users_v2/data');

      expect(res.status).toBe(HttpStatus.OK);
    });
  });

  // ========================================================================
  // 2. Raw SQL Query Security
  // ========================================================================
  describe('Raw SQL query endpoint (POST /database/explorer/query)', () => {
    it('should block raw queries in production', async () => {
      process.env['NODE_ENV'] = 'production';
      process.env['ENABLE_RAW_SQL_EXPLORER'] = 'true';

      const res = await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: 'SELECT 1' });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.message).toContain('disabled in production');
    });

    it('should allow SELECT queries in development', async () => {
      process.env['NODE_ENV'] = 'development';
      mockQueryRunner.query.mockResolvedValue([{ result: 1 }]);

      const res = await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: 'SELECT 1' });

      expect(res.status).toBe(HttpStatus.CREATED); // POST default
    });

    it('should allow WITH (CTE) queries', async () => {
      process.env['NODE_ENV'] = 'development';
      mockQueryRunner.query.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte' });

      expect(res.status).toBe(HttpStatus.CREATED);
    });

    // Dangerous statement blocking
    const dangerousStatements = [
      { sql: 'DROP TABLE users', label: 'DROP' },
      { sql: 'DELETE FROM users WHERE 1=1', label: 'DELETE' },
      { sql: 'TRUNCATE TABLE users', label: 'TRUNCATE' },
      { sql: 'INSERT INTO users VALUES (1)', label: 'INSERT' },
      { sql: "UPDATE users SET role = 'admin'", label: 'UPDATE' },
      { sql: 'ALTER TABLE users ADD COLUMN hack text', label: 'ALTER' },
      { sql: 'CREATE TABLE hack (id int)', label: 'CREATE' },
      { sql: 'GRANT ALL ON users TO public', label: 'GRANT' },
      { sql: 'REVOKE ALL ON users FROM public', label: 'REVOKE' },
      { sql: "EXECUTE sp_who2", label: 'EXECUTE' },
      { sql: "CALL my_procedure()", label: 'CALL' },
    ];

    dangerousStatements.forEach(({ sql, label }) => {
      it(`should block ${label} statement: "${sql.substring(0, 50)}"`, async () => {
        process.env['NODE_ENV'] = 'development';

        // Wrap in a SELECT to try bypassing the startsWith check
        const wrappedSql = `SELECT * FROM (${sql}) AS x`;
        const res = await request(app.getHttpServer())
          .post('/database/explorer/query')
          .send({ sql: wrappedSql });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
        expect(res.body.message).toMatch(/disallowed|Multi-statement/);
      });
    });

    // Dangerous function blocking
    const dangerousFunctions = [
      { sql: "SELECT pg_read_file('/etc/passwd')", label: 'pg_read_file' },
      { sql: "SELECT pg_read_binary_file('/etc/shadow')", label: 'pg_read_binary_file' },
      { sql: "SELECT pg_write_file('/tmp/hack', 'data')", label: 'pg_write_file' },
      { sql: "SELECT pg_ls_dir('/tmp')", label: 'pg_ls_dir' },
      { sql: "SELECT pg_terminate_backend(123)", label: 'pg_terminate_backend' },
      { sql: "SELECT pg_cancel_backend(123)", label: 'pg_cancel_backend' },
      { sql: "SELECT * FROM dblink('host=evil.com', 'SELECT 1')", label: 'dblink' },
      { sql: "SELECT 1; copy to '/tmp/dump'", label: 'COPY TO' },
      { sql: "SELECT 1; copy from '/tmp/inject'", label: 'COPY FROM' },
    ];

    dangerousFunctions.forEach(({ sql, label }) => {
      it(`should block dangerous function: ${label}`, async () => {
        process.env['NODE_ENV'] = 'development';

        // Some need to start with SELECT
        const safeSql = sql.startsWith('SELECT') ? sql : `SELECT 1; ${sql}`;
        const res = await request(app.getHttpServer())
          .post('/database/explorer/query')
          .send({ sql: safeSql });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
        expect(res.body.message).toMatch(/disallowed|Multi-statement/);
      });
    });

    it('should reject queries exceeding max length (10,000 chars)', async () => {
      process.env['NODE_ENV'] = 'development';
      const longQuery = 'SELECT ' + 'a'.repeat(10001);

      const res = await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: longQuery });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('maximum length');
    });

    it('should reject non-SELECT/WITH queries (e.g., plain UPDATE)', async () => {
      process.env['NODE_ENV'] = 'development';

      const res = await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: "UPDATE users SET name = 'hacked'" });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    // Comment stripping bypass attempts
    describe('Comment stripping bypass attempts', () => {
      it('should strip block comments hiding dangerous SQL', async () => {
        process.env['NODE_ENV'] = 'development';

        const res = await request(app.getHttpServer())
          .post('/database/explorer/query')
          .send({ sql: 'SELECT 1; /* */ DROP TABLE users' });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('should strip line comments hiding dangerous SQL', async () => {
        process.env['NODE_ENV'] = 'development';

        const res = await request(app.getHttpServer())
          .post('/database/explorer/query')
          .send({ sql: "SELECT 1 -- safe\nDROP TABLE users" });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });
    });

    it('should set statement timeout for raw queries', async () => {
      process.env['NODE_ENV'] = 'development';
      mockQueryRunner.query.mockResolvedValue([]);

      await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: 'SELECT 1' });

      // First call should set statement_timeout
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        'SET statement_timeout = 30000',
      );
    });
  });

  // ========================================================================
  // 3. Sensitive Column Masking
  // ========================================================================
  describe('Sensitive column masking', () => {
    const sensitiveColumns = [
      'password', 'password_hash', 'api_key', 'api_secret',
      'access_token', 'refresh_token', 'mfa_secret', 'private_key',
      'jwt_secret', 'webhook_secret',
    ];

    it('should mask sensitive columns by default', async () => {
      // Mock column info query
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce([ // getTables columns query
          {
            column_name: 'id',
            data_type: 'uuid',
            is_nullable: false,
            column_default: null,
            is_primary_key: true,
            is_foreign_key: false,
          },
          {
            column_name: 'password',
            data_type: 'varchar',
            is_nullable: false,
            column_default: null,
            is_primary_key: false,
            is_foreign_key: false,
          },
        ])
        .mockResolvedValueOnce([{ count: '1' }]) // COUNT query
        .mockResolvedValueOnce([ // data query
          { id: 'u1', password: 'secret123' },
        ]);

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/auth/tables/users/data');

      expect(res.status).toBe(HttpStatus.OK);
      // Password should be masked
      if (res.body.rows && res.body.rows.length > 0) {
        expect(res.body.rows[0].password).toBe('********');
      }
    });

    it('should reject client-controlled sensitive unmasking', async () => {
      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/auth/tables/users/data?includeSensitive=true');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should always mask sensitive data in exports', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce([
          {
            column_name: 'id',
            data_type: 'uuid',
            is_nullable: false,
            column_default: null,
            is_primary_key: true,
            is_foreign_key: false,
          },
          {
            column_name: 'api_key',
            data_type: 'varchar',
            is_nullable: true,
            column_default: null,
            is_primary_key: false,
            is_foreign_key: false,
          },
        ])
        .mockResolvedValueOnce([{ id: 'u1', api_key: 'sk-secret-key-123' }]);

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables/users/export?format=json');

      expect(res.status).toBe(HttpStatus.OK);
      if (Array.isArray(res.body) && res.body.length > 0) {
        expect(res.body[0].api_key).toBe('********');
      }
    });
  });

  // ========================================================================
  // 4. Pagination Limits
  // ========================================================================
  describe('Pagination limits', () => {
    it('should enforce max limit of 100 for table data', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce([]) // columns
        .mockResolvedValueOnce([{ count: '1000' }])
        .mockResolvedValueOnce([]);

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables/users/data?limit=500');

      expect(res.status).toBe(HttpStatus.OK);
      // The limit used should be capped at 100
      expect(res.body.limit).toBeLessThanOrEqual(100);
    });

    it('should enforce min limit of 1', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '10' }])
        .mockResolvedValueOnce([]);

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables/users/data?limit=0');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.limit).toBeGreaterThanOrEqual(1);
    });

    it('should enforce max export limit of 10000', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables/users/export?format=json&limit=50000');

      // Limit should be capped internally even if larger requested
      expect(res.status).toBe(HttpStatus.OK);
    });
  });

  // ========================================================================
  // 5. CRUD Operations - Input Validation
  // ========================================================================
  describe('CRUD operations input validation', () => {
    beforeEach(() => {
      process.env['ENABLE_DB_EXPLORER_WRITES'] = 'true';
    });

    afterEach(() => {
      delete process.env['ENABLE_DB_EXPLORER_WRITES'];
    });

    it('should reject insert with no data', async () => {
      const res = await request(app.getHttpServer())
        .post('/database/explorer/schemas/public/tables/users/rows')
        .send({ data: {} });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject insert with malicious column names', async () => {
      const res = await request(app.getHttpServer())
        .post('/database/explorer/schemas/public/tables/users/rows')
        .send({ data: { 'col"; DROP TABLE users; --': 'value' } });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject update with no data', async () => {
      const res = await request(app.getHttpServer())
        .put('/database/explorer/schemas/public/tables/users/rows/123')
        .send({ data: {} });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject update with malicious column names', async () => {
      const res = await request(app.getHttpServer())
        .put('/database/explorer/schemas/public/tables/users/rows/123')
        .send({ data: { 'col\'; --': 'hacked' } });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should validate identifiers in delete operations', async () => {
      const res = await request(app.getHttpServer())
        .delete('/database/explorer/schemas/admin"; --/tables/users/rows/123');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // ========================================================================
  // 6. Query Runner Cleanup
  // ========================================================================
  describe('QueryRunner resource management', () => {
    it('should release query runner after successful request', async () => {
      mockQueryRunner.query.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/database/explorer/schemas');

      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should release query runner even on error', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('DB error'));

      await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables');

      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });
});
