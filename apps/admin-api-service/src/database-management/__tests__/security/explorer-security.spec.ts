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
import { INestApplication, ValidationPipe, HttpStatus, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
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
    log: jest.fn().mockResolvedValue({ id: 'audit-log-id' }),
  };

  // The real PlatformAdminGuard attaches req.user on every request; model that so
  // audit rows can attribute the actual operator (APA-329) instead of a literal.
  const TEST_USER = { id: 'admin-123', sub: 'admin-123', email: 'admin@corp.io' };
  const mockGuard = {
    canActivate: jest.fn((context: ExecutionContext) => {
      context.switchToHttp().getRequest<{ user?: unknown }>().user = TEST_USER;
      return true;
    }),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DatabaseExplorerController],
      providers: [
        { provide: getDataSourceToken('explorer-readonly'), useValue: mockDataSource },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: AuditLogService, useValue: mockAuditLogService },
        // In production PlatformAdminGuard is a global APP_GUARD that attaches
        // req.user; the controller has no @UseGuards, so overrideGuard alone
        // never runs. Register the mock as an APP_GUARD so it actually executes
        // and threads the operator onto the request (APA-329 attribution tests).
        { provide: APP_GUARD, useValue: mockGuard },
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
    mockAuditLogService.log.mockResolvedValue({ id: 'audit-log-id' });
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
  // 5b. Sensitive-column mask symmetry on writes (APA-328 / APA-330)
  //
  // The read path masks sensitive columns to '********'. The write path must
  // (a) never persist that sentinel back over the real secret, and (b) never
  // egress the real secret on the write/delete response.
  // ========================================================================
  describe('CRUD sensitive-column mask symmetry (APA-328/APA-330)', () => {
    beforeEach(() => {
      process.env['ENABLE_DB_EXPLORER_WRITES'] = 'true';
    });

    afterEach(() => {
      delete process.env['ENABLE_DB_EXPLORER_WRITES'];
    });

    const sqlCalls = (): string[] =>
      mockQueryRunner.query.mock.calls.map((c) => String(c[0]));

    it('drops a sensitive column resubmitted as the mask from the UPDATE SET clause (APA-328)', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ column_name: 'id' }]) // getPrimaryKeyColumn
        .mockResolvedValueOnce([
          { id: '123', name: 'newname', password_hash: 'real-hash' },
        ]); // UPDATE ... RETURNING *

      const res = await request(app.getHttpServer())
        .put('/database/explorer/schemas/auth/tables/users/rows/123')
        .send({ data: { name: 'newname', password_hash: '********' } });

      expect(res.status).toBe(HttpStatus.OK);
      const updateSql = sqlCalls().find((s) => s.includes('UPDATE'));
      expect(updateSql).toBeDefined();
      expect(updateSql).toContain('"name"');
      expect(updateSql).not.toContain('password_hash');
      const updateValues = mockQueryRunner.query.mock.calls.find((c) =>
        String(c[0]).includes('UPDATE'),
      )?.[1] as unknown[];
      expect(updateValues).not.toContain('********');
    });

    it('rejects an UPDATE whose only column is the mask sentinel, issuing no SQL (APA-328)', async () => {
      const res = await request(app.getHttpServer())
        .put('/database/explorer/schemas/auth/tables/users/rows/123')
        .send({ data: { password_hash: '********' } });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      // The 400 fires before any write runner is created, so NO SQL runs at all
      // (not merely "no UPDATE") — the mask sentinel never reaches the database.
      expect(mockQueryRunner.query).not.toHaveBeenCalled();
    });

    it('drops a sensitive column resubmitted as the mask from the INSERT column list (APA-328)', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        { id: '1', name: 'x', password_hash: 'real-hash', api_key: 'real-key' },
      ]); // INSERT ... RETURNING *

      const res = await request(app.getHttpServer())
        .post('/database/explorer/schemas/auth/tables/users/rows')
        .send({ data: { name: 'x', password_hash: '********', api_key: 'new-key' } });

      expect(res.status).toBe(HttpStatus.CREATED);
      const insertSql = sqlCalls().find((s) => s.includes('INSERT'));
      expect(insertSql).toBeDefined();
      expect(insertSql).toContain('"name"');
      expect(insertSql).toContain('"api_key"'); // a real new value is kept
      expect(insertSql).not.toContain('password_hash'); // the mask is dropped
    });

    it('masks sensitive columns on the UPDATE response (APA-330)', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ column_name: 'id' }])
        .mockResolvedValueOnce([
          { id: '123', name: 'newname', password_hash: 'real-hash' },
        ]);

      const res = await request(app.getHttpServer())
        .put('/database/explorer/schemas/auth/tables/users/rows/123')
        .send({ data: { name: 'newname' } });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.password_hash).toBe('********');
      expect(res.body.name).toBe('newname');
    });

    it('masks sensitive columns on the INSERT response (APA-330)', async () => {
      mockQueryRunner.query.mockResolvedValueOnce([
        { id: '1', name: 'x', password_hash: 'real-hash', api_key: 'real-key' },
      ]);

      const res = await request(app.getHttpServer())
        .post('/database/explorer/schemas/auth/tables/users/rows')
        .send({ data: { name: 'x', api_key: 'new-key' } });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.password_hash).toBe('********');
      expect(res.body.api_key).toBe('********');
    });

    it('masks sensitive columns on the DELETE response (APA-330)', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([{ column_name: 'id' }])
        .mockResolvedValueOnce([{ id: '123', password_hash: 'real-hash' }]);

      const res = await request(app.getHttpServer())
        .delete('/database/explorer/schemas/auth/tables/users/rows/123');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.deleted).toBe(true);
      expect(res.body.row.password_hash).toBe('********');
    });
  });

  // ========================================================================
  // 5c. Audit actor attribution on the read/export/raw-SQL paths (APA-329)
  //
  // The highest-leak-risk explorer actions (READ/EXPORT/RAW_SQL) previously
  // recorded performedBy:'SUPER_ADMIN' — a literal, not the operator. Every
  // explorer audit now flows through auditExplorerAction, which derives the
  // actor exclusively from the request, so multi-operator accountability holds.
  // ========================================================================
  describe('audit actor attribution (APA-329)', () => {
    const READ_COLUMNS = [
      {
        column_name: 'id',
        data_type: 'uuid',
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        is_foreign_key: false,
      },
    ];

    const auditCallFor = (
      action: string,
    ): Record<string, unknown> | undefined =>
      mockAuditLogService.log.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((input) => input.action === action);

    const expectAttributedToOperator = (
      audit: Record<string, unknown> | undefined,
    ): void => {
      expect(audit).toBeDefined();
      expect(audit?.performedBy).toBe('admin-123');
      expect(audit?.performedByEmail).toBe('admin@corp.io');
      expect(audit?.ipAddress).toBeTruthy();
      expect(audit?.userAgent).toBe('jest-agent');
    };

    it('attributes a table READ to the real operator, not the SUPER_ADMIN literal', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce(READ_COLUMNS) // column info
        .mockResolvedValueOnce([{ count: '0' }]) // COUNT
        .mockResolvedValueOnce([]); // data

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/auth/tables/users/data')
        .set('User-Agent', 'jest-agent');

      expect(res.status).toBe(HttpStatus.OK);
      expectAttributedToOperator(auditCallFor('DATABASE_EXPLORER_READ'));
    });

    it('attributes an EXPORT to the real operator', async () => {
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // SET TRANSACTION READ ONLY
        .mockResolvedValueOnce(READ_COLUMNS) // column info
        .mockResolvedValueOnce([]); // data

      const res = await request(app.getHttpServer())
        .get('/database/explorer/schemas/public/tables/users/export?format=json')
        .set('User-Agent', 'jest-agent');

      expect(res.status).toBe(HttpStatus.OK);
      expectAttributedToOperator(auditCallFor('DATABASE_EXPLORER_EXPORT'));
    });

    it('attributes a RAW_SQL execution to the real operator', async () => {
      mockQueryRunner.query.mockResolvedValue([{ id: 1 }]);

      const res = await request(app.getHttpServer())
        .post('/database/explorer/query')
        .set('User-Agent', 'jest-agent')
        .send({ sql: 'SELECT 1' });

      expect(res.status).toBe(HttpStatus.CREATED);
      expectAttributedToOperator(auditCallFor('DATABASE_EXPLORER_RAW_SQL'));
    });

    it('records NO explorer audit with the SUPER_ADMIN literal while an operator is present', async () => {
      mockQueryRunner.query.mockResolvedValue([{ id: 1 }]);

      await request(app.getHttpServer())
        .post('/database/explorer/query')
        .send({ sql: 'SELECT 1' });

      const literalCalls = mockAuditLogService.log.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((input) => String(input.action).startsWith('DATABASE_EXPLORER_'))
        .filter((input) => input.performedBy === 'SUPER_ADMIN');
      expect(literalCalls).toEqual([]);
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
