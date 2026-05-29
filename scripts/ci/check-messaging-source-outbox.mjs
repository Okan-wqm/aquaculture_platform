#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const repoRoot = process.cwd();
const failures = [];

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function requireIncludes(path, needle, message) {
  const source = read(path);
  if (!source.includes(needle)) {
    failures.push(`${path}: ${message}`);
  }
}

function requireNotMatches(path, pattern, message) {
  const source = read(path);
  if (pattern.test(source)) {
    failures.push(`${path}: ${message}`);
  }
}

requireIncludes(
  'apps/messaging-service/src/outbox/messaging-outbox.entity.ts',
  "schema: 'messaging'",
  'MessagingOutbox must remain pinned to the messaging source schema.',
);

requireIncludes(
  'apps/messaging-service/test/e2e-setup.ts',
  "'messaging_outbox'",
  'E2E tenant schema fanout must keep messaging_outbox in the source-only table skip list.',
);

requireIncludes(
  'apps/messaging-service/test/tenant-isolation.e2e-spec.ts',
  'expect(tenantOutbox[0]?.exists).toBe(false)',
  'Tenant isolation E2E must assert tenant schemas do not own messaging_outbox.',
);

for (const path of [
  'apps/messaging-service/src/migrations/1800200000000-CreateMessagingOutboxTable.ts',
  'apps/messaging-service/src/migrations/1800350000000-AddMessagingOutboxNotifyTrigger.ts',
  'apps/messaging-service/src/migrations/1800400000000-HardenMessagingTenantIsolation.ts',
]) {
  requireNotMatches(
    path,
    /tenant_[^`'"]*messaging_outbox|schemaName[^`'"]*messaging_outbox|\$\{schema\}[^`'"]*messaging_outbox/i,
    'messaging_outbox DDL must not target dynamic tenant schemas.',
  );
}

requireIncludes(
  'apps/messaging-service/src/migrations/1800350000000-AddMessagingOutboxNotifyTrigger.ts',
  'ON messaging.messaging_outbox',
  'Outbox notify trigger must be created only on messaging.messaging_outbox.',
);

if (failures.length > 0) {
  console.error('Messaging source-owned outbox gate failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

const requireDbProof = process.env.REQUIRE_DB_PROOF === 'true';
if (process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const tenantOutbox = await client.query(`
      SELECT n.nspname AS schema_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'messaging_outbox'
         AND n.nspname LIKE 'tenant\\_%' ESCAPE '\\'
       ORDER BY n.nspname
    `);
    const sourceOutboxId = await client.query(`
      SELECT data_type
        FROM information_schema.columns
       WHERE table_schema = 'messaging'
         AND table_name = 'messaging_outbox'
         AND column_name = 'id'
    `);

    if (tenantOutbox.rows.length > 0) {
      failures.push(
        `database: tenant schema(s) contain messaging_outbox: ${tenantOutbox.rows
          .map((row) => row.schema_name)
          .join(', ')}`,
      );
    }
    if (sourceOutboxId.rows[0]?.data_type !== 'uuid') {
      failures.push(
        `database: messaging.messaging_outbox.id must be uuid; observed ${sourceOutboxId.rows[0]?.data_type ?? '<missing>'}`,
      );
    }
  } finally {
    await client.end();
  }
} else if (requireDbProof) {
  failures.push('database: DATABASE_URL is required for source-only outbox proof.');
}

if (failures.length > 0) {
  console.error('Messaging source-owned outbox gate failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('Messaging source-owned outbox gate passed.');
