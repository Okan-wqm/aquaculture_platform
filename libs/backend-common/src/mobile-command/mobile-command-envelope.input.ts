import { Field, InputType } from '@nestjs/graphql';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Common mobile command envelope.
 *
 * Mobile clients generate these fields once when a command enters the durable
 * outbox, then reuse the same values for every retry. Server-side handlers can
 * persist them in command receipts to provide at-most-once semantics.
 */
@InputType({ isAbstract: true })
export abstract class MobileCommandEnvelopeInput {
  @Field({
    nullable: true,
    description: 'Stable client command UUID generated before first submission',
  })
  @IsOptional()
  @IsUUID()
  clientCommandId?: string;

  @Field({
    nullable: true,
    description: 'ISO timestamp when the mobile client created the command',
  })
  @IsOptional()
  @IsDateString()
  clientCreatedAt?: string;

  @Field({ nullable: true, description: 'Stable per-installation device identifier' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @Field({
    nullable: true,
    description: 'Mobile operation type, e.g. recordMortality or transferStock',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  operationType?: string;

  @Field({
    nullable: true,
    description: 'SHA-256 hash of the command payload before envelope fields are added',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  payloadHash?: string;

  @Field({ nullable: true, description: 'Optional mobile command payload schema version' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  schemaVersion?: string;
}

export interface MobileCommandEnvelope {
  clientCommandId?: string;
  clientCreatedAt?: string;
  deviceId?: string;
  operationType?: string;
  payloadHash?: string;
  schemaVersion?: string;
}

/**
 * Closed mobile mutation envelope: the durable command identity and payload
 * digest are mandatory at both the GraphQL schema and TypeScript boundaries.
 */
export interface RequiredMobileCommandEnvelope extends MobileCommandEnvelope {
  clientCommandId: string;
  payloadHash: string;
}

@InputType({ isAbstract: true })
export abstract class RequiredMobileCommandEnvelopeInput
  extends MobileCommandEnvelopeInput
  implements RequiredMobileCommandEnvelope
{
  @Field({ description: 'Stable client command UUID generated before first submission' })
  @IsUUID()
  override clientCommandId!: string;

  @Field({ description: 'SHA-256 hash of the command payload before envelope fields are added' })
  @IsString()
  @MaxLength(128)
  override payloadHash!: string;
}
