#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Client } from 'pg';

const root = process.cwd();

function read(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function fail(message) {
  process.stderr.write(`messaging-source-outbox gate failed: ${message}\n`);
  process.exit(1);
}

function assertContains(haystack, needle, path) {
  if (!haystack.includes(needle)) {
    fail(`${path} does not contain ${JSON.stringify(needle)}`);
  }
}

const migrationPath =
  'apps/messaging-service/src/migrations/1800200000000-CreateMessagingOutboxTable.ts';
const initSqlPath =
  'apps/messaging-service/src/migrations/init-messaging-schema.sql';
const entityPath =
  'apps/messaging-service/src/outbox/messaging-outbox.entity.ts';
const schemaManagerPath =
  'libs/backend-common/src/database/schema-manager.service.ts';

const migration = read(migrationPath);
const initSql = read(initSqlPath);
const entity = read(entityPath);
const schemaManager = read(schemaManagerPath);

assertContains(migration, '@SourceOnlyMigration', migrationPath);
assertContains(migration, 'messaging.messaging_outbox', migrationPath);
assertContains(migration, '"id" UUID PRIMARY KEY DEFAULT gen_random_uuid()', migrationPath);
assertContains(migration, "table_schema ~ '^tenant_[a-f0-9]{16}$'", migrationPath);
assertContains(initSql, '"id"               UUID PRIMARY KEY DEFAULT gen_random_uuid()', initSqlPath);
assertContains(entity, "@PrimaryGeneratedColumn('uuid')", entityPath);

const messagingSection = schemaManager.match(
  /moduleName: 'messaging'[\s\S]*?tables: \[([\s\S]*?)\n {4}\],/,
);
if (!messagingSection) {
  fail(`${schemaManagerPath} messaging schema section not found`);
}
const [section] = messagingSection;
if (!/infrastructureTables:\s*\[[\s\S]*'messaging_outbox'/.test(section)) {
  fail(`${schemaManagerPath} must list messaging_outbox as infrastructureTables`);
}
const tablesOnly = messagingSection[1] ?? '';
if (tablesOnly.includes("'messaging_outbox'")) {
  fail(`${schemaManagerPath} must not list messaging_outbox as a tenant table`);
}

const databaseUrl =
  process.env.MESSAGING_SOURCE_OUTBOX_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  fail(
    'set MESSAGING_SOURCE_OUTBOX_DATABASE_URL or DATABASE_URL; this gate requires a real PostgreSQL schema query',
  );
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const idType = await client.query(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema = 'messaging'
        AND table_name = 'messaging_outbox'
        AND column_name = 'id'`,
  );
  if (idType.rows[0]?.data_type !== 'uuid') {
    fail(
      `messaging.messaging_outbox.id must be uuid; observed ${idType.rows[0]?.data_type ?? 'missing'}`,
    );
  }

  const tenantTables = await client.query(
    `SELECT table_schema
       FROM information_schema.tables
      WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
        AND table_name = 'messaging_outbox'
      ORDER BY table_schema`,
  );
  if (tenantTables.rows.length > 0) {
    fail(
      `messaging_outbox exists in tenant schemas: ${tenantTables.rows
        .map((row) => row.table_schema)
        .join(', ')}`,
    );
  }
} finally {
  await client.end();
}

process.stdout.write('OK: messaging_outbox is source-only with uuid PK\n');
