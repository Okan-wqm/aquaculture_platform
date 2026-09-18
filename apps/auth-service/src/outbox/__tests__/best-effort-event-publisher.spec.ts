import { BaseEvent, createBaseEvent } from '@platform/event-contracts';

import { BestEffortEventPublisher, EventPublishPort } from '../best-effort-event-publisher';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const makeEvent = (eventType: string): BaseEvent =>
  createBaseEvent(eventType, TENANT_ID, { aggregateId: TENANT_ID, aggregateType: 'User' });

describe('BestEffortEventPublisher', () => {
  // Typed against the segregated port — a one-method double, no cast.
  let eventBus: EventPublishPort & { publish: jest.Mock };
  let publisher: BestEffortEventPublisher;

  beforeEach(() => {
    eventBus = { publish: jest.fn().mockResolvedValue(undefined) };
    publisher = new BestEffortEventPublisher(eventBus);
  });

  it.each([
    'UserLoggedIn',
    'UserProfileUpdated',
    'UserPasswordChanged',
    'PasswordResetCompleted',
    'InvitationAccepted',
    'UserInvited',
  ])('publishes the allowlisted telemetry/audit-backed event %s', async (eventType) => {
    const event = makeEvent(eventType);
    await publisher.publish(event);
    expect(eventBus.publish).toHaveBeenCalledWith(event);
  });

  it.each(['TenantCreated', 'TenantStatusChanged', 'UserDeleted', 'TenantSuspended'])(
    'REFUSES the durable-required event %s (must use the outbox)',
    async (eventType) => {
      await expect(publisher.publish(makeEvent(eventType))).rejects.toThrow(
        /not allowlisted for the lossy best-effort path/,
      );
      expect(eventBus.publish).not.toHaveBeenCalled();
    },
  );

  it('swallows a downstream publish failure (best-effort never fails the operation)', async () => {
    eventBus.publish.mockRejectedValueOnce(new Error('NATS unavailable'));
    await expect(publisher.publish(makeEvent('UserLoggedIn'))).resolves.toBeUndefined();
  });

  it('the allowlist refusal fires BEFORE any publish attempt', async () => {
    await expect(publisher.publish(makeEvent('TenantSuspended'))).rejects.toThrow();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
