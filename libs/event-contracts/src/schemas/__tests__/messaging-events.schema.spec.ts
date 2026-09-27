/**
 * Messaging event JSON-Schema validator tests (MSGFIX-FAZ2 2.0).
 *
 * Pins the additive `MessageSent.isAiResponse` contract change:
 *   - a maximal human MessageSent (field absent) still validates — the
 *     addition is purely opt-in for legacy publishers;
 *   - `isAiResponse: true` (the AI bridge reply) validates — BEFORE Faz 2
 *     the undeclared field tripped additionalProperties:false and the
 *     gateway WS validator silently DROPPED every persisted AI reply, so
 *     AI answers reached the DB but never the socket;
 *   - `isAiResponse: 'yes'` (wrong type) rejects — the marker is strictly
 *     boolean;
 *   - the pre-existing strictness (unknown extra field, missing required
 *     field) still holds, so the relaxation did not open the envelope.
 */
import { MESSAGING_EVENT_SCHEMAS } from '../messaging-events.schema';
import { validateMessagingEvent, type MessagingEventValidationResult } from '../validator';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';

function messageSentFixture(payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    eventType: 'MessageSent',
    timestamp: '2026-09-16T12:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    messageId: MESSAGE_ID,
    channelId: CHANNEL_ID,
    senderId: USER_ID,
    contentType: 'text',
    hasAttachments: false,
    createdAt: '2026-09-16T12:00:00.000Z',
    ...payload,
  };
}

function validate(event: Record<string, unknown>): MessagingEventValidationResult {
  const eventType = typeof event['eventType'] === 'string' ? event['eventType'] : '';
  return validateMessagingEvent(eventType, JSON.parse(JSON.stringify(event)));
}

describe('MessageSent schema — isAiResponse (MSGFIX-FAZ2 2.0)', () => {
  it('MessageSent schema is declared', () => {
    expect(MESSAGING_EVENT_SCHEMAS['MessageSent']).toBeDefined();
  });

  it('accepts a human MessageSent with isAiResponse ABSENT (legacy publishers)', () => {
    const result = validate(messageSentFixture());
    expect(result.valid).toBe(true);
  });

  it('accepts the AI bridge reply with isAiResponse: true', () => {
    const result = validate(messageSentFixture({ isAiResponse: true }));
    expect(result.valid).toBe(true);
  });

  it('accepts an explicit isAiResponse: false', () => {
    const result = validate(messageSentFixture({ isAiResponse: false }));
    expect(result.valid).toBe(true);
  });

  it('rejects a non-boolean isAiResponse', () => {
    const result = validate(messageSentFixture({ isAiResponse: 'yes' }));
    expect(result.valid).toBe(false);
  });

  it('still rejects an unknown extra field (additionalProperties:false holds)', () => {
    const result = validate(messageSentFixture({ sneaky: '<script>' }));
    expect(result.valid).toBe(false);
  });

  it('still rejects a MessageSent missing a required field', () => {
    const event = messageSentFixture();
    delete event['senderId'];
    const result = validate(event);
    expect(result.valid).toBe(false);
  });
});

describe('MessageSent schema — isAiErrorNotice (MSGFIX-FAZ2 V1 MAJOR-2)', () => {
  it('accepts an AI error notice event (isAiResponse + isAiErrorNotice true)', () => {
    const result = validate(messageSentFixture({ isAiResponse: true, isAiErrorNotice: true }));
    expect(result.valid).toBe(true);
  });

  it('accepts isAiErrorNotice ABSENT (all legacy/AI-reply publishers)', () => {
    const result = validate(messageSentFixture({ isAiResponse: true }));
    expect(result.valid).toBe(true);
  });

  it("rejects isAiErrorNotice: 'yes' — strictly boolean", () => {
    const result = validate(messageSentFixture({ isAiResponse: true, isAiErrorNotice: 'yes' }));
    expect(result.valid).toBe(false);
  });
});
