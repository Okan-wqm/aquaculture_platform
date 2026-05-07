/**
 * audit-emit — write a single PLATFORM_FACTORY_RESET row into
 * shared.audit_logs so the operator action is traceable in the
 * canonical audit table.
 *
 * Column shape mirrors infrastructure/docker/init-scripts/10-shared-schema.sql
 * (the canonical writer for shared.audit_logs):
 *
 *   id            UUID         (default gen_random_uuid())
 *   action        VARCHAR(100) NOT NULL  ← 'PLATFORM_FACTORY_RESET'
 *   resource      VARCHAR(100) NOT NULL  ← 'platform'
 *   resourceId    VARCHAR(255)           ← gitSha
 *   userId        VARCHAR(255)           ← by-okan SUPER_ADMIN id
 *   userEmail     VARCHAR(255)           ← 'by-okan@live.com'
 *   tenantId      UUID                   ← NULL (platform-wide)
 *   schemaName    VARCHAR(100)           ← 'shared'
 *   metadata      JSONB                  ← reset envelope
 *   ip            VARCHAR(45)            ← '127.0.0.1' (host-local op)
 *   userAgent     VARCHAR(500)           ← 'factory-reset-cli/1'
 *   severity      VARCHAR(20) DEFAULT 'info'  ← 'critical'
 *   correlationId VARCHAR(100)           ← ISO timestamp
 *   createdAt     TIMESTAMPTZ DEFAULT NOW()
 *
 * The metadata JSONB envelope captures before/after counts so
 * downstream investigation can confirm the destructive action
 * landed without a separate log lookup.
 *
 * RLS note:
 *   shared.audit_logs has tenant_isolation_policy installed at
 *   schema-init time. Inserting `tenantId = NULL` is allowed when
 *   `app.bypass_rls = on` is set on the session (see policy in
 *   10-shared-schema.sql). We set it via a SET LOCAL inside a
 *   transaction so the bypass releases on COMMIT.
 */

import { execFileSync } from 'node:child_process';

import { logInfo } from './log.ts';

const PHASE = 'audit-emit';

export interface AuditEmitOptions {
  superAdminUserId: string;
  superAdminEmail: string;
  gitSha: string;
  metadata: Record<string, unknown>;
  dryRun: boolean;
}

/**
 * Execute SQL inside aqua-postgres. Uses stdin to pass the SQL
 * payload so we don't have to escape quotes/dollar-quotes through
 * the shell.
 */
function psqlExec(sql: string): void {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'aqua-postgres',
      'psql',
      '-U',
      process.env.POSTGRES_USER ?? 'aquaculture',
      '-d',
      process.env.POSTGRES_DB ?? 'aquaculture',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

export function emitAudit(opts: AuditEmitOptions): void {
  const correlationId = new Date().toISOString();
  // psql on the host receives the JSON via stdin so single-quote escape
  // hazards are confined to the metadata literal we build below.
  const metadataJson = JSON.stringify({
    ...opts.metadata,
    gitSha: opts.gitSha,
    performedAt: correlationId,
  }).replace(/'/g, "''");

  const sql = [
    'BEGIN;',
    "SET LOCAL app.bypass_rls = 'on';",
    'INSERT INTO shared.audit_logs (',
    '  action, resource, "resourceId", "userId", "userEmail",',
    '  "tenantId", "schemaName", metadata, ip, "userAgent",',
    '  severity, "correlationId"',
    ') VALUES (',
    "  'PLATFORM_FACTORY_RESET',",
    "  'platform',",
    `  '${opts.gitSha}',`,
    `  '${opts.superAdminUserId}',`,
    `  '${opts.superAdminEmail.replace(/'/g, "''")}',`,
    '  NULL,',
    "  'shared',",
    `  '${metadataJson}'::jsonb,`,
    "  '127.0.0.1',",
    "  'factory-reset-cli/1',",
    "  'critical',",
    `  '${correlationId}'`,
    ');',
    'COMMIT;',
  ].join('\n');

  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would insert audit row', {
      action: 'PLATFORM_FACTORY_RESET',
      userId: opts.superAdminUserId,
      gitSha: opts.gitSha,
      metadata: opts.metadata,
    });
    return;
  }

  logInfo(PHASE, 'inserting audit row', {
    action: 'PLATFORM_FACTORY_RESET',
    userId: opts.superAdminUserId,
    correlationId,
  });
  psqlExec(sql);
  logInfo(PHASE, 'audit row written');
}
