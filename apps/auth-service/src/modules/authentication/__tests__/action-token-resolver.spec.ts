/**
 * ActionTokenResolver — the one way an emailed link segment becomes a token
 * lookup (SEC-HIGH-056). These tests pin the resolution rules, not a DB.
 */
import { EntityManager } from 'typeorm';

import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../entities/action-token.entity';
import { ActionTokenResolver } from '../services/action-token-resolver.service';

const ACTION_TOKEN_ID = '3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';
const RAW_TOKEN = 'a'.repeat(64);

function actionToken(overrides: Partial<ActionToken> = {}): ActionToken {
  return Object.assign(new ActionToken(), {
    id: ACTION_TOKEN_ID,
    purpose: ActionTokenPurpose.INVITATION,
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    tokenHash: 'b'.repeat(64),
    status: ActionTokenStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

describe('ActionTokenResolver', () => {
  const findOne = jest.fn();
  const manager: Pick<EntityManager, 'findOne'> = { findOne };
  const resolver = new ActionTokenResolver();

  beforeEach(() => {
    findOne.mockReset();
  });

  it('resolves a UUID segment to its ActionToken row by id and purpose', async () => {
    const row = actionToken();
    findOne.mockResolvedValue(row);

    const resolution = await resolver.resolve(
      ACTION_TOKEN_ID,
      ActionTokenPurpose.INVITATION,
      manager as EntityManager,
      'none',
    );

    expect(resolution).toEqual({ kind: 'action-token', actionToken: row });
    expect(findOne).toHaveBeenCalledWith(ActionToken, {
      where: { id: ACTION_TOKEN_ID, purpose: ActionTokenPurpose.INVITATION },
    });
  });

  it('applies the pessimistic_write lock only when requested', async () => {
    findOne.mockResolvedValue(actionToken());

    await resolver.resolve(
      ACTION_TOKEN_ID,
      ActionTokenPurpose.PASSWORD_RESET,
      manager as EntityManager,
      'pessimistic_write',
    );

    expect(findOne).toHaveBeenCalledWith(ActionToken, {
      where: { id: ACTION_TOKEN_ID, purpose: ActionTokenPurpose.PASSWORD_RESET },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('returns unresolvable for a UUID with no row — a UUID is never hashed as a raw token', async () => {
    findOne.mockResolvedValue(null);

    const resolution = await resolver.resolve(
      ACTION_TOKEN_ID,
      ActionTokenPurpose.INVITATION,
      manager as EntityManager,
      'none',
    );

    expect(resolution).toEqual({ kind: 'unresolvable' });
  });

  it('resolves a 64-hex segment to raw-token with its sha256 (pre-deploy links, SEC-LOW-060)', async () => {
    const resolution = await resolver.resolve(
      RAW_TOKEN,
      ActionTokenPurpose.INVITATION,
      manager as EntityManager,
      'none',
    );

    expect(resolution).toEqual({ kind: 'raw-token', tokenHash: resolver.hashRawToken(RAW_TOKEN) });
    expect(resolver.hashRawToken(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('returns unresolvable for any other shape without touching the database', async () => {
    for (const segment of [
      '',
      'invalid-token',
      'a'.repeat(63),
      `${ACTION_TOKEN_ID}x`,
      '<script>',
    ]) {
      const resolution = await resolver.resolve(
        segment,
        ActionTokenPurpose.PASSWORD_RESET,
        manager as EntityManager,
        'pessimistic_write',
      );
      expect(resolution).toEqual({ kind: 'unresolvable' });
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  it('builds the emailed link from the row id, never from the token hash or a raw secret', () => {
    const url = resolver.buildActionUrl('https://app.example.com', actionToken());

    expect(url).toBe(`https://app.example.com/accept-invitation/${ACTION_TOKEN_ID}`);
    expect(url).not.toContain('b'.repeat(64));
  });

  it('maps INVITATION and PASSWORD_RESET to their frontend routes and nothing else', () => {
    expect(resolver.urlPathFor(ActionTokenPurpose.INVITATION)).toBe('accept-invitation');
    expect(resolver.urlPathFor(ActionTokenPurpose.PASSWORD_RESET)).toBe('reset-password');
    expect(Object.values(ActionTokenPurpose)).toHaveLength(2);
  });
});
