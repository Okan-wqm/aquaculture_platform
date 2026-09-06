import { createHash, randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../entities/action-token.entity';
import { resolveActionReference } from './action-token-reference';

describe('emailed action reference', () => {
  it('resolves the exact same opaque action id for validation and locked redemption', async () => {
    const manager = new DataSource({ type: 'postgres' }).manager;
    const token = Object.assign(new ActionToken(), {
      id: randomUUID(),
      userId: randomUUID(),
      tokenHash: 'persisted-hash',
      purpose: ActionTokenPurpose.INVITATION,
      status: ActionTokenStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const findOne = jest.spyOn(manager, 'findOne').mockResolvedValue(token);
    const validation = await resolveActionReference(
      manager,
      token.id,
      ActionTokenPurpose.INVITATION,
    );
    const redemption = await resolveActionReference(
      manager,
      token.id,
      ActionTokenPurpose.INVITATION,
      true,
    );
    expect(validation.tokenHashes).toEqual(['persisted-hash']);
    expect(redemption.tokenHashes).toEqual(validation.tokenHashes);
    expect(findOne).toHaveBeenLastCalledWith(ActionToken, {
      where: { id: token.id, purpose: ActionTokenPurpose.INVITATION },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it.each([ActionTokenStatus.CONSUMED, ActionTokenStatus.REVOKED, ActionTokenStatus.EXPIRED])(
    'rejects an action in %s state without falling back to a raw token',
    async (status) => {
      const manager = new DataSource({ type: 'postgres' }).manager;
      const token = Object.assign(new ActionToken(), {
        id: randomUUID(),
        status,
        expiresAt: new Date(Date.now() + 60_000),
      });
      jest.spyOn(manager, 'findOne').mockResolvedValue(token);
      await expect(
        resolveActionReference(manager, token.id, ActionTokenPurpose.INVITATION),
      ).rejects.toThrow('Invalid or expired');
    },
  );

  it('rejects an unknown UUID instead of hashing it as a legacy invitation', async () => {
    const manager = new DataSource({ type: 'postgres' }).manager;
    jest.spyOn(manager, 'findOne').mockResolvedValue(null);
    await expect(
      resolveActionReference(manager, randomUUID(), ActionTokenPurpose.INVITATION),
    ).rejects.toThrow('Invalid or expired');
  });

  it('keeps actual historical random-token links on their original lookup representation', async () => {
    const manager = new DataSource({ type: 'postgres' }).manager;
    const findOne = jest.spyOn(manager, 'findOne');
    const token = 'a'.repeat(64);
    const reference = await resolveActionReference(
      manager,
      token,
      ActionTokenPurpose.PASSWORD_RESET,
    );
    expect(reference.tokenHashes).toEqual([
      createHash('sha256').update(token).digest('hex'),
      token,
    ]);
    expect(findOne).not.toHaveBeenCalled();
  });
});
