import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MESSAGE_ENTITY = resolve(
  REPO_ROOT,
  'apps/messaging-service/src/message/entities/message.entity.ts',
);
const PARTITION_MANAGER = resolve(
  REPO_ROOT,
  'apps/messaging-service/src/partition/partition-manager.service.ts',
);
const PARTITION_BOOTSTRAP = resolve(
  REPO_ROOT,
  'apps/messaging-service/src/partition/partition-bootstrap.service.ts',
);
const PARTITION_REPAIR_MIGRATION = resolve(
  REPO_ROOT,
  'apps/messaging-service/src/migrations/1800600000000-PartitionMessagingParents.ts',
);
const E2E_SETUP = resolve(REPO_ROOT, 'apps/messaging-service/test/e2e-setup.ts');
const SCHEMA_MANAGER = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/schema-manager.service.ts',
);

describe('INVARIANT: messaging partition parents and idempotency SSoT', () => {
  it('creates active message parents as RANGE-partitioned tables in the repair migration', () => {
    const src = readFileSync(PARTITION_REPAIR_MIGRATION, 'utf8');

    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS "messages"[\s\S]+PARTITION BY RANGE \("createdAt"\)/,
    );
    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS "message_receipts"[\s\S]+PARTITION BY RANGE \("receiptCreatedAt"\)/,
    );
  });

  it('keeps message idempotency uniqueness in the ledger, not on partitioned messages', () => {
    const repair = readFileSync(PARTITION_REPAIR_MIGRATION, 'utf8');
    const entity = readFileSync(MESSAGE_ENTITY, 'utf8');
    const schemaManager = readFileSync(SCHEMA_MANAGER, 'utf8');

    expect(repair).toContain('CREATE TABLE IF NOT EXISTS "message_idempotency_keys"');
    expect(schemaManager).toContain("'message_idempotency_keys'");
    expect(repair).toContain('DROP INDEX IF EXISTS "idx_messages_idempotency"');
    expect(repair).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_messages_idempotency" ON "messages" ("tenantId", "idempotencyKey", "createdAt")',
    );
    expect(repair).not.toMatch(/CREATE UNIQUE INDEX "idx_messages_idempotency"/);
    expect(entity).toContain('message_idempotency_keys ledger');
    expect(entity).not.toMatch(/idx_messages_idempotency[^\\n]+unique:\s*true/);
  });

  it('keeps messaging E2E tenant cloning on MODULE_SCHEMAS and excludes infrastructure tables', () => {
    const setup = readFileSync(E2E_SETUP, 'utf8');

    expect(setup).toContain('MODULE_SCHEMAS');
    expect(setup).toContain("schema.moduleName === 'messaging'");
    expect(setup).toContain('messagingSchema.infrastructureTables');
    expect(setup).not.toMatch(/SELECT tablename FROM pg_tables WHERE schemaname = \$1/);
  });

  it('keeps tenant schema provisioning partition-aware before ledger seeding', () => {
    const schemaManager = readFileSync(SCHEMA_MANAGER, 'utf8');

    expect(schemaManager).toContain('createTenantTableFromSource(');
    expect(schemaManager).toContain('sourcePartitionKey(');
    expect(schemaManager).toContain('cloneSourcePartitions(');
    expect(schemaManager).toMatch(
      /CREATE TABLE "\$\{safeTargetSchema\}"\."\$\{safeTableName\}"[\s\S]+PARTITION BY \$\{partitionKey\}/,
    );
    expect(schemaManager.indexOf('await this.createTenantTableFromSource(')).toBeLessThan(
      schemaManager.indexOf('await this.seedMigrationsHistory('),
    );
  });

  it('fails closed when runtime partition parents are missing or use the wrong key', () => {
    const manager = readFileSync(PARTITION_MANAGER, 'utf8');
    const bootstrap = readFileSync(PARTITION_BOOTSTRAP, 'utf8');

    expect(manager).toContain("AND c.relkind = 'p'");
    expect(bootstrap).toContain("getMigrationRunnerCompletion('messaging')");
    expect(bootstrap).toContain('ensureStartupPartitions');
    expect(manager).toContain('Messaging partition parent missing or not partitioned');
    expect(manager).toContain('normalizePartitionKey(partitionKey) !== expectedPartitionKey');
    expect(manager).not.toMatch(/partitionKey\.includes/);
  });

  it('keeps the repair migration data-preserving before dropping unpartitioned backups', () => {
    const repair = readFileSync(PARTITION_REPAIR_MIGRATION, 'utf8');

    expect(repair).toContain(
      "await this.assertPartitionedBy(queryRunner, 'messages', 'createdAt')",
    );
    expect(repair).toContain(
      "await this.assertPartitionedBy(queryRunner, 'message_receipts', 'receiptCreatedAt')",
    );
    expect(repair).toContain('await this.assertRowCountPreserved(');
    expect(repair).toContain('assertNoDuplicateMessageIdempotencyKeys');
    expect(repair).toContain("['message_idempotency_keys', 'FK_message_idempotency_keys_message']");
    expect(repair).toMatch(
      /public async up[\s\S]+assertNoDuplicateMessageIdempotencyKeys[\s\S]+dropMessageForeignKeys/,
    );
    expect(repair).toContain('Cannot continue partition migration: copied');
    expect(repair).toContain('Cannot backfill message idempotency ledger: duplicate key');
  });
});
