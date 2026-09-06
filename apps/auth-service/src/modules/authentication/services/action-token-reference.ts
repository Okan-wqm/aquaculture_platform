import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ActionToken, ActionTokenPurpose } from '../entities/action-token.entity';

export interface ActionReference {
  readonly actionToken: ActionToken | null;
  readonly tokenHashes: string[];
}

/** All consumers of emailed action links resolve the opaque action id identically. */
export async function resolveActionReference(
  manager: EntityManager,
  token: string,
  purpose: ActionTokenPurpose,
  lock = false,
): Promise<ActionReference> {
  const isActionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token);
  if (isActionId) {
    const actionToken = await manager.findOne(ActionToken, { where: { id: token, purpose },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!actionToken || !actionToken.isActive()) throw new BadRequestException('Invalid or expired action token');
    return { actionToken, tokenHashes: [actionToken.tokenHash] };
  }
  // Historical links used the original random token; never reinterpret a missing opaque UUID as one.
  return { actionToken: null, tokenHashes: [createHash('sha256').update(token).digest('hex'), token] };
}
