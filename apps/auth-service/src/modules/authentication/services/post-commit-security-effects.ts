import type { Logger } from '@nestjs/common';

export type PostCommitSecurityOperation =
  | 'password_change'
  | 'password_reset'
  | 'user_logout'
  | 'logout_all_devices';

export type PostCommitSecurityEffectType =
  | 'access_token_invalidation'
  | 'user_token_invalidation'
  | 'session_revocation';

export interface PostCommitSecurityEffect {
  type: PostCommitSecurityEffectType;
  apply: () => Promise<unknown>;
}

interface PostCommitSecurityEffectsInput {
  logger: Pick<Logger, 'error'>;
  operation: PostCommitSecurityOperation;
  effects: readonly PostCommitSecurityEffect[];
}

/**
 * Applies low-latency security effects after the authoritative database
 * transaction commits. The authoritative credential mutation and, where
 * applicable, its durable invalidation intent already exist at this point, so
 * an unavailable Redis/session store is an operational recovery signal rather
 * than evidence that the committed credential mutation failed.
 */
export async function settlePostCommitSecurityEffects(
  input: PostCommitSecurityEffectsInput,
): Promise<void> {
  const results = await Promise.allSettled(input.effects.map(({ apply }) => apply()));
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return [];
    }

    return [
      {
        effectType: input.effects[index]!.type,
        errorType: result.reason instanceof Error ? result.reason.name : 'UnknownError',
      },
    ];
  });

  if (failures.length === 0) {
    return;
  }

  input.logger.error(
    JSON.stringify({
      event: 'post_commit_security_effect_failed',
      operation: input.operation,
      failedCount: failures.length,
      effectCount: input.effects.length,
      failedEffectTypes: [...new Set(failures.map(({ effectType }) => effectType))],
      errorTypes: [...new Set(failures.map(({ errorType }) => errorType))],
    }),
  );
}
