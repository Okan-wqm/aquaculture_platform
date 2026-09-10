/**
 * INVARIANT (ADMIN-CRITICAL-150): the admin panel's messaging-audit action
 * vocabulary equals `ComplianceAction`, in both directions.
 *
 * `MessagingAuditPage` offered seven actions — `send`, `edit`, `delete`,
 * `create_channel`, `join_channel`, `leave_channel`, `upload_file` — and not
 * one of them is a member of `ComplianceAction`. Every action filter therefore
 * returned nothing, permanently; the badge colour map keyed on the same seven,
 * so every real row rendered with the fallback grey; and the four actions an
 * auditor actually comes for — `message_export`, `data_anonymize`,
 * `retention_set`, `legal_hold_toggle` — were not offered at all.
 *
 * The enum belongs to messaging-service and reaches admin-api only as a NATS
 * reply, so nothing in admin's OpenAPI document carries it and admin-api may
 * not import another service's source (`admin-api-schema-boundaries`). The
 * vocabulary is therefore declared once on the frontend and pinned HERE — the
 * highest tier available when a type cannot cross the boundary: the wrong
 * value is caught at build time.
 *
 * Both directions matter. A member added to the enum and not to the panel is
 * an action an auditor cannot filter for; a value in the panel that the enum
 * lost is a filter that silently matches nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const ENTITY = join(
  REPO_ROOT,
  'apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts',
);
const PANEL_CLIENT = join(REPO_ROOT, 'web/modules/admin-panel/src/services/api/messaging.ts');
const PANEL_PAGE = join(
  REPO_ROOT,
  'web/modules/admin-panel/src/pages/messaging/MessagingAuditPage.tsx',
);

/** The string values of `enum ComplianceAction`, in declaration order. */
function enumMembers(): string[] {
  const source = readFileSync(ENTITY, 'utf8');
  const block = /export enum ComplianceAction \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (block === undefined) {
    throw new Error(`${ENTITY}: no \`export enum ComplianceAction\` block`);
  }
  return [...block.matchAll(/=\s*'([^']+)'/g)].flatMap((match) => match[1] ?? []);
}

/** The values of `MESSAGING_COMPLIANCE_ACTIONS`, in declaration order. */
function panelActions(): string[] {
  const source = readFileSync(PANEL_CLIENT, 'utf8');
  const block = /export const MESSAGING_COMPLIANCE_ACTIONS = \[([\s\S]*?)\n\] as const;/.exec(
    source,
  )?.[1];
  if (block === undefined) {
    throw new Error(`${PANEL_CLIENT}: no \`MESSAGING_COMPLIANCE_ACTIONS\` array`);
  }
  return [...block.matchAll(/'([^']+)'/g)].flatMap((match) => match[1] ?? []);
}

describe('INVARIANT (ADMIN-CRITICAL-150): messaging compliance action parity', () => {
  it('reads both sides, rather than passing because a file moved', () => {
    expect(enumMembers().length).toBeGreaterThan(0);
    expect(panelActions().length).toBeGreaterThan(0);
  });

  it('offers exactly the actions the column can hold', () => {
    // Set equality, not array equality: declaration order is presentation, and
    // the panel is free to group the compliance-relevant ones together.
    expect([...panelActions()].sort()).toEqual([...enumMembers()].sort());
  });

  it('gives every action a label and a badge, so none renders unstyled', () => {
    const page = readFileSync(PANEL_PAGE, 'utf8');
    const presentation = /const ACTION_PRESENTATION[\s\S]*?\n\};/.exec(page)?.[0];
    if (presentation === undefined) {
      throw new Error(`${PANEL_PAGE}: no \`ACTION_PRESENTATION\` map`);
    }
    const missing = enumMembers().filter((action) => !presentation.includes(`${action}:`));
    expect(missing).toEqual([]);
  });

  it('keeps the four compliance-critical actions in the vocabulary', () => {
    // These are what a GDPR or SOC 2 auditor asks the log for, and the
    // pre-fix filter offered none of them.
    expect(panelActions()).toEqual(
      expect.arrayContaining([
        'message_export',
        'data_anonymize',
        'retention_set',
        'legal_hold_toggle',
      ]),
    );
  });
});
