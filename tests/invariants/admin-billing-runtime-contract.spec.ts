/**
 * Invariant: platform-admin billing runtime contracts must match production
 * database and NATS ownership boundaries.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_BILLING_SERVICE_GLOB = 'apps/admin-api-service/src/billing/**/*.ts';
const ADMIN_BILLING_FILES = execFileSync(
  'git',
  ['ls-files', '-z', '--', ADMIN_BILLING_SERVICE_GLOB],
  { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
)
  .split('\0')
  .filter(Boolean);
const BILLING_ADMIN_COMMAND_SUBJECT = 'request.billing.admin.>';

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

function extractYamlList(block: string, key: 'publish' | 'subscribe'): string {
  const nextKey = key === 'publish' ? 'subscribe' : undefined;
  const pattern =
    nextKey === undefined
      ? new RegExp(`\\n    ${key}:\\n([\\s\\S]*?)(?=\\n\\s*$)`)
      : new RegExp(`\\n    ${key}:\\n([\\s\\S]*?)\\n    ${nextKey}:`);

  return pattern.exec(block)?.[1] ?? '';
}

function extractNatsAllowList(userBlock: string, direction: 'publish' | 'subscribe'): string {
  return (
    new RegExp(`${direction}:\\s*\\{\\s*allow:\\s*\\[([\\s\\S]*?)\\n\\s*\\]`).exec(
      userBlock,
    )?.[1] ?? ''
  );
}

describe('INVARIANT: admin billing read models use UUID tenant contracts', () => {
  it('does not join auth.tenants.id to billing tenant_id by casting tenants to text', () => {
    const violations = ADMIN_BILLING_FILES.flatMap((file) => {
      const content = readRepoFile(file);
      return content
        .split(/\r?\n/)
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter((hit) => /auth\.tenants|tenant_id|t\.id::text/.test(hit.text))
        .filter((hit) => /t\.id::text\s*=\s*\w+\.tenant_id/.test(hit.text));
    });

    if (violations.length > 0) {
      const details = violations
        .map((hit) => `  ${hit.file}:${hit.line} -> ${hit.text.trim()}`)
        .join('\n');

      throw new Error(
        `Found billing tenant join(s) that cast auth.tenants.id to text:\n${details}\n\n` +
          `Production billing tenant_id columns are UUID. Join as UUID (` +
          `auth.tenants.id = billing.<table>.tenant_id) and cast string bind ` +
          `parameters to ::uuid where needed.`,
      );
    }

    expect(violations).toEqual([]);
  });
});

describe('INVARIANT: billing-service owns platform-admin billing mutations', () => {
  it('allows billing-service to subscribe, not publish, billing admin command subjects in NATS SSoT', () => {
    const servicesYaml = readRepoFile('infrastructure/nats/services.yaml');
    const billingServiceBlock =
      /- name: billing_service[\s\S]*?(?=\n[ ]{2}# ---------------------------------------------------------------------------|\n[ ]{2}- name:|\n*$)/.exec(
        servicesYaml,
      )?.[0] ?? '';
    const publishList = extractYamlList(billingServiceBlock, 'publish');
    const subscribeList = extractYamlList(billingServiceBlock, 'subscribe');

    expect(publishList).not.toContain(`- "${BILLING_ADMIN_COMMAND_SUBJECT}"`);
    expect(subscribeList).toContain(`- "${BILLING_ADMIN_COMMAND_SUBJECT}"`);
  });

  it('keeps generated NATS config in lockstep with the billing-service subscribe ACL', () => {
    const natsConf = readRepoFile('infrastructure/docker/nats/nats.conf');
    const billingUserBlock =
      /user: "CN=billing_service"[\s\S]*?(?=\n[ ]{4}\},|\n[ ]{4}# ──|\n*$)/.exec(natsConf)?.[0] ??
      '';
    const publishAllowList = extractNatsAllowList(billingUserBlock, 'publish');
    const subscribeAllowList = extractNatsAllowList(billingUserBlock, 'subscribe');

    expect(publishAllowList).not.toContain(`"${BILLING_ADMIN_COMMAND_SUBJECT}"`);
    expect(subscribeAllowList).toContain(`"${BILLING_ADMIN_COMMAND_SUBJECT}"`);
  });
});

describe('INVARIANT: billing schema hardening belongs to db-migrate', () => {
  it('declares billing RLS and audit-column hardening in the db-migrate registry', () => {
    const registry = readRepoFile('apps/db-migrate/src/schema-registry.ts');
    const billingSlot =
      /service: 'billing-service'[\s\S]*?schema: 'billing'[\s\S]*?(?=\n[ ]{2}\},)/.exec(
        registry,
      )?.[0] ?? '';

    expect(billingSlot).toContain('postMigrationHardening');
    expect(billingSlot).toContain('tenantRls: true');
    expect(billingSlot).toContain('auditColumns: true');
    expect(billingSlot).toContain('aqua-db-migrate');
  });

  it('runs billing schema hardening from the authoritative migration container', () => {
    const dbMigrateMain = readRepoFile('apps/db-migrate/src/main.ts');

    expect(dbMigrateMain).toContain('runSchemaPostMigrationHardening');
    expect(dbMigrateMain).toContain('applyTenantRlsToSchema');
    expect(dbMigrateMain).toContain('convertAuditColumnsToTimestamptz');
    expect(dbMigrateMain).toContain('entry.postMigrationHardening');
  });

  it('does not let billing-service perform runtime schema DDL when db-migrate is authoritative', () => {
    const billingAppModule = readRepoFile('apps/billing-service/src/app.module.ts');

    expect(billingAppModule).toContain('billingSchemaDdlOwnedByDbMigrate');
    expect(billingAppModule).toContain("process.env['DB_MIGRATE_AUTHORITATIVE'] === 'true'");
    expect(billingAppModule).toContain('autoApply: !billingSchemaDdlOwnedByDbMigrate');
    expect(billingAppModule).toContain('billingSchemaDdlOwnedByDbMigrate');
    expect(billingAppModule).toContain('AuditColumnsModule.forRoot');
  });
});
