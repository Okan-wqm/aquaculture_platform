import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Logger, StreamableFile } from '@nestjs/common';

import { DatabaseExplorerController } from '../explorer.controller';
import { AuditLogService } from '../../../audit/audit.service';

/**
 * APA-327: the global ResponseInterceptor wraps every handler return in the
 * {success,data,meta} envelope, and a StreamableFile nested inside that object
 * is no longer streamed by Nest — so a JSON export that returned a bare rows
 * array delivered the envelope instead of the array. exportTableData now returns
 * a StreamableFile for BOTH formats, so the interceptor's binary passthrough
 * (response.interceptor.ts) streams the raw bytes: the JSON body is a bare array
 * and the CSV body is the raw CSV, never an envelope. Mocked query runner — no DB.
 */
type QueryRunnerMock = {
  connect: jest.Mock;
  release: jest.Mock;
  query: jest.Mock;
};

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

function makeQueryRunner(): QueryRunnerMock {
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

async function readStream(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

describe('DatabaseExplorerController.exportTableData StreamableFile contract (APA-327)', () => {
  let controller: DatabaseExplorerController;
  let readOnlyRunner: QueryRunnerMock;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    readOnlyRunner = makeQueryRunner();
    const readOnlyDataSource = { createQueryRunner: jest.fn(() => readOnlyRunner) };
    const writeDataSource = { createQueryRunner: jest.fn(() => makeQueryRunner()) };
    const auditLogService = { log: jest.fn().mockResolvedValue({ id: 'audit-1' }) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DatabaseExplorerController],
      providers: [
        { provide: getDataSourceToken('explorer-readonly'), useValue: readOnlyDataSource },
        { provide: getDataSourceToken(), useValue: writeDataSource },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    controller = moduleRef.get(DatabaseExplorerController);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns a StreamableFile whose JSON body is a bare array, not an envelope', async () => {
    const result = await controller.exportTableData('public', 'export_probe', {
      format: 'json',
    });

    expect(result).toBeInstanceOf(StreamableFile);
    const body = await readStream(result);
    const parsed: unknown = JSON.parse(body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(DATA_ROWS);
  });

  it('returns a StreamableFile whose CSV body is raw CSV (header row first)', async () => {
    const result = await controller.exportTableData('public', 'export_probe', {
      format: 'csv',
    });

    expect(result).toBeInstanceOf(StreamableFile);
    const body = await readStream(result);
    const firstLine = body.split('\n')[0];
    expect(firstLine).toBe('id,name');
    expect(body).not.toContain('"success"');
  });
});
