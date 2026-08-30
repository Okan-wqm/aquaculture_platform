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

import { migrationCorpus } from './lib/migration-corpus';

const REPO_ROOT = resolve(__dirname, '..', '..');

const ENTITY_PATH = 'libs/backend-common/src/audit/access-log.entity.ts';
const SERVICE_PATH = 'libs/backend-common/src/audit/access-log.service.ts';
/**
 * The DB layer is the migration set admin-api-service ACTUALLY APPLIES, not a
 * named file.
 *
 * This spec used to read
 * `apps/admin-api-service/src/migrations/1788400000000-CreateSharedAccessLogs.ts`
 * directly. The 2026-05-18 squash moved that file to `.archive/`, where no
 * migration runs, so the suite stopped even LOADING — an ENOENT naming a file,
 * where the truth was that `shared.access_logs` had stopped being created while
 * the entity, the DTO, the middleware, `protected-tables.ts` and the RLS
 * infrastructure ledger all still declared it (ORPHAN-CRITICAL-516). Reading the
 * corpus means the next squash re-expresses the DDL without breaking this, and
 * a squash that DROPS it fails here instead of hiding.
 */
const MIGRATION_SOURCE = (): string => migrationCorpus('admin-api-service').source;
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
    const recordBody = /record\s*\([^)]*\)\s*:\s*void\s*[{]([\s\S]*?)\n {2}}/.exec(
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
    const src = MIGRATION_SOURCE();

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

    it('runs outside a transaction, because CONCURRENTLY cannot run inside one', () => {
      // THE PROPERTY, NOT ONE SPELLING OF IT. This asserted
      // `transaction: 'none' = 'none'` — a form TypeORM accepts and this
      // repository uses ZERO times; the canonical spelling here is
      // `transaction = false`, used by all nine non-transactional migrations
      // including the one this spec was written for. So the assertion could
      // never have passed against any migration the repo has ever contained,
      // which is presumably why the spec was parked as dormant rather than
      // fixed. Both spellings disable the wrapping transaction, so both satisfy
      // the requirement that CREATE INDEX CONCURRENTLY has.
      expect(src).toMatch(/transaction\s*(?:=\s*false|:\s*'none'\s*=\s*'none')/);
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
