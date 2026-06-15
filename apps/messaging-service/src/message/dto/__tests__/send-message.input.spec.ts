import 'reflect-metadata';

import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MessageContentType } from '../../entities/message.entity';
import { SendMessageInput } from '../send-message.input';

/**
 * MSG-CRITICAL-054 — offline sendMessage was rejected because SendMessageInput
 * did not extend MobileCommandEnvelopeInput, so the offline queue's injected
 * envelope fields were unknown to the gateway ValidationPipe
 * (whitelist + forbidNonWhitelisted) → 400 → message lost behind a false
 * "Queued" badge. These tests pin the fix: the envelope fields are part of the
 * input schema, while the whitelist still rejects genuinely unknown fields.
 */
const UUID = '11111111-1111-4111-8111-111111111111';

describe('SendMessageInput — mobile command envelope (MSG-CRITICAL-054)', () => {
  it('extends MobileCommandEnvelopeInput so offline-injected envelope fields are in the schema', () => {
    expect(new SendMessageInput()).toBeInstanceOf(MobileCommandEnvelopeInput);
  });

  it('accepts an offline send carrying the command envelope without a forbidNonWhitelisted rejection', async () => {
    const input = plainToInstance(SendMessageInput, {
      channelId: UUID,
      content: 'hello from an offline outbox replay',
      contentType: MessageContentType.TEXT,
      idempotencyKey: UUID,
      // The exact envelope attachCommandEnvelope() injects on every queued send:
      clientCommandId: UUID,
      clientCreatedAt: '2026-06-14T00:00:00.000Z',
      deviceId: UUID,
      operationType: 'sendMessage',
      payloadHash: 'a'.repeat(64),
      schemaVersion: 'v1',
    });

    const errors = await validate(input, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('still rejects a genuinely unknown field — the whitelist is not weakened', async () => {
    const input = plainToInstance(SendMessageInput, {
      channelId: UUID,
      contentType: MessageContentType.TEXT,
      idempotencyKey: UUID,
      bogusField: 'must be rejected',
    });

    const errors = await validate(input, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === 'bogusField')).toBe(true);
  });
});
