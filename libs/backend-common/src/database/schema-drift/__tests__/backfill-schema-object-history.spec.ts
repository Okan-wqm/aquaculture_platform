/**
 * Unit tests for tools/scripts/backfill-schema-object-history.ts.
 * Exercises the pure extractDdlEvents + runBackfill functions with
 * synthetic migration fixtures + a fake writer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { defined } from '@aquaculture/testing';

interface MigrationFile {
  readonly path: string;
  readonly timestamp: number;
  readonly schema: string;
}

type ObjectType = 'table' | 'column' | 'index' | 'constraint' | 'enum' | 'policy';
type Action = 'created' | 'altered' | 'dropped' | 'renamed';

interface HistoricalSchemaEvent {
  readonly schema: string;
  readonly tableName: string;
  readonly objectType: ObjectType;
  readonly objectName: string;
  readonly action: Action;
  readonly observedAt: Date;
  readonly sourceFile: string;
}

interface HistoricalEventWriter {
  readonly findExisting: (
    schema: string,
    objectType: ObjectType,
    objectName: string,
    action: Action,
    observedAt: Date,
  ) => Promise<boolean>;
  readonly insert: (event: HistoricalSchemaEvent) => Promise<void>;
}

interface BackfillModule {
  readonly collectMigrations: (root?: string) => MigrationFile[];
  readonly extractDdlEvents: (file: MigrationFile) => readonly HistoricalSchemaEvent[];
  readonly runBackfill: (
    writer: HistoricalEventWriter,
    options?: { dryRun: boolean },
  ) => Promise<{
    readonly filesScanned: number;
    readonly eventsCollected: number;
    readonly eventsEmitted: number;
    readonly eventsSkipped: number;
  }>;
}

const { collectMigrations, extractDdlEvents, runBackfill } = jest.requireActual<BackfillModule>(
  resolve(__dirname, '../../../../../../tools/scripts/backfill-schema-object-history'),
);

describe('extractDdlEvents', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const mig = (name: string, body: string): MigrationFile => {
    const path = join(tmp, name);
    writeFileSync(
      path,
      `
import { MigrationInterface, QueryRunner } from 'typeorm';
export class M implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    ${body}
  }
  async down(): Promise<void> {}
}
`,
    );
    return {
      path,
      timestamp: 1700000000000,
      schema: 'hr',
    };
  };

  it('detects CREATE TABLE as created event', () => {
    const file = mig(
      '1-CreateEmployees.ts',
      'await qr.query(`CREATE TABLE "hr"."employees" (id uuid PRIMARY KEY)`);',
    );
    const events = extractDdlEvents(file);
    const created = events.filter((e) => e.action === 'created');
    expect(created.some((e) => e.objectType === 'table' && e.objectName === 'employees')).toBe(
      true,
    );
  });

  it('detects ALTER TABLE ADD COLUMN as column/created', () => {
    const file = mig(
      '2-AddCol.ts',
      'await qr.query(`ALTER TABLE hr.employees ADD COLUMN preferred_name text`);',
    );
    const events = extractDdlEvents(file);
    expect(
      events.some(
        (e) =>
          e.objectType === 'column' && e.objectName === 'preferred_name' && e.action === 'created',
      ),
    ).toBe(true);
  });

  it('detects CREATE INDEX as index/created', () => {
    const file = mig(
      '3-CreateIdx.ts',
      'await qr.query(`CREATE INDEX "IDX_employees_name" ON hr.employees (name)`);',
    );
    const events = extractDdlEvents(file);
    expect(
      events.some((e) => e.objectType === 'index' && e.objectName === 'IDX_employees_name'),
    ).toBe(true);
  });

  it('detects CREATE TYPE AS ENUM as enum/created', () => {
    const file = mig(
      '4-CreateEnum.ts',
      "await qr.query(`CREATE TYPE hr.status_enum AS ENUM (\\'draft\\', \\'active\\')`);",
    );
    const events = extractDdlEvents(file);
    expect(events.some((e) => e.objectType === 'enum' && e.objectName === 'status_enum')).toBe(
      true,
    );
  });

  it('detects ALTER TYPE ADD VALUE as enum/altered', () => {
    const file = mig(
      '5-AddEnumValue.ts',
      "await qr.query(`ALTER TYPE hr.status_enum ADD VALUE 'archived'`);",
    );
    const events = extractDdlEvents(file);
    expect(events.some((e) => e.objectType === 'enum' && e.action === 'altered')).toBe(true);
  });

  it('detects CREATE POLICY', () => {
    const file = mig(
      '6-Policy.ts',
      'await qr.query(`CREATE POLICY "tenant_scope" ON hr.employees FOR ALL USING (true)`);',
    );
    const events = extractDdlEvents(file);
    expect(events.some((e) => e.objectType === 'policy' && e.objectName === 'tenant_scope')).toBe(
      true,
    );
  });

  it('does NOT extract from down() bodies', () => {
    const path = join(tmp, '7-DownOnly.ts');
    writeFileSync(
      path,
      `
import { MigrationInterface, QueryRunner } from 'typeorm';
export class M implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(\`-- intentional no-op\`);
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query(\`DROP TABLE hr.employees\`);
  }
}
`,
    );
    const events = extractDdlEvents({
      path,
      timestamp: 1700000000007,
      schema: 'hr',
    });
    // DROP only appears in down() → no dropped event.
    expect(events.filter((e) => e.action === 'dropped')).toEqual([]);
  });

  it('preserves observedAt from filename timestamp', () => {
    const file = mig('8-Timestamp.ts', 'await qr.query(`CREATE TABLE hr.t (id uuid)`);');
    // Override the manual timestamp for assertion clarity.
    const fixedTimestamp = 1_770_000_000_000;
    const events = extractDdlEvents({ ...file, timestamp: fixedTimestamp });
    expect(events[0]?.observedAt.getTime()).toBe(fixedTimestamp);
  });
});

describe('collectMigrations', () => {
  it('scans real repo + tags schema per service', () => {
    const files = collectMigrations();
    expect(files.length).toBeGreaterThan(0);
    // Every file has a numeric timestamp + a known schema.
    for (const f of files) {
      expect(Number.isFinite(f.timestamp)).toBe(true);
      expect(f.schema.length).toBeGreaterThan(0);
    }
    // HR migrations exist + tagged 'hr'.
    expect(files.some((f) => f.path.includes('/hr-service/') && f.schema === 'hr')).toBe(true);
  });

  it('files returned in timestamp-ascending order', () => {
    const files = collectMigrations();
    for (let i = 1; i < files.length; i++) {
      const current = defined(files[i]);
      const previous = defined(files[i - 1]);
      expect(current.timestamp).toBeGreaterThanOrEqual(previous.timestamp);
    }
  });
});

describe('runBackfill', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-run-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('idempotent: existing rows are skipped; new rows inserted', async () => {
    const inserts: unknown[] = [];
    const seen = new Set<string>();
    const writer = {
      findExisting: jest.fn(
        (
          schema: string,
          objectType: ObjectType,
          objectName: string,
          action: Action,
          observedAt: Date,
        ): Promise<boolean> => {
          const key = `${schema}:${objectType}:${objectName}:${action}:${observedAt.toISOString()}`;
          const exists = seen.has(key);
          seen.add(key);
          return Promise.resolve(exists);
        },
      ),
      insert: jest.fn((ev: HistoricalSchemaEvent): Promise<void> => {
        inserts.push(ev);
        return Promise.resolve();
      }),
    };

    const first = await runBackfill(writer);
    const second = await runBackfill(writer);

    expect(first.eventsEmitted).toBeGreaterThan(0);
    expect(second.eventsEmitted).toBe(0); // all already present
    expect(second.eventsSkipped).toBeGreaterThan(0);
  });

  it('dryRun=true skips writer.insert but still counts emitted', async () => {
    const writer = {
      findExisting: jest.fn(() => Promise.resolve(false)),
      insert: jest.fn(() => Promise.resolve()),
    };
    const result = await runBackfill(writer, { dryRun: true });
    expect(result.eventsEmitted).toBeGreaterThan(0);
    expect(writer.insert).not.toHaveBeenCalled();
  });
});
