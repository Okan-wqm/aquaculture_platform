import { INestApplication, ValidationPipe, HttpStatus, Logger } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';

import { DatabaseExplorerController } from '../explorer.controller';
import { AuditLogService } from '../../../audit/audit.service';
import { ResponseInterceptor } from '../../../shared/response.interceptor';

/**
 * The global ResponseInterceptor wraps every handler return in the
 * {success,data,meta} envelope, and a StreamableFile nested inside that object is
 * no longer streamed by Nest — so a JSON export that returned a bare rows array
 * delivered the envelope instead of the array. exportTableData now returns a
 * StreamableFile for BOTH formats, so the interceptor's binary passthrough
 * streams the raw bytes.
 *
 * This spec registers the real ResponseInterceptor as an APP_INTERCEPTOR (as in
 * production), so the assertions are end-to-end: had the JSON branch returned a
 * bare array it would be enveloped (res.body an object, not an array) and the
 * first test would fail. Mocked query runner — no DB.
 */
const COLUMN_ROWS = [
  {
    column_name: 'id',
    data_type: 'integer',
    is_nullable: false,
    column_default: null,
    is_primary_key: true,
    is_foreign_key: false,
    foreign_table_name: null,
    foreign_column_name: null,
  },
  {
    column_name: 'name',
    data_type: 'text',
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    is_foreign_key: false,
    foreign_table_name: null,
    foreign_column_name: null,
  },
];

const DATA_ROWS = [
  { id: 1, name: 'alpha' },
  { id: 2, name: 'beta' },
];

function makeQueryRunner(): {
  connect: jest.Mock;
  release: jest.Mock;
  query: jest.Mock;
} {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SET TRANSACTION READ ONLY')) return Promise.resolve(undefined);
      if (sql.includes('information_schema.columns')) return Promise.resolve(COLUMN_ROWS);
      return Promise.resolve(DATA_ROWS);
    }),
  };
}

describe('DatabaseExplorerController export StreamableFile contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const dataSource = { createQueryRunner: jest.fn(() => makeQueryRunner()) };
    const auditLogService = { log: jest.fn().mockResolvedValue({ id: 'audit-1' }) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DatabaseExplorerController],
      providers: [
        { provide: getDataSourceToken('explorer-readonly'), useValue: dataSource },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: AuditLogService, useValue: auditLogService },
        // The production envelope interceptor — its StreamableFile passthrough is
        // what this spec exercises end-to-end.
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('streams the JSON export as a bare array, never the {success,data,meta} envelope', async () => {
    const res = await request(app.getHttpServer()).get(
      '/database/explorer/schemas/public/tables/export_probe/export?format=json',
    );

    expect(res.status).toBe(HttpStatus.OK);
    expect(Array.isArray(res.body)).toBe(true); // not an envelope object
    expect(res.body).toEqual(DATA_ROWS);
  });

  it('streams the CSV export as raw CSV with the header row first', async () => {
    const res = await request(app.getHttpServer()).get(
      '/database/explorer/schemas/public/tables/export_probe/export?format=csv',
    );

    expect(res.status).toBe(HttpStatus.OK);
    expect(res.text.split('\n')[0]).toBe('id,name');
    expect(res.text).not.toContain('"success"');
  });
});
