import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';

/**
 * Who issued a write that sensor-service keeps as a record a person reads
 * later: a program deployment, a feeding parameter set, a drive command, a
 * calibration.
 *
 * WHY both fields: `userId` (the JWT subject) is the identity checks compare
 * — the rollback four-eyes rule matches deployer against rollback initiator
 * by it. `email` is what a reader of the record recognises; a UUID alone
 * names nobody. The record keeps the e-mail as it was when the person acted:
 * an audit trail says who acted then, not who holds the account now.
 */
export interface RecordedActor {
  readonly userId: string;
  readonly email?: string;
}

/** The authenticated caller as the actor of the record it is about to write. */
export function recordedActorOf(user: Pick<CurrentUserPayload, 'sub' | 'email'>): RecordedActor {
  return { userId: user.sub, email: user.email };
}
