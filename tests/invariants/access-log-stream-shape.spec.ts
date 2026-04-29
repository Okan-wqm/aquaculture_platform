/**
 * Platform-wide invariant — AUDITTRAIL-HIGH-004:
 *
 * The low-level HTTP access log stream (`shared.access_logs`) is
 * declared coherently across FOUR SSoT layers:
 *
 *   1. AccessLogEntity (TypeORM mapping — runtime read/write)
 *   2. CreateAccessLogDto (caller-facing contract)
 *   3. CreateSharedAccessLogs1788400000000 (DB schema migration)
 *   4. AccessLogMiddleware (request-level row emitter)
 *
 * # Why this lives in tests/invariants/
 *
 * The access stream is NEW infrastructure. A future refactor that
 * (e.g.) drops the durationMs column from the entity but leaves it
 * on the DTO would split the contract silently — operators would
 * see NULLs landing in the column with no indication of which
 * layer drifted. This source-level Tier-3 "make detectable" gate
 * trips at CI before merge.
 *
 * # Coherence check shape
 *
 * Per-layer regex match for each mandatory field. Layers do not
 * have to AGREE on format (e.g. the migration uses "varchar(8)"
 * while the entity uses "{ type: 'varchar', length: 8 }") — this
 * spec only asserts that each layer REFERENCES the field name.
 * Format/type drift is caught by SchemaDriftValidator at boot.
 *
 * # Failure mode
 *
 * If any of the 11 mandatory fields disappears from any layer,
 * this spec fails with a precise per-layer report. Maintainers
 * must either restore the field (preferred) or update the
 * MANDATORY_FIELDS list in this spec inside an explicit ADR.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const ENTITY_PATH = 'libs/backend-common/src/audit/access-log.entity.ts';
const SERVICE_PATH = 'libs/backend-common/src/audit/access-log.service.ts';
const MIGRATION_PATH =
  'apps/admin-api-service/src/migrations/1788400000000-CreateSharedAccessLogs.ts';
const MIDDLEWARE_PATH =
  'libs/backend-common/src/middleware/access-log.middleware.ts';

const MANDATORY_FIELDS = [
  'id',
  'method',
  'path',
  'status',
  'durationMs',
  'userId',
  'tenantId',
  'correlationId',
  'ip',
  'userAgent',
  'createdAt',
] as const;

const MIDDLEWARE_EMITTED_FIELDS = [
  'method',
  'path',
  'status',
  'durationMs',
  'userId',
  'tenantId',
  'correlationId',
  'ip',
  'userAgent',
] as const;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('access-log stream coherence (AUDITTRAIL-HIGH-004)', () => {
  it('AccessLogEntity declares every mandatory field', () => {
    const src = read(ENTITY_PATH);
    const missing: string[] = [];
    for (const field of MANDATORY_FIELDS) {
      const propRe = new RegExp(`\\b${field}\\s*[!?]?\\s*:`);
      if (!propRe.test(src)) {
        missing.push(field);
      }
    }
    expect(missing).toEqual([]);
  });

  it('AccessLogEntity declares schema:"shared" and table:"access_logs"', () => {
    const src = read(ENTITY_PATH);
    expect(src).toMatch(
      /@Entity\s*\(\s*['"]access_logs['"]\s*,\s*{\s*schema:\s*['"]shared['"]/,
    );
  });

  it('CreateAccessLogDto surfaces every middleware-emitted field', () => {
    const src = read(SERVICE_PATH);
    const ifaceRe =
      /export\s+interface\s+CreateAccessLogDto\s*{([\s\S]*?)\n}/;
    const match = ifaceRe.exec(src);
    expect(match).not.toBeNull();
    const body = match![1] ?? '';
    const missing: string[] = [];
    for (const field of MIDDLEWARE_EMITTED_FIELDS) {
      const present = new RegExp(`\\b${field}\\s*\\??\\s*:`).test(body);
      if (!present) {
        missing.push(field);
      }
    }
    expect(missing).toEqual([]);
  });

  it('AccessLogService.record persists every DTO field with documented null defaults', () => {
    const src = read(SERVICE_PATH);
    const recordBody = /record\s*\([^)]*\)\s*:\s*void\s*{([\s\S]*?)\n  }/.exec(
      src,
    );
    expect(recordBody).not.toBeNull();
    const body = recordBody![1] ?? '';

    // Required fields go through plain "field: dto.field" — no
    // null fallback (NOT NULL at the DB level).
    expect(body).toMatch(/method\s*:\s*dto\.method\b/);
    expect(body).toMatch(/path\s*:\s*dto\.path\b/);
    expect(body).toMatch(/status\s*:\s*dto\.status\b/);
    expect(body).toMatch(/durationMs\s*:\s*dto\.durationMs\b/);

    // Optional fields go through "field: dto.field ?? null".
    for (const field of [
      'userId',
      'tenantId',
      'correlationId',
      'ip',
      'userAgent',
    ]) {
      const re = new RegExp(`${field}\\s*:\\s*dto\\.${field}\\s*\\?\\?\\s*null`);
      expect(body).toMatch(re);
    }
  });

  describe('CreateSharedAccessLogs migration', () => {
    const src = read(MIGRATION_PATH);

    it.each(MANDATORY_FIELDS.filter((f) => f !== 'createdAt'))(
      'CREATE TABLE includes "%s" column',
      (field) => {
        const re = new RegExp(`"${field}"\\s+`);
        expect(src).toMatch(re);
      },
    );

    it('CREATE TABLE includes createdAt with timestamptz default now()', () => {
      expect(src).toMatch(/"createdAt"\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/);
    });

    it('uses transaction:none and CONCURRENTLY for indexes', () => {
      expect(src).toMatch(/transaction:\s*'none'\s*=\s*'none'/);
      expect(src).toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/);
    });

    it('declares NOT NULL on the four canonical request-shape columns', () => {
      expect(src).toMatch(/"method"\s+varchar\(8\)\s+NOT NULL/);
      expect(src).toMatch(/"path"\s+varchar\(2048\)\s+NOT NULL/);
      expect(src).toMatch(/"status"\s+integer\s+NOT NULL/);
      expect(src).toMatch(/"durationMs"\s+integer\s+NOT NULL/);
    });

    it('down() drops the table cleanly', () => {
      expect(src).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+shared\.access_logs/);
    });
  });

  it('AccessLogMiddleware emits every field via accessLogService.record({...})', () => {
    const src = read(MIDDLEWARE_PATH);
    const recordCall =
      /accessLogService\.record\s*\(\s*{([\s\S]*?)\n\s+}\s*\)/.exec(src);
    expect(recordCall).not.toBeNull();
    const body = recordCall![1] ?? '';

    for (const field of MIDDLEWARE_EMITTED_FIELDS) {
      const re = new RegExp(`\\b${field}\\s*[:,]`);
      expect(body).toMatch(re);
    }
  });

  it('AccessLogMiddleware uses res.on("finish") so emit is post-response', () => {
    const src = read(MIDDLEWARE_PATH);
    expect(src).toMatch(/res\.on\(\s*['"]finish['"]\s*,/);
  });

  it('AccessLogMiddleware routes IP through the canonical region-gated hashing helper', () => {
    const src = read(MIDDLEWARE_PATH);
    expect(src).toMatch(/shouldHashIp\s*\(/);
    expect(src).toMatch(/hashIpForGdpr\s*\(/);
  });
});
