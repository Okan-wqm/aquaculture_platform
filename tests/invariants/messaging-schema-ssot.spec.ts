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

  const expectedMigrationPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    [
      'channel_members.tenantId NOT NULL',
      /CREATE TABLE "messaging"\."channel_members"[^`]*"tenantId" uuid NOT NULL/i,
    ],
    [
      'channels.tenantId NOT NULL',
      /CREATE TABLE "messaging"\."channels"[^`]*"tenantId" uuid NOT NULL/i,
    ],
    [
      'messages.tenantId NOT NULL',
      /CREATE TABLE "messaging"\."messages"[^`]*"tenantId" uuid NOT NULL/i,
    ],
    [
      'messages.isAiGenerated NOT NULL default',
      /CREATE TABLE "messaging"\."messages"[^`]*"isAiGenerated" boolean NOT NULL DEFAULT false/i,
    ],
    [
      'message_attachments.is_deleted NOT NULL default',
      /CREATE TABLE "messaging"\."message_attachments"[^`]*"is_deleted" boolean NOT NULL DEFAULT false/i,
    ],
    [
      'message_attachments.deleted_at',
      /CREATE TABLE "messaging"\."message_attachments"[^`]*"deleted_at" TIMESTAMP WITH TIME ZONE/i,
    ],
    [
      'legal_holds.legalMatterId NOT NULL',
      /CREATE TABLE "messaging"\."legal_holds"[^`]*"legalMatterId" uuid NOT NULL/i,
    ],
    [
      'legal_holds.legalMatterDescription',
      /CREATE TABLE "messaging"\."legal_holds"[^`]*"legalMatterDescription" text/i,
    ],
    [
      'legal_holds.requestedBy',
      /CREATE TABLE "messaging"\."legal_holds"[^`]*"requestedBy" uuid/i,
    ],
    [
      'legal_holds.expiresAt',
      /CREATE TABLE "messaging"\."legal_holds"[^`]*"expiresAt" TIMESTAMP WITH TIME ZONE/i,
    ],
    [
      'messaging_outbox.isDeadLettered NOT NULL default',
      /messaging\.messaging_outbox[^`]*"isDeadLettered" BOOLEAN NOT NULL DEFAULT false/i,
    ],
  ];

  it.each(expectedMigrationPatterns)('%s lives in the active migration ledger', (label, pattern) => {
    expectMigrationSql(label, pattern);
  });
});
