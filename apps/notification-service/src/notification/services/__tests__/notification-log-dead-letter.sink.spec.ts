import type { DeadLetterRecord } from '@platform/event-bus';

import { NotificationChannel, NotificationStatus } from '../../entities/notification-log.entity';
import { NotificationLogDeadLetterSink } from '../notification-log-dead-letter.sink';

/**
 * PLAT-HIGH-902 — the bus's dead-letter sink for notification-service writes
 * the same NotificationLog DEAD_LETTER row the admin panel and the health
 * count already read, as a redacted summary (hash + replay handle), never
 * the raw payload.
 */
describe('NotificationLogDeadLetterSink (PLAT-HIGH-902)', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  function record(overrides: Partial<DeadLetterRecord> = {}): DeadLetterRecord {
    return {
      subject: 'events.*.PasswordResetRequested',
      event: {
        eventId: '55555555-5555-4555-8555-555555555555',
        eventType: 'PasswordResetRequested',
        timestamp: '2026-09-05T12:00:00.000Z',
        tenantId: TENANT,
        version: 2,
      },
      reason: 'PasswordResetRequested: legacy shape carrying PII',
      disposition: 'terminated',
      deliveryCount: 1,
      maxDeliver: 3,
      terminatedAt: '2026-09-05T12:00:01.000Z',
      ...overrides,
    };
  }

  it('persists a redacted DEAD_LETTER row with hash, replay handle and delivery position', async () => {
    const repository = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const sink = new NotificationLogDeadLetterSink(repository as never);

    await sink.record(record({ cause: new Error('boom') }));

    expect(repository.save).toHaveBeenCalledTimes(1);
    const row = repository.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        channel: NotificationChannel.SYSTEM,
        recipient: 'dlq',
        subject: 'DLQ: PasswordResetRequested',
        content: 'PasswordResetRequested: legacy shape carrying PII',
        status: NotificationStatus.DEAD_LETTER,
        retryCount: 1,
        metadata: expect.objectContaining({
          originalEventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          replayHandle: `PasswordResetRequested:${TENANT}:55555555-5555-4555-8555-555555555555`,
          subject: 'events.*.PasswordResetRequested',
          disposition: 'terminated',
          deliveryCount: 1,
          maxDeliver: 3,
          eventType: 'PasswordResetRequested',
        }),
      }),
    );
    expect(String(row.errorMessage)).toContain('boom');
    // The raw event never lands in the row.
    expect(JSON.stringify(row)).not.toContain('"version":2');
  });

  it('records a retry-exhausted message with the platform segment as its tenant', async () => {
    const repository = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const sink = new NotificationLogDeadLetterSink(repository as never);

    await sink.record(
      record({
        event: { ...record().event, tenantId: 'system' },
        disposition: 'retry-exhausted',
        deliveryCount: 3,
        reason: 'retry budget exhausted after 3 deliveries: smtp 503',
      }),
    );

    const row = repository.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toEqual(
      expect.objectContaining({
        tenantId: 'system',
        retryCount: 3,
        metadata: expect.objectContaining({ disposition: 'retry-exhausted', deliveryCount: 3 }),
      }),
    );
  });
});
