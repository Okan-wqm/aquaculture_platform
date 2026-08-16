import type { EntityManager } from 'typeorm';
import {
  mutationInstantDateV1,
  pinTenantMutationInstantV1,
  type MutationInstantV1,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { mintMutationInstantV1 } from '@aquaculture/backend-common/database/mutation-instant-authority';
import {
  type FeedingOperationEnvelopeArtifactV1,
  type FeedingTimezone,
} from '@aquaculture/feeding-contracts';

const FEEDING_OPERATION_SESSION_BRAND: unique symbol = Symbol();

export interface FeedingOperationSession {
  readonly [FEEDING_OPERATION_SESSION_BRAND]: true;
}

export interface VerifiedFeedingOperationSession {
  readonly manager: EntityManager;
  readonly mutationSession: TenantMutationSession;
  readonly tenantId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly operationEnvelope: FeedingOperationEnvelopeArtifactV1;
  readonly mutationInstant: MutationInstantV1;
  readonly localDate: string;
  readonly timezone: FeedingTimezone;
  readonly siteId: string | null;
  readonly unitId: string | null;
}

const VERIFIED_SESSIONS = new WeakMap<object, VerifiedFeedingOperationSession>();

type FeedingOperationSessionMintInput = Omit<VerifiedFeedingOperationSession, 'mutationInstant'>;

/** Mint authority: imported only by the coordinator kernel (CI invariant). */
export function mintFeedingOperationSession(
  verified: FeedingOperationSessionMintInput,
): FeedingOperationSession {
  const mutationInstant = mintMutationInstantV1(
    'persisted_feeding_operation',
    verified.operationEnvelope.envelope.observedAt,
  );
  pinTenantMutationInstantV1(verified.mutationSession, 'farm', mutationInstant);
  const session = Object.freeze({}) as FeedingOperationSession;
  VERIFIED_SESSIONS.set(
    session,
    Object.freeze({
      ...verified,
      mutationInstant,
    }),
  );
  return session;
}

/** Read authority: imported only by the exact bounded handler set (CI invariant). */
export function readFeedingOperationSession(
  session: FeedingOperationSession,
): VerifiedFeedingOperationSession {
  const verified = VERIFIED_SESSIONS.get(session);
  if (!verified) {
    throw new Error('Unminted feeding operation session rejected');
  }
  return verified;
}

/** Returns a fresh Date projection; mutation cannot alter the immutable envelope instant. */
export function feedingOperationObservedAt(verified: VerifiedFeedingOperationSession): Date {
  return mutationInstantDateV1(verified.mutationInstant);
}

/** Opaque mutation-clock capability derived only from the persisted intent envelope. */
export function feedingOperationMutationInstant(
  verified: VerifiedFeedingOperationSession,
): MutationInstantV1 {
  return verified.mutationInstant;
}
