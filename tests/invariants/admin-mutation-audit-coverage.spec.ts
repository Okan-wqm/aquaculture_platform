/**
 * INVARIANT — every admin-api mutation handler is audited by the awaited,
 * transaction-aware interceptor (ADMIN-CRITICAL-008).
 *
 * Until 2026-09-05 admin-api-service had 246 POST/PUT/PATCH/DELETE handlers
 * and zero @AuditedOperation decorators; the only audit rows were the ones a
 * handful of handlers wrote by hand through a writer that swallowed
 * failures. This spec reflects on every controller in the service:
 *
 *   1. A handler decorated @Post/@Put/@Patch/@Delete must also carry
 *      @AuditedOperation in the same decorator block, or be listed in the
 *      governed ratchet `.claude/allowlists/admin-unaudited-mutations.yaml`
 *      with owner, future expiry, findingId and reason.
 *   2. Every ratchet entry must name a handler that is genuinely unaudited;
 *      decorating a handler without removing its entry fails, so the list
 *      only shrinks.
 *   3. The service registers AuditedOperationModule.forRoot() (the decorator
 *      is inert metadata otherwise) and lists AuditLogEntity in its TypeORM
 *      metadata (the interceptor writes through getRepository).
 */

import * as yaml from 'js-yaml';

import {
  ADMIN_SERVICE_SRC,
  adminControllerFiles,
  adminMutationHandlers,
  readRepoFile as read,
  stripComments,
  type AdminMutationHandler,
} from './lib/admin-mutation-handlers';

const ALLOWLIST = '.claude/allowlists/admin-unaudited-mutations.yaml';
const SERVICE_SRC = ADMIN_SERVICE_SRC;

interface AllowlistEntry {
  handler: string;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

/** Whether the handler's own decorator block audits it. */
function isAudited(handler: AdminMutationHandler): boolean {
  return /@AuditedOperation\(/.test(handler.block);
}

describe('INVARIANT (ADMIN-CRITICAL-008): every admin mutation handler is audited', () => {
  const files = adminControllerFiles();
  const handlers = files.flatMap(adminMutationHandlers);
  const unaudited = handlers
    .filter((h) => !isAudited(h))
    .map((h) => h.id)
    .sort();
  const doc = yaml.load(read(ALLOWLIST)) as { entries?: AllowlistEntry[] };
  const entries = doc.entries ?? [];

  it('reflects on the fleet of admin controllers (sanity)', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(handlers.length).toBeGreaterThanOrEqual(200);
  });

  it('every unaudited mutation handler is governed by the ratchet', () => {
    const governed = new Set(entries.map((e) => e.handler));
    expect(unaudited.filter((id) => !governed.has(id))).toEqual([]);
  });

  it('the ratchet names only handlers that are genuinely unaudited, with owner, future expiry and finding', () => {
    const today = new Date().toISOString().slice(0, 10);
    const actual = new Set(unaudited);
    for (const entry of entries) {
      expect(actual.has(entry.handler)).toBe(true);
      expect(entry.owner).toMatch(/\S/);
      expect(entry.findingId).toMatch(/^[A-Z]+-[A-Z]+-\d+$/);
      expect(entry.reason).toMatch(/\S/);
      const expiry =
        entry.expiry instanceof Date ? entry.expiry.toISOString().slice(0, 10) : entry.expiry;
      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(expiry > today).toBe(true);
    }
  });

  it('the service registers the interceptor and the shared audit entity', () => {
    const appModule = stripComments(read(`${SERVICE_SRC}/app.module.ts`));
    expect(appModule).toMatch(/AuditedOperationModule\.forRoot\(\)/);
    const auditModule = stripComments(read(`${SERVICE_SRC}/audit/audit.module.ts`));
    expect(auditModule).toMatch(/forFeature\(\[[^\]]*\bAuditLogEntity\b[^\]]*\]\)/);
  });
});
