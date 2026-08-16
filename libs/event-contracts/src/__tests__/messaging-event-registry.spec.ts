import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MESSAGING_EVENT_REGISTRY,
  MESSAGING_EVENT_TYPES,
  getMessagingEventContract,
  isMessagingEventType,
  validateMessagingEvent,
} from '../index';

const uuid = '550e8400-e29b-41d4-a716-446655440000';

function legalHoldReleasedFixture(): Record<string, unknown> {
  const fixturePath = join(__dirname, '..', '..', 'fixtures', 'legal-hold-released.v1.json');
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
}

function base(eventType: string): Record<string, string | number> {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    eventType,
    timestamp: '2026-05-30T00:00:00.000Z',
    tenantId: uuid,
    version: 1,
  };
}

describe('messaging event registry', () => {
  it('declares canonical tenant subjects for every messaging event', () => {
    for (const eventType of MESSAGING_EVENT_TYPES) {
      const contract = getMessagingEventContract(eventType);
      expect(contract.subject).toBe(`events.{tenantId}.${eventType}`);
      expect(contract.producer).toBe('messaging-service');
      expect(contract.requiredPayloadFields.length).toBeGreaterThan(0);
    }
  });

  it('is the runtime SSOT for known event types', () => {
    expect(isMessagingEventType('MessageForwarded')).toBe(true);
    expect(isMessagingEventType('events.MessageForwarded')).toBe(false);
    expect(Object.keys(MESSAGING_EVENT_REGISTRY).sort()).toEqual([...MESSAGING_EVENT_TYPES].sort());
  });

  it('marks forwarded source metadata as internal-only', () => {
    const contract = MESSAGING_EVENT_REGISTRY.MessageForwarded;
    expect(contract.internalOnlyFields).toEqual(['sourceMessageId', 'sourceChannelId']);
    expect(contract.websocketPublicFields).not.toContain('sourceMessageId');
    expect(contract.websocketPublicFields).not.toContain('sourceChannelId');
  });

  it('validates ReactionRemoved channel context as required', () => {
    const valid = validateMessagingEvent('ReactionRemoved', {
      ...base('ReactionRemoved'),
      channelId: uuid,
      messageId: uuid,
      userId: uuid,
      emoji: ':thumbsup:',
    });
    expect(valid).toEqual({ valid: true });

    const invalid = validateMessagingEvent('ReactionRemoved', {
      ...base('ReactionRemoved'),
      messageId: uuid,
      userId: uuid,
      emoji: ':thumbsup:',
    });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.errors).toContain("must have required property 'channelId'");
    }
  });

  it('rejects forwarded source metadata on public websocket projection', () => {
    const contract = MESSAGING_EVENT_REGISTRY.MessageForwarded;
    const internal = new Set<string>(contract.internalOnlyFields ?? []);
    for (const field of contract.websocketPublicFields ?? []) {
      expect(internal.has(field)).toBe(false);
    }
  });

  it('validates the versioned legal-hold release evidence fixture exactly', () => {
    const fixture = legalHoldReleasedFixture();

    expect(validateMessagingEvent('LegalHoldReleased', fixture)).toEqual({ valid: true });
    expect(MESSAGING_EVENT_REGISTRY.LegalHoldReleased.requiredPayloadFields).toEqual([
      'holdId',
      'scope',
      'resourceId',
      'legalMatterId',
      'releaseOperationId',
      'releaseRequestedBy',
      'releaseAuthorizedBy',
      'releaseReason',
      'releasedAtIso',
    ]);
  });

  it('rejects release payload drift and any non-v1 release event', () => {
    const fixture = legalHoldReleasedFixture();

    expect(
      validateMessagingEvent('LegalHoldReleased', {
        ...fixture,
        activationReason: 'the original hold reason must not cross the release boundary',
      }).valid,
    ).toBe(false);
    expect(validateMessagingEvent('LegalHoldReleased', { ...fixture, version: 2 }).valid).toBe(
      false,
    );
    expect(
      validateMessagingEvent('LegalHoldReleased', { ...fixture, resourceId: uuid }).valid,
    ).toBe(false);
    expect(
      validateMessagingEvent('LegalHoldReleased', {
        ...fixture,
        scope: 'channel',
        resourceId: null,
      }).valid,
    ).toBe(false);
  });

  it('accepts null channel scope for tenant-wide legal-hold activation', () => {
    const result = validateMessagingEvent('LegalHoldToggled', {
      ...base('LegalHoldToggled'),
      holdId: uuid,
      channelId: null,
      activate: true,
      reason: 'Preserve all tenant messaging records for active litigation.',
      toggledBy: uuid,
      toggledAt: '2026-08-16T00:00:00.000Z',
    });

    expect(result).toEqual({ valid: true });
  });

  it('rejects release semantics through the activation-only event', () => {
    const result = validateMessagingEvent('LegalHoldToggled', {
      ...base('LegalHoldToggled'),
      holdId: uuid,
      channelId: null,
      activate: false,
      reason: 'This release must use the LegalHoldReleased v1 evidence contract.',
      toggledBy: uuid,
      toggledAt: '2026-08-16T00:00:00.000Z',
    });

    expect(result.valid).toBe(false);
  });
});
