/**
 * APA-224 (write-side tier-1) — the admin audit action is nominally typed.
 *
 * AuditLogInput.action was a free-form `string`, so every writer's action was a
 * per-call-site convention that could drift (and the FE audit filter matched
 * zero rows against real UPPERCASE_SNAKE values). It is now the `AuditAction`
 * enum: a string literal is not assignable, so an out-of-vocabulary action is a
 * compile error, not a persisted row. The explorer write-intent action, which
 * used to be built at runtime (`DATABASE_EXPLORER_${operation.toUpperCase()}_INTENT`)
 * — the blocker to nominal typing — is now a static enum map.
 *
 * This gate pins both so the type can't be loosened back to `string` and the
 * dynamic action can't reappear.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const AUDIT_SERVICE = 'apps/admin-api-service/src/audit/audit.service.ts';
const EXPLORER = 'apps/admin-api-service/src/database-management/controllers/explorer.controller.ts';

describe('admin AuditLogInput.action is nominally typed (APA-224 write-side)', () => {
  it('AuditLogInput.action is typed as AuditAction, not a free-form string', () => {
    const src = read(AUDIT_SERVICE);
    const block = /export interface AuditLogInput\s*\{([\s\S]*?)\n\}/.exec(src);
    expect(block).not.toBeNull();
    const body = block?.[1] ?? '';
    expect(/\baction:\s*AuditAction\b/.test(body)).toBe(true);
    expect(/\baction:\s*string\b/.test(body)).toBe(false);
  });

  it('the explorer write-intent action is a static enum member, not a runtime-built string', () => {
    const src = read(EXPLORER);
    // The old blocker: `DATABASE_EXPLORER_${operation.toUpperCase()}_INTENT`.
    expect(src.includes('DATABASE_EXPLORER_${')).toBe(false);
    expect(src.includes('AuditAction.DATABASE_EXPLORER_INSERT_INTENT')).toBe(true);
  });
});
