/**
 * Platform-wide invariant — AUDITTRAIL-CRITICAL-004:
 *
 * `shared.audit_logs` MUST carry the audit-trail-completeness-auditor
 * agent's mandatory 24-column shape, declared coherently across THREE
 * SSoT layers:
 *
 *   1. `AuditLogEntity` (TypeORM mapping — runtime read/write)
 *   2. `CreateAuditEntryDto` (audit-log.tokens — caller-facing contract)
 *   3. `006-shared-schema-tables.sql` (db-migrate Phase 0 platform bootstrap)
 *
 * # Why this lives in tests/invariants/
 *
 * The forensic extension fields added by AUDITTRAIL-CRITICAL-004 close a
 * capability gap. A future "simplification" or column-drop migration
 * that re-strips any of these fields without touching the entity would
 * reintroduce the regression silently — the schema-drift validator runs
 * at boot, but a developer testing locally with a freshly-synced DB
 * would not see a failure until the next staging deploy. This
 * source-level Tier-3 "make detectable" gate trips at CI before merge.
 *
 * The check is shape-coherent, not value-comparing — it asserts that
 * each layer references each field, not that the layers agree on
 * format. Format drift is caught by SchemaDriftValidator at boot.
 *
 * # Failure mode
 *
 * If a migration removes any of the extension columns or the entity drops any
 * `@Column()` declaration, this test fails with a precise per-layer
 * report. Maintainers must either:
 *
 *   - Restore the field across all 3 layers (preferred), or
 *   - Open an ADR explicitly documenting the shape contraction and
 *     update this invariant's MANDATORY_FIELDS list in the same PR.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-CRITICAL-004
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTITY_PATH = 'libs/backend-common/src/audit/audit-log.entity.ts';
const TOKENS_PATH = 'libs/backend-common/src/audit/audit-log.tokens.ts';
const SERVICE_PATH = 'libs/backend-common/src/audit/audit-log.service.ts';
const INTERCEPTOR_PATH =
  'libs/backend-common/src/audit/audited-operation.interceptor.ts';
const PLATFORM_BOOTSTRAP_SQL_PATH =
  'apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql';

/**
 * The 24-column mandatory shape per the audit-trail-completeness-auditor
 * agent's invariant. The first 14 are the legacy V1 shape, `legalHold`
 * is the retention-protection extension, and the remaining 9 fields
 * (marked `mandatoryShapeExt: true`) are the AUDITTRAIL-CRITICAL-004
 * extension.
 */
const MANDATORY_FIELDS = [
  // ── V1 shape (pre-extension) ──
  { name: 'id', mandatoryShapeExt: false },
  { name: 'action', mandatoryShapeExt: false },
  { name: 'resource', mandatoryShapeExt: false },
  { name: 'resourceId', mandatoryShapeExt: false },
  { name: 'userId', mandatoryShapeExt: false },
  { name: 'userEmail', mandatoryShapeExt: false },
  { name: 'tenantId', mandatoryShapeExt: false },
  { name: 'schemaName', mandatoryShapeExt: false },
  { name: 'metadata', mandatoryShapeExt: false },
  { name: 'ip', mandatoryShapeExt: false },
  { name: 'userAgent', mandatoryShapeExt: false },
  { name: 'severity', mandatoryShapeExt: false },
  { name: 'correlationId', mandatoryShapeExt: false },
  { name: 'createdAt', mandatoryShapeExt: false },
  { name: 'legalHold', mandatoryShapeExt: false },
  // ── V2 mandatory-shape extension (AUDITTRAIL-CRITICAL-004) ──
  { name: 'actorHomeTenantId', mandatoryShapeExt: true },
  { name: 'actedOnTenantId', mandatoryShapeExt: true },
  { name: 'method', mandatoryShapeExt: true },
  { name: 'mfaVerified', mandatoryShapeExt: true },
  { name: 'result', mandatoryShapeExt: true },
  { name: 'preStateHash', mandatoryShapeExt: true },
  { name: 'postStateHash', mandatoryShapeExt: true },
  { name: 'justification', mandatoryShapeExt: true },
  { name: 'relatedAuditIds', mandatoryShapeExt: true },
] as const;

const ENTITY_EXT_FIELDS = MANDATORY_FIELDS.filter(
  (f) => f.mandatoryShapeExt,
).map((f) => f.name);

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('audit-log mandatory shape (AUDITTRAIL-CRITICAL-004)', () => {
  it('AuditLogEntity declares every mandatory-shape column', () => {
    const src = read(ENTITY_PATH);
    const missing: string[] = [];
    for (const field of MANDATORY_FIELDS) {
      // Property declaration line: e.g. `actorHomeTenantId!: string | null;`
      // The `!` (definite-assignment) follows TypeORM convention used
      // throughout this entity. Variant accepted: optional `?:` only on
      // the legacy resourceId etc. — we just check the name appears as
      // a class property.
      const propRe = new RegExp(`\\b${field.name}\\s*[!?]?\\s*:`);
      if (!propRe.test(src)) {
        missing.push(field.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('AuditLogEntity decorates the extension fields with @Column', () => {
    const src = read(ENTITY_PATH);
    const undecorated: string[] = [];
    for (const fieldName of ENTITY_EXT_FIELDS) {
      // Find the property line and look upward for `@Column(`.
      const propRe = new RegExp(`\\b${fieldName}\\s*[!?]?\\s*:`);
      const match = propRe.exec(src);
      expect(match).not.toBeNull();
      const before = src.slice(0, match!.index);
      // The @Column decorator should appear within the previous ~600 chars
      // (allows for multi-line decorator + JSDoc).
      const window = before.slice(Math.max(0, before.length - 800));
      if (!/@Column\s*\(/.test(window)) {
        undecorated.push(fieldName);
      }
    }
    expect(undecorated).toEqual([]);
  });

  it('CreateAuditEntryDto surfaces every mandatory-shape extension field', () => {
    const src = read(TOKENS_PATH);
    // Locate the interface body so we don't accidentally match jsdoc/enum text.
    const ifaceRe =
      /export\s+interface\s+CreateAuditEntryDto\s*{([\s\S]*?)\n}/;
    const ifaceMatch = ifaceRe.exec(src);
    expect(ifaceMatch).not.toBeNull();
    const body = ifaceMatch![1] ?? '';
    const missing: string[] = [];
    for (const fieldName of ENTITY_EXT_FIELDS) {
      const inIface = new RegExp(`\\b${fieldName}\\s*\\?\\s*:`);
      if (!inIface.test(body)) {
        missing.push(fieldName);
      }
    }
    expect(missing).toEqual([]);
  });

  it('AuditMethod and AuditResult enums are declared as closed vocabularies', () => {
    const src = read(TOKENS_PATH);
    expect(src).toMatch(/export\s+enum\s+AuditMethod\s*{[^}]*HTTP/);
    expect(src).toMatch(/export\s+enum\s+AuditMethod\s*{[^}]*GRAPHQL/);
    expect(src).toMatch(/export\s+enum\s+AuditMethod\s*{[^}]*NATS/);
    expect(src).toMatch(/export\s+enum\s+AuditMethod\s*{[^}]*CRON/);
    expect(src).toMatch(/export\s+enum\s+AuditMethod\s*{[^}]*CLI/);
    expect(src).toMatch(/export\s+enum\s+AuditResult\s*{[^}]*SUCCESS/);
    expect(src).toMatch(/export\s+enum\s+AuditResult\s*{[^}]*DENIED/);
    expect(src).toMatch(/export\s+enum\s+AuditResult\s*{[^}]*FAILED/);
  });

  it('AuditLogService.toEntityShape persists every extension field', () => {
    const src = read(SERVICE_PATH);
    const re = /private\s+toEntityShape\s*\([^)]*\)\s*:\s*[^{]+{([\s\S]*?)\n\s{2}}/;
    const match = re.exec(src);
    expect(match).not.toBeNull();
    const body = match![1] ?? '';
    const missing: string[] = [];
    for (const fieldName of ENTITY_EXT_FIELDS) {
      // We expect each field to appear as `<fieldName>: dto.<fieldName>` (with
      // optional `?? <default>`).
      const re2 = new RegExp(`\\b${fieldName}\\s*:\\s*dto\\.${fieldName}\\b`);
      if (!re2.test(body)) {
        missing.push(fieldName);
      }
    }
    expect(missing).toEqual([]);
  });

  it('AuditedOperationInterceptor populates the four context-derived extension fields', () => {
    const src = read(INTERCEPTOR_PATH);
    // The interceptor knows actor/method/mfaVerified/result; the other 4
    // are caller responsibility.
    const auditEntryBlock =
      /const\s+auditEntry\s*:\s*Partial<AuditLogEntity>\s*=\s*{([\s\S]*?)\n\s{4}};/;
    const match = auditEntryBlock.exec(src);
    expect(match).not.toBeNull();
    const body = match![1] ?? '';
    expect(body).toMatch(/actorHomeTenantId\s*:\s*ctx\.actorHomeTenantId/);
    expect(body).toMatch(/actedOnTenantId\s*:\s*ctx\.tenantId/);
    expect(body).toMatch(/method\s*:\s*ctx\.method/);
    expect(body).toMatch(/mfaVerified\s*:\s*ctx\.mfaVerified/);
    expect(body).toMatch(/result\s*:[\s\S]*AuditResult\.SUCCESS/);
    expect(body).toMatch(/AuditResult\.FAILED/);
  });

  describe('platform bootstrap shared.audit_logs shape', () => {
    const bootstrapSrc = read(PLATFORM_BOOTSTRAP_SQL_PATH);
    const bootstrapAddedFields = ['legalHold', ...ENTITY_EXT_FIELDS] as const;

    it.each(ENTITY_EXT_FIELDS)(
      'ALTER TABLE adds %s column',
      (fieldName) => {
        // ADD COLUMN IF NOT EXISTS "<fieldName>" or unquoted lower-case name.
        const re = new RegExp(
          `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"?${fieldName}"?`,
          'i',
        );
        expect(bootstrapSrc).toMatch(re);
      },
    );

    it.each(bootstrapAddedFields)(
      'Phase 0 idempotently guarantees %s column',
      (fieldName) => {
        const re = new RegExp(
          `ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+"?${fieldName}"?`,
          'i',
        );
        expect(bootstrapSrc).toMatch(re);
      },
    );

    it('declares CHECK constraints for the closed-vocabulary fields', () => {
      expect(bootstrapSrc).toMatch(/chk_audit_logs_method/);
      expect(bootstrapSrc).toMatch(/'HTTP'\s*,\s*'GRAPHQL'\s*,\s*'NATS'\s*,\s*'CRON'\s*,\s*'CLI'/);
      expect(bootstrapSrc).toMatch(/chk_audit_logs_result/);
      expect(bootstrapSrc).toMatch(/'SUCCESS'\s*,\s*'DENIED'\s*,\s*'FAILED'/);
    });

    it('installs the three forensic secondary indexes', () => {
      expect(bootstrapSrc).toMatch(
        /idx_audit_logs_actor_home_tenant_created/,
      );
      expect(bootstrapSrc).toMatch(
        /idx_audit_logs_acted_on_tenant_created/,
      );
      expect(bootstrapSrc).toMatch(/idx_audit_logs_mfa_verified_created/);
    });
  });
});
