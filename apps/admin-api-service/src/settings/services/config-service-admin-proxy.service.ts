import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

export const CONFIG_SERVICE_SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const ADMIN_API_CONFIG_SERVICE = 'admin-api-service';

export interface ConfigServiceConfiguration {
  id: string;
  tenantId: string;
  service: string;
  key: string;
  value: string;
  valueType?: string;
  environment?: string;
  description?: string;
  isSecret?: boolean;
  isActive?: boolean;
  defaultValue?: string;
  category?: string;
  tags?: string[];
  updatedAt?: string;
}

export interface UpsertConfigServiceConfiguration {
  tenantId: string;
  service: string;
  key: string;
  value: string;
  environment?: string;
  isSecret?: boolean;
  reason?: string;
}

interface GraphQlError {
  message?: string;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: GraphQlError[];
}

@Injectable()
export class ConfigServiceAdminProxy {
  private readonly logger = new Logger(ConfigServiceAdminProxy.name);

  private readonly endpoint =
    process.env['CONFIG_SERVICE_GRAPHQL_URL'] ??
    (process.env['CONFIG_SERVICE_URL'] ? `${process.env['CONFIG_SERVICE_URL']}/graphql` : undefined);

  private readonly authToken =
    process.env['CONFIG_SERVICE_ADMIN_TOKEN'] ??
    process.env['SERVICE_IDENTITY_TOKEN'];

  async getConfiguration(
    tenantId: string,
    service: string,
    key: string,
  ): Promise<ConfigServiceConfiguration | null> {
    const response = await this.request<{ configuration: ConfigServiceConfiguration }>(
      `query AdminConfig($service: String!, $key: String!) {
        configuration(service: $service, key: $key) {
          id tenantId service key value valueType environment description
          isSecret isActive defaultValue category tags updatedAt
        }
      }`,
      { tenantId, service, key },
    );
    return response.configuration ?? null;
  }

  async listConfigurations(
    tenantId: string,
    service: string,
  ): Promise<ConfigServiceConfiguration[]> {
    const response = await this.request<{ configurationsByService: ConfigServiceConfiguration[] }>(
      `query AdminConfigs($service: String!) {
        configurationsByService(service: $service) {
          id tenantId service key value valueType environment description
          isSecret isActive defaultValue category tags updatedAt
        }
      }`,
      { tenantId, service },
    );
    return response.configurationsByService ?? [];
  }

  async setConfiguration(
    input: UpsertConfigServiceConfiguration,
  ): Promise<ConfigServiceConfiguration> {
    const response = await this.request<{ setConfiguration: ConfigServiceConfiguration }>(
      `mutation AdminSetConfig(
        $service: String!
        $key: String!
        $value: String!
        $environment: ConfigEnvironment!
        $isSecret: Boolean!
        $reason: String
      ) {
        setConfiguration(
          service: $service
          key: $key
          value: $value
          environment: $environment
          isSecret: $isSecret
          reason: $reason
        ) {
          id tenantId service key value valueType environment description
          isSecret isActive defaultValue category tags updatedAt
        }
      }`,
      {
        tenantId: input.tenantId,
        service: input.service,
        key: input.key,
        value: input.value,
        environment: input.environment ?? 'all',
        isSecret: input.isSecret ?? false,
        reason: input.reason,
      },
    );
    return response.setConfiguration;
  }

  async deleteConfigurationByKey(
    tenantId: string,
    service: string,
    key: string,
  ): Promise<void> {
    const existing = await this.getConfiguration(tenantId, service, key);
    if (!existing) return;
    await this.request<{ deleteConfiguration: boolean }>(
      `mutation AdminDeleteConfig($id: ID!) {
        deleteConfiguration(id: $id, hardDelete: false)
      }`,
      { tenantId, id: existing.id },
    );
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    if (!this.endpoint || !this.authToken) {
      throw new ServiceUnavailableException(
        'config-service proxy is not configured; admin-api is not allowed to use admin.* config tables',
      );
    }

    const response = await globalThis.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.authToken}`,
        'x-service-name': 'admin-api-service',
        'x-tenant-id': String(variables['tenantId'] ?? CONFIG_SERVICE_SYSTEM_TENANT_ID),
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      this.logger.error(`config-service request failed with HTTP ${response.status}`);
      throw new ServiceUnavailableException('config-service rejected admin-api proxy request');
    }

    const payload = (await response.json()) as GraphQlResponse<T>;
    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message ?? 'unknown error').join('; ');
      if (/not found/i.test(message)) {
        return {} as T;
      }
      throw new InternalServerErrorException(`config-service GraphQL error: ${message}`);
    }

    if (!payload.data) {
      throw new InternalServerErrorException('config-service returned no data');
    }
    return payload.data;
  }
}
