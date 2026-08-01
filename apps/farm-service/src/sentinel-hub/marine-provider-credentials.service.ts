import {
  MarineProviderCredentialClient,
  type CdseProviderCredentialBundle,
} from '@aquaculture/backend-common/config-client';
import { Inject, Injectable } from '@nestjs/common';
import {
  MarineProviderCredentialResolveOutcome,
  parseMarineProviderCdseCredentialBundle,
} from '@platform/event-contracts';

export interface ResolvedProviderCredential<T> {
  bundle: T;
  sourceTenantId: string;
  configVersion: number;
}

export type MarineProviderCredentialResolver = Pick<MarineProviderCredentialClient, 'resolve'>;

/**
 * A sanitized config-service availability failure. It deliberately contains
 * no transport or credential detail and, unlike NOT_FOUND, must never disable
 * satellite monitoring silently.
 */
export class MarineProviderCredentialUnavailableError extends Error {
  constructor() {
    super('CDSE credential configuration is unavailable');
    this.name = 'MarineProviderCredentialUnavailableError';
  }
}

/**
 * Internal CDSE credential resolution boundary.
 *
 * New tenant overrides cannot be created through farm-service. The config
 * service returns an existing one-shot legacy override when present and the
 * company default otherwise. Plaintext exists only for the immediate runtime
 * token exchange and is never exposed through GraphQL or REST.
 */
@Injectable()
export class MarineProviderCredentialsService {
  constructor(
    @Inject(MarineProviderCredentialClient)
    private readonly client: MarineProviderCredentialResolver,
  ) {}

  async resolveCdse(
    tenantId: string,
  ): Promise<ResolvedProviderCredential<CdseProviderCredentialBundle> | null> {
    const result = await this.client.resolve('CDSE', tenantId);
    if (result.outcome === MarineProviderCredentialResolveOutcome.UNAVAILABLE) {
      throw new MarineProviderCredentialUnavailableError();
    }
    if (
      result.outcome === MarineProviderCredentialResolveOutcome.NOT_FOUND ||
      !result.found ||
      result.bundleJson === null ||
      result.sourceTenantId === null ||
      result.configVersion === null
    ) {
      return null;
    }
    const bundle = parseMarineProviderCdseCredentialBundle(result.bundleJson);
    if (!bundle) {
      throw new MarineProviderCredentialUnavailableError();
    }
    return {
      bundle,
      sourceTenantId: result.sourceTenantId,
      configVersion: result.configVersion,
    };
  }
}
