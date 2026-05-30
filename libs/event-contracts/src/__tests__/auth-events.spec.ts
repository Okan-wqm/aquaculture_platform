import { createBaseEvent, type UserDeletedEvent } from '../index';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const requesterId = '11111111-1111-4111-8111-111111111111';
const deletedUserId = '22222222-2222-4222-8222-222222222222';

describe('auth event contracts', () => {
  it('uses deletedUserId as the canonical UserDeleted target', () => {
    const event: UserDeletedEvent = {
      ...createBaseEvent<UserDeletedEvent>('UserDeleted', tenantId, {
        userId: requesterId,
      }),
      deletedUserId,
      hardDelete: false,
      cascadeRequested: true,
      initiatedBy: 'gdpr-erasure',
      cryptoShredKeyId: 'kms-key-1',
    };

    expect(event.userId).toBe(requesterId);
    expect(event.deletedUserId).toBe(deletedUserId);
    expect(event.deletedUserId).not.toBe(event.userId);
  });
});
