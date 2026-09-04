/**
 * Messaging schema SSoT invariant - INFRA-CRITICAL-011.
 *
 * The messaging database shape is owned by the TypeORM migration ledger, not by
 * service-local init SQL. The April drift incident was caused by entity shape
 * advancing past the DB contract while runtime synchronize and ghost SQL hid the
 * gap. This invariant locks the repaired contract in source control:
 *
 * - no service-local `init-*schema*.sql` DDL authority can exist;
 * - the active messaging migrations carry the columns called out by
 *   INFRA-CRITICAL-011.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const APPS_DIR = resolve(REPO_ROOT, 'apps');
const MESSAGING_MIGRATIONS_DIR = resolve(
  REPO_ROOT,
  'apps',
  'messaging-service',
  'src',
  'migrations',
);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.archive') continue;
      out.push(...listFiles(full));
      continue;
    }
    if (stat.isFile()) out.push(full);
  }
  return out;
}

function activeMessagingMigrationCorpus(): string {
  return readdirSync(MESSAGING_MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .map((entry) => readFileSync(join(MESSAGING_MIGRATIONS_DIR, entry), 'utf8'))
    .join('\n');
}

function expectMigrationSql(label: string, pattern: RegExp): void {
  const corpus = activeMessagingMigrationCorpus();
  if (!pattern.test(corpus)) {
    throw new Error(
      `Messaging migration SSoT is missing ${label}.\n` +
        `Fix the TypeORM migration ledger; do not add service-local init SQL.`,
    );
  }
}

describe('messaging schema SSoT (INFRA-CRITICAL-011)', () => {
  it('does not carry service-local init schema SQL as a parallel DDL source', () => {
    const violations = listFiles(APPS_DIR)
      .map((file) => relative(REPO_ROOT, file))
      .filter((file) => /(^|\/)init-[^/]*schema[^/]*\.sql$/i.test(file));

    expect(violations).toEqual([]);
  });

  /**
   * A per-tenant table's DDL must be UNQUALIFIED so tenant provisioning — which
   * is migration replay with `search_path` pinned to `tenant_<uuid>` — routes it
   * into the tenant schema instead of writing back into `messaging`
   * (DATA-CRITICAL-010). Pinning the qualified spelling here is what let the
   * regression look correct, so the shape is now part of the assertion rather
   * than incidental to it.
   */
  const perTenantColumn = (table: string, column: RegExp): RegExp =>
    new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"${table}" \\([^\`]*${column.source}`, 'i');

  const expectedMigrationPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ['channel_members.tenantId NOT NULL', perTenantColumn('channel_members', /"tenantId" uuid NOT NULL/)],
    ['channels.tenantId NOT NULL', perTenantColumn('channels', /"tenantId" uuid NOT NULL/)],
    ['messages.tenantId NOT NULL', perTenantColumn('messages', /"tenantId" uuid NOT NULL/)],
    [
      'messages.isAiGenerated NOT NULL default',
      perTenantColumn('messages', /"isAiGenerated" boolean NOT NULL DEFAULT false/),
    ],
    [
      'message_attachments.is_deleted NOT NULL default',
      perTenantColumn('message_attachments', /"is_deleted" boolean NOT NULL DEFAULT false/),
    ],
    [
      'message_attachments.deleted_at',
      perTenantColumn('message_attachments', /"deleted_at" TIMESTAMP WITH TIME ZONE/),
    ],
    [
      'legal_holds.legalMatterId NOT NULL',
      perTenantColumn('legal_holds', /"legalMatterId" uuid NOT NULL/),
    ],
    [
      'legal_holds.legalMatterDescription',
      perTenantColumn('legal_holds', /"legalMatterDescription" text/),
    ],
    ['legal_holds.requestedBy', perTenantColumn('legal_holds', /"requestedBy" uuid/)],
    [
      'legal_holds.expiresAt',
      perTenantColumn('legal_holds', /"expiresAt" TIMESTAMP WITH TIME ZONE/),
    ],
    // Cross-tenant infrastructure: the outbox stays in `messaging` by design,
    // so its DDL is the one that KEEPS the schema qualifier.
    [
      'messaging_outbox.isDeadLettered NOT NULL default',
      /messaging\.messaging_outbox[^`]*"isDeadLettered" BOOLEAN NOT NULL DEFAULT false/i,
    ],
  ];

  it.each(expectedMigrationPatterns)('%s lives in the active migration ledger', (label, pattern) => {
    expectMigrationSql(label, pattern);
  });
});
