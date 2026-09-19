import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  MARINE_PROVIDER_CREDENTIAL_KEYS,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  MarineProviderCredentialProvider,
  marineProviderCredentialKey,
  serializeMarineProviderCdseCredentialBundle,
} from '@platform/event-contracts';

import { UpsertConfigurationCommand } from './commands/upsert-configuration.command';
import { SYSTEM_TENANT_ID } from './configuration.constants';
import {
  MarineProviderCredentialProviderGql,
  MarineProviderCredentialStatusDto,
  SetMarineProviderCdseCredentialInput,
  toMarineProviderCredentialStatusDto,
} from './dto/marine-provider-credential.dto';
import { Configuration, ConfigEnvironment } from './entities/configuration.entity';
import {
  GraphQLPrincipalContext,
  assertTenantlessSuperAdmin,
  requireUserId,
} from './graphql-principal';
import { GetConfigurationQuery } from './queries/get-configuration.query';

/** Recorded in configuration_history when the caller gives no reason. */
const DEFAULT_WRITE_REASON =
  'company marine provider credential set through the platform admin surface';

/**
 * The operations surface for the company marine provider credential.
 *
 * WHY a dedicated surface next to the generic setConfiguration: the company
 * CDSE credential is one secret JSON bundle under a service/key pair that only
 * the backend contract knows. Driving it through the generic key/value
 * mutation made every client re-encode that knowledge — the runbook had the
 * operator hand-write the bundle into a raw GraphQL call, and the admin panel
 * could not offer the write at all without copying the key and the JSON shape
 * into the browser. Here the client sends the credential's fields; the
 * resolver builds the bundle with the contract serializer and writes it
 * through the same UpsertConfigurationCommand path, so the handler's write
 * policy (secret, ALL environment, complete bundle, system tenant) still
 * decides, and the storage key never leaves the backend.
 *
 * Authorization is the tenantless SUPER_ADMIN rule the generic surface applies
 * to restricted provider credentials, taken from the one definition both
 * resolvers share (./graphql-principal). A tenant principal learns nothing
 * here — not even that the query exists beyond a ForbiddenException.
 */
@Resolver(() => MarineProviderCredentialStatusDto)
export class MarineProviderCredentialResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Query(() => MarineProviderCredentialStatusDto, { name: 'marineProviderCredentialStatus' })
  async getMarineProviderCredentialStatus(
    @Args('provider', { type: () => MarineProviderCredentialProviderGql })
    provider: MarineProviderCredentialProvider,
    @Context() context: GraphQLPrincipalContext,
  ): Promise<MarineProviderCredentialStatusDto> {
    assertTenantlessSuperAdmin(context);
    const configuration = await this.findCompanyCredential(marineProviderCredentialKey(provider));
    return toMarineProviderCredentialStatusDto(provider, configuration);
  }

  @Mutation(() => MarineProviderCredentialStatusDto)
  async setMarineProviderCdseCredential(
    @Args('input') input: SetMarineProviderCdseCredentialInput,
    @Context() context: GraphQLPrincipalContext,
  ): Promise<MarineProviderCredentialStatusDto> {
    assertTenantlessSuperAdmin(context);
    const userId = requireUserId(context);

    let value: string;
    try {
      value = serializeMarineProviderCdseCredentialBundle({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
      });
    } catch {
      // The serializer re-parses its own output against the canonical bundle
      // rules; a rejection here is a field the input validation did not
      // bound identically, surfaced as the client's error rather than a 500.
      throw new BadRequestException('CDSE credential fields do not form a valid bundle');
    }

    const configuration = await this.commandBus.execute<UpsertConfigurationCommand, Configuration>(
      new UpsertConfigurationCommand(
        SYSTEM_TENANT_ID,
        MARINE_PROVIDER_CREDENTIAL_SERVICE,
        MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE,
        value,
        ConfigEnvironment.ALL,
        userId,
        true,
        input.reason ?? DEFAULT_WRITE_REASON,
      ),
    );
    return toMarineProviderCredentialStatusDto('CDSE', configuration);
  }

  /**
   * The company row lives under the system tenant. GetConfigurationQuery
   * answers "not stored" with NotFoundException by contract; for a status read
   * that is a value, not a failure.
   */
  private async findCompanyCredential(key: string): Promise<Configuration | null> {
    try {
      return await this.queryBus.execute<GetConfigurationQuery, Configuration>(
        new GetConfigurationQuery(
          SYSTEM_TENANT_ID,
          MARINE_PROVIDER_CREDENTIAL_SERVICE,
          key,
          ConfigEnvironment.ALL,
        ),
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  }
}
