import { createHash } from 'node:crypto';

import { Field, ObjectType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

import {
  CONFIG_SECRET_REDACTED_VALUE,
  SYSTEM_TENANT_ID,
} from '../configuration.constants';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';

export type EffectiveConfigurationSource = 'tenant' | 'system';
export type EffectiveConfigurationSecretMode = 'none' | 'redacted';

@ObjectType()
export class EffectiveConfigurationDto {
  @Field()
  tenantId!: string;

  @Field()
  serviceId!: string;

  @Field()
  key!: string;

  @Field(() => ConfigEnvironment)
  environment!: ConfigEnvironment;

  @Field(() => ConfigValueType)
  valueType!: ConfigValueType;

  @Field(() => GraphQLJSON, { nullable: true })
  value!: unknown;

  @Field()
  secretMode!: EffectiveConfigurationSecretMode;

  @Field()
  source!: EffectiveConfigurationSource;

  @Field()
  sourceConfigurationId!: string;

  @Field(() => [String])
  sourceChain!: string[];

  @Field()
  revision!: number;

  @Field()
  version!: number;

  @Field()
  contentHash!: string;

  @Field()
  resolvedAt!: Date;

  @Field()
  tombstoned!: boolean;

  @Field()
  requiresRestart!: boolean;

  @Field(() => GraphQLJSON)
  cachePolicy!: Record<string, unknown>;
}

function contentHash(configuration: Configuration): string {
  return createHash('sha256')
    .update(`${configuration.valueType}:${configuration.value}`)
    .digest('hex');
}

function effectiveValue(configuration: Configuration): unknown {
  if (configuration.valueType === ConfigValueType.SECRET || configuration.isSecret) {
    // WHY the null for an empty secret: an empty stored value means "no secret
    // configured yet" (e.g. the seeded email.smtp_password placeholder).
    // Returning the redaction sentinel for it would fabricate the existence of
    // a stored secret — clients must be able to distinguish "a secret exists
    // (redacted)" from "no secret set". secretMode stays 'redacted' either way
    // because the FIELD is secret regardless of whether a value is present.
    return configuration.value === '' ? null : CONFIG_SECRET_REDACTED_VALUE;
  }
  return configuration.getTypedValue();
}

export function toEffectiveConfigurationDto(
  requestedTenantId: string,
  configuration: Configuration,
): EffectiveConfigurationDto {
  const source: EffectiveConfigurationSource =
    configuration.tenantId === SYSTEM_TENANT_ID ? 'system' : 'tenant';

  return {
    tenantId: requestedTenantId,
    serviceId: configuration.service,
    key: configuration.key,
    environment: configuration.environment,
    valueType: configuration.valueType,
    value: effectiveValue(configuration),
    secretMode:
      configuration.valueType === ConfigValueType.SECRET || configuration.isSecret
        ? 'redacted'
        : 'none',
    source,
    sourceConfigurationId: configuration.id,
    sourceChain:
      source === 'tenant'
        ? [requestedTenantId, SYSTEM_TENANT_ID]
        : [SYSTEM_TENANT_ID],
    revision: configuration.version,
    version: configuration.version,
    contentHash: contentHash(configuration),
    resolvedAt: new Date(),
    tombstoned: !configuration.isActive,
    requiresRestart: false,
    cachePolicy: {
      cacheable: !(configuration.valueType === ConfigValueType.SECRET || configuration.isSecret),
      ttlSeconds: 60,
    },
  };
}
