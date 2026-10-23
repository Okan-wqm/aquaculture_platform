import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { RecoveryEscrowState } from '../entities/recovery-key-escrow.entity';

registerEnumType(RecoveryEscrowState, {
  name: 'RecoveryEscrowState',
  description:
    'Whether an escrowed /data recovery envelope is the current one of its volume or was superseded',
});

/**
 * An escrowed `/data` recovery envelope as the console lists it: who it is for and what
 * became of it, never the ciphertext (ADR-048 DEC-14.3).
 */
@ObjectType('RecoveryKeyEscrowStatus')
export class RecoveryKeyEscrowStatusType {
  @Field(() => ID)
  id!: string;

  @Field()
  volumeUuid!: string;

  /** sha256 of the SubjectPublicKeyInfo of the escrow key the envelope is encrypted to. */
  @Field()
  recipientSpkiSha256!: string;

  @Field(() => RecoveryEscrowState)
  state!: RecoveryEscrowState;

  @Field()
  receivedAt!: Date;

  @Field(() => Date, { nullable: true })
  supersededAt!: Date | null;

  /** How many times an administrator has taken this envelope out. */
  @Field(() => Int)
  retrievals!: number;
}

/**
 * An envelope an administrator took out for the custodians to open in the offline HSM:
 * the document the device wrote, as JSON text. The retrieval is already on record.
 */
@ObjectType('RetrievedRecoveryEscrow')
export class RetrievedRecoveryEscrowType {
  @Field(() => ID)
  escrowId!: string;

  @Field(() => ID)
  deviceId!: string;

  @Field()
  receivedAt!: Date;

  /** The `suderra.data-recovery-escrow.v1` document, exactly as the device wrote it. */
  @Field()
  envelope!: string;
}
