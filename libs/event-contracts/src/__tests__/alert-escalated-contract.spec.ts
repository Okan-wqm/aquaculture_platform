import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ALERT_ESCALATED_EVENT_VERSION } from '../alert-events';
import { PLATFORM_EVENT_REGISTRY } from '../platform-event-registry';
import { LEGACY_EVENT_SHAPE_MARKER } from '../upcasters';
import {
  checkAlertEscalatedEvent,
  checkAlertRecipientQuery,
  checkAlertRecipientResult,
} from '../schemas/alert-events.schema';

/**
 * ALERT-CRITICAL-004 — the alarm delivery hand-off is a checked contract. The
 * registry's fixture is what alert-engine produces and notification-service
 * accepts; this spec keeps the fixture, the schema and the registry in step.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const fixture: unknown = JSON.parse(
  readFileSync(resolve(REPO_ROOT, PLATFORM_EVENT_REGISTRY.AlertEscalated.fixture), 'utf8'),
);

describe('AlertEscalated contract', () => {
  it('accepts the registry fixture', () => {
    // SCENARIO: the canonical escalation of a critical water-quality incident.
    // EXPECTS: it passes the boundary schema notification-service enforces.
    expect(checkAlertEscalatedEvent(fixture)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    ['an undeliverable channel', { channels: ['sms'] }],
    ['a platform operator as target role', { tenantWideRecipientRoles: ['SUPER_ADMIN'] }],
    ['a nested payload (flat events only)', { payload: { title: 'x' } }],
    ['a missing site key', { siteId: undefined }],
  ])('refuses %s', (_label, change) => {
    // SCENARIO: a producer drifts from the contract.
    // EXPECTS: refused with a reason, never half-delivered.
    const drifted = JSON.parse(JSON.stringify({ ...(fixture as object), ...change }));
    const result = checkAlertEscalatedEvent(drifted);
    expect(result.ok).toBe(false);
  });

  it('admits only the delivery-carrying version (V-S1a-11)', () => {
    // SCENARIO: a producer that forgot to stamp ALERT_ESCALATED_EVENT_VERSION.
    // EXPECTS: refused — the createBaseEvent default (1) would be upcast to 2, the
    //          version of the pre-delivery shape.
    const drifted = { ...(fixture as object), version: 1 };
    expect(checkAlertEscalatedEvent(drifted).ok).toBe(false);
    expect(ALERT_ESCALATED_EVENT_VERSION).toBe(3);
  });

  it("refuses the terminal upcaster's legacy marker with a legacy-shape reason", () => {
    const legacy = { ...(fixture as object), [LEGACY_EVENT_SHAPE_MARKER]: 'AlertEscalated<=v2' };
    expect(checkAlertEscalatedEvent(legacy)).toEqual({
      ok: false,
      reason: expect.stringContaining('legacy'),
    });
  });

  it('keeps the recipient expansion to ids only, in both directions', () => {
    // SCENARIO: the notification → auth recipient query and its answer.
    // EXPECTS: a well-formed query passes; an answer carrying anything but ids fails.
    expect(
      checkAlertRecipientQuery({
        tenantWideRoles: ['TENANT_ADMIN'],
        siteRoles: ['MODULE_MANAGER'],
        siteId: null,
        userIds: [],
      }).ok,
    ).toBe(true);
    expect(checkAlertRecipientResult({ userIds: [], truncated: false }).ok).toBe(true);
    expect(checkAlertRecipientResult({ userIds: [], truncated: false, emails: ['a@b.c'] }).ok).toBe(
      false,
    );
  });
});
