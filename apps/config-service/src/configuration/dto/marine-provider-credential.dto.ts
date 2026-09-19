import { Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  MARINE_PROVIDER_CDSE_FIELD_MAX_LENGTH,
  MarineProviderCredentialProvider,
} from '@platform/event-contracts';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { Configuration } from '../entities/configuration.entity';

/**
 * GraphQL enum of the marine data providers whose company credential
 * config-service owns. `satisfies` pins it to the contract's provider set: a
 * provider added to MARINE_PROVIDER_CREDENTIAL_KEYS without an enum member, or
 * an enum member without a contract key, is a compile error.
 */
export const MarineProviderCredentialProviderGql = {
  CDSE: 'CDSE',
} as const satisfies Record<MarineProviderCredentialProvider, MarineProviderCredentialProvider>;

registerEnumType(MarineProviderCredentialProviderGql, {
  name: 'MarineProviderCredentialProvider',
  description: 'Marine data providers whose company credential the platform stores',
});

/**
 * What an operator may learn about a stored company credential: that one is
 * stored, which revision it is and when it last changed. Never the value, and
 * never the author (the configuration history keeps that, audited).
 */
@ObjectType()
export class MarineProviderCredentialStatusDto {
  @Field(() => MarineProviderCredentialProviderGql)
  provider!: MarineProviderCredentialProvider;

  @Field()
  configured!: boolean;

  @Field(() => Int, { nullable: true })
  version!: number | null;

  @Field(() => Date, { nullable: true })
  updatedAt!: Date | null;
}

export function toMarineProviderCredentialStatusDto(
  provider: MarineProviderCredentialProvider,
  configuration: Configuration | null,
): MarineProviderCredentialStatusDto {
  const configured = configuration !== null && configuration.isActive;
  return {
    provider,
    configured,
    version: configured ? configuration.version : null,
    updatedAt: configured ? configuration.updatedAt : null,
  };
}

/**
 * The CDSE credential as three typed fields. The resolver assembles the
 * canonical bundle from them with the contract serializer, so a client never
 * learns the storage key or the JSON shape — and cannot get either wrong.
 *
 * The length ceilings are the contract's own table, so this surface cannot
 * admit a value the trust boundary would reject.
 */
@InputType()
export class SetMarineProviderCdseCredentialInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MARINE_PROVIDER_CDSE_FIELD_MAX_LENGTH.clientId)
  clientId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MARINE_PROVIDER_CDSE_FIELD_MAX_LENGTH.clientSecret)
  clientSecret!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MARINE_PROVIDER_CDSE_FIELD_MAX_LENGTH.instanceId)
  instanceId?: string;

  @Field({ nullable: true, description: 'Recorded in the configuration history for this write' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
