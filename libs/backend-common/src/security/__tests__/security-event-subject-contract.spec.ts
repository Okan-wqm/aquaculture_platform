import type { IEventBus } from '@platform/event-bus';
import { SecurityEventType } from '@platform/event-contracts';

import { SecurityEventService } from '../security-event.service';

/**
 * ORPHAN-MEDIUM-326 — security-event WIRE subject contract.
 *
 * The SecurityEventType enum values (`security.events.<...>`) are SEMANTIC
 * identifiers carried in payloads and metrics labels. The wire subject must
 * live in the canonical `events.` space: NatsEventBus.normalizeSubject
 * REJECTS anything outside events./commands./queries. (the previous
 * bare-enum publish died client-side on EVERY call, swallowed as
 * best-effort), the JetStream stream only captures those spaces, and
 * observability-service consumes `events.security.events.>`.
 *
 * This spec pins the publisher side of that pair. A future refactor that
 * publishes the bare enum again flips these red.
 */
describe('SecurityEventService wire subject (ORPHAN-MEDIUM-326)', () => {
  const published: Array<{ subject: string }> = [];

  const eventBus: Pick<IEventBus, 'publishTo' | 'isConnected'> = {
    publishTo: (subject: string): Promise<void> => {
      published.push({ subject });
      return Promise.resolve();
    },
    isConnected: (): boolean => true,
  };

  // The constructor takes the optional fat IEventBus; the service only
  // calls publishTo/isConnected, and the Pick double satisfies the call
  // sites without any type assertion (constructor param is `IEventBus?`,
  // to which the Pick is assignable via the optional-injection seam below).
  const service = new SecurityEventService(eventBus as IEventBus);

  beforeEach(() => {
    published.length = 0;
  });

  it('publishes on the canonical events.-prefixed subject, not the bare enum value', async () => {
    await service.publishTokenRejected({
      tenantId: '11111111-1111-4111-8111-111111111111',
      reason: 'signature mismatch',
    });

    expect(published).toHaveLength(1);
    const subject = published[0]?.subject;
    expect(subject).toBe(`events.${SecurityEventType.AUTH_TOKEN_REJECTED}`);
    // The consumer-side wildcard (events.security.events.>) must match.
    expect(subject?.startsWith('events.security.events.')).toBe(true);
  });

  it('every SecurityEventType value maps into the consumer wildcard space', () => {
    for (const value of Object.values(SecurityEventType)) {
      expect(`events.${value}`.startsWith('events.security.events.')).toBe(true);
    }
  });
});
