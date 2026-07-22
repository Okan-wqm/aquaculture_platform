/**
 * APA-162 — admin messaging-audit action filter vocabulary parity (RC-5).
 *
 * The messaging audit action vocabulary is the backend `ComplianceAction` enum
 * (apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts),
 * stored in `compliance_audit_log.action`. The MessagingAuditPage filter dropdown
 * previously offered hand-typed lowercase verbs (send/edit/delete/create_channel/
 * join_channel/leave_channel/upload_file) that shared no value with the stored
 * enum, so the action filter could never actually narrow the result — false
 * assurance on a SUPER_ADMIN compliance surface.
 *
 * The FE now mirrors the vocabulary in `COMPLIANCE_ACTIONS`
 * (web/modules/admin-panel/src/services/api/messaging.ts). admin-panel is a
 * federated remote and cannot import the backend entity, so this gate binds the
 * mirror to the enum by static parsing: the mirror must equal the backend
 * vocabulary exactly (so a new ComplianceAction forces a mirror update and a
 * bogus value is rejected), and the dead lowercase verbs must not reappear.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const BACKEND_ENTITY =
  'apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts';
const FE_MIRROR = 'web/modules/admin-panel/src/services/api/messaging.ts';

function backendComplianceActions(): Set<string> {
  const src = read(BACKEND_ENTITY);
  const block = /export enum ComplianceAction\s*\{([\s\S]*?)\}/.exec(src);
  if (block === null) throw new Error('ComplianceAction enum not found');
  return new Set([...(block[1] ?? '').matchAll(/=\s*'([^']+)'/g)].map((m) => m[1] ?? ''));
}

function feMirrorActions(): string[] {
  const src = read(FE_MIRROR);
  const block = /COMPLIANCE_ACTIONS[\s\S]*?=\s*\[([\s\S]*?)\]\s*as const;/.exec(src);
  if (block === null) throw new Error('COMPLIANCE_ACTIONS mirror not found in messaging.ts');
  return [...(block[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('admin messaging-audit action vocabulary parity (APA-162)', () => {
  const backend = backendComplianceActions();

  it('every mirrored action is a real backend ComplianceAction value', () => {
    const values = feMirrorActions();
    expect(values.length).toBeGreaterThan(0);
    const bogus = values.filter((v) => !backend.has(v));
    expect(bogus).toEqual([]);
  });

  it('the mirror covers the whole backend ComplianceAction vocabulary', () => {
    const values = new Set(feMirrorActions());
    const missing = [...backend].filter((v) => !values.has(v));
    expect(missing).toEqual([]);
  });

  it('the dead hand-typed lowercase verbs are gone from the mirror', () => {
    const values = feMirrorActions();
    for (const dead of [
      'send',
      'edit',
      'delete',
      'create_channel',
      'join_channel',
      'leave_channel',
      'upload_file',
    ]) {
      expect(values).not.toContain(dead);
    }
  });
});
