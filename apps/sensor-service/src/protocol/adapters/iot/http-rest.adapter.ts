import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BaseProtocolAdapter,
  ConnectionHandle,
  ConnectionTestResult,
  SensorReadingData,
  ValidationResult,
  ProtocolCapabilities,
} from '../base-protocol.adapter';
import {
  ProtocolCategory,
  ProtocolSubcategory,
  ConnectionType,
  ProtocolConfigurationSchema,
} from '../../../database/entities/sensor-protocol.entity';

/**
 * HTTP REST Configuration
 */
export interface HttpRestConfiguration {
  baseUrl: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: string;
  // Authentication
  authType: 'none' | 'basic' | 'bearer' | 'apiKey' | 'oauth2';
  username?: string;
  password?: string;
  bearerToken?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  // OAuth2
  oauth2TokenUrl?: string;
  oauth2ClientId?: string;
  oauth2ClientSecret?: string;
  oauth2Scope?: string;
  // Polling
  pollingEnabled: boolean;
  pollingInterval: number;
  // Timeouts
  connectTimeout: number;
  readTimeout: number;
  // TLS
  verifySsl: boolean;
  caCert?: string;
  // Response parsing
  responseFormat: 'json' | 'xml' | 'csv' | 'text';
  dataPath?: string;
  dataMapping?: Record<string, string>;
}

@Injectable()
export class HttpRestAdapter extends BaseProtocolAdapter {
  readonly protocolCode = 'HTTP_REST';
  readonly category = ProtocolCategory.IOT;
  readonly subcategory = ProtocolSubcategory.REQUEST_RESPONSE;
  readonly connectionType = ConnectionType.TCP;
  readonly displayName = 'HTTP/HTTPS REST';
  readonly description = 'RESTful API integration for HTTP/HTTPS endpoints';

  private pollingIntervals = new Map<string, NodeJS.Timeout>();
  private oauth2Tokens = new Map<string, { token: string; expiresAt: Date }>();

  constructor(configService: ConfigService) {
    super(configService);
  }

  async connect(config: Record<string, unknown>): Promise<ConnectionHandle> {
    const httpConfig = config as unknown as HttpRestConfiguration;

    // Test the connection first
    const testResult = await this.testConnection(config);
    if (!testResult.success) {
      throw new Error(testResult.error || 'Failed to connect');
    }

    const handle = this.createConnectionHandle(
      config.sensorId as string || 'unknown',
      config.tenantId as string || 'unknown',
      { baseUrl: httpConfig.baseUrl, endpoint: httpConfig.endpoint }
    );

    this.logConnectionEvent('connect', handle, { baseUrl: httpConfig.baseUrl });
    return handle;
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    // Stop polling if active
    const pollingInterval = this.pollingIntervals.get(handle.id);
    if (pollingInterval) {
      clearInterval(pollingInterval);
      this.pollingIntervals.delete(handle.id);
    }

    this.removeConnectionHandle(handle.id);
    this.logConnectionEvent('disconnect', handle);
  }

  async testConnection(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const httpConfig = config as unknown as HttpRestConfiguration;
    const startTime = Date.now();

    try {
      const response = await this.makeRequest(httpConfig);
      const latencyMs = Date.now() - startTime;

      let sampleData: SensorReadingData | undefined;
      try {
        sampleData = this.parseResponse(response, httpConfig);
      } catch {
        // Sample data parsing is optional
      }

      return {
        success: true,
        latencyMs,
        sampleData,
        diagnostics: {
          connectionTimeMs: latencyMs,
          deviceInfo: {
            url: `${httpConfig.baseUrl}${httpConfig.endpoint}`,
            method: httpConfig.method,
            statusCode: response.status,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  async readData(handle: ConnectionHandle): Promise<SensorReadingData> {
    const config = handle.metadata as unknown as HttpRestConfiguration;
    if (!config) {
      throw new Error('Configuration not found in handle');
    }

    const response = await this.makeRequest(config);
    this.updateLastActivity(handle);
    return this.parseResponse(response, config);
  }

  private async makeRequest(config: HttpRestConfiguration): Promise<Response> {
    const url = new URL(config.endpoint, config.baseUrl);

    // Add query parameters
    if (config.queryParams) {
      for (const [key, value] of Object.entries(config.queryParams)) {
        url.searchParams.append(key, value);
      }
    }

    const headers: Record<string, string> = {
      ...config.headers,
    };

    // Add authentication
    await this.addAuthentication(headers, config);

    const fetchOptions: RequestInit = {
      method: config.method,
      headers,
    };

    if (config.body && ['POST', 'PUT', 'PATCH'].includes(config.method)) {
      fetchOptions.body = config.body;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.connectTimeout || 30000);

    try {
      const response = await fetch(url.toString(), {
        ...fetchOptions,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async addAuthentication(
    headers: Record<string, string>,
    config: HttpRestConfiguration
  ): Promise<void> {
    switch (config.authType) {
      case 'basic':
        if (config.username && config.password) {
          const credentials = Buffer.from(`${config.username}:${config.password}`).toString('base64');
          headers['Authorization'] = `Basic ${credentials}`;
        }
        break;

      case 'bearer':
        if (config.bearerToken) {
          headers['Authorization'] = `Bearer ${config.bearerToken}`;
        }
        break;

      case 'apiKey':
        if (config.apiKey) {
          headers[config.apiKeyHeader || 'X-API-Key'] = config.apiKey;
        }
        break;

      case 'oauth2':
        const token = await this.getOAuth2Token(config);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        break;
    }
  }

  private async getOAuth2Token(config: HttpRestConfiguration): Promise<string | null> {
    const cacheKey = `${config.oauth2TokenUrl}_${config.oauth2ClientId}`;
    const cached = this.oauth2Tokens.get(cacheKey);

    if (cached && cached.expiresAt > new Date()) {
      return cached.token;
    }

    if (!config.oauth2TokenUrl || !config.oauth2ClientId || !config.oauth2ClientSecret) {
      return null;
    }

    try {
      const response = await fetch(config.oauth2TokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.oauth2ClientId,
          client_secret: config.oauth2ClientSecret,
          scope: config.oauth2Scope || '',
        }).toString(),
      });

      if (!response.ok) {
        throw new Error('Failed to obtain OAuth2 token');
      }

      const data = await response.json();
      const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000 - 60000);

      this.oauth2Tokens.set(cacheKey, {
        token: data.access_token,
        expiresAt,
      });

      return data.access_token;
    } catch (error) {
      this.logger.error('OAuth2 token fetch failed', error);
      return null;
    }
  }

  private parseResponse(response: Response, config: HttpRestConfiguration): SensorReadingData {
    const timestamp = new Date();
    let values: Record<string, number | string | boolean | null> = {};

    // Note: In a real implementation, we'd read the response body here
    // For now, we return a placeholder
    return {
      timestamp,
      values,
      quality: 100,
      source: 'http_rest',
    };
  }

  validateConfiguration(config: unknown): ValidationResult {
    const errors = [];
    const warnings = [];
    const cfg = config as Partial<HttpRestConfiguration>;

    // Required fields
    if (!cfg.baseUrl) {
      errors.push(this.validationError('baseUrl', 'Base URL is required'));
    } else if (!this.isValidUrl(cfg.baseUrl)) {
      errors.push(this.validationError('baseUrl', 'Invalid URL format'));
    }

    if (!cfg.endpoint) {
      errors.push(this.validationError('endpoint', 'Endpoint is required'));
    }

    if (!cfg.method) {
      errors.push(this.validationError('method', 'HTTP method is required'));
    }

    // Auth validation
    if (cfg.authType === 'basic' && (!cfg.username || !cfg.password)) {
      errors.push(this.validationError('username', 'Username and password required for Basic auth'));
    }

    if (cfg.authType === 'bearer' && !cfg.bearerToken) {
      errors.push(this.validationError('bearerToken', 'Bearer token required'));
    }

    if (cfg.authType === 'apiKey' && !cfg.apiKey) {
      errors.push(this.validationError('apiKey', 'API key required'));
    }

    if (cfg.authType === 'oauth2') {
      if (!cfg.oauth2TokenUrl) {
        errors.push(this.validationError('oauth2TokenUrl', 'OAuth2 token URL required'));
      }
      if (!cfg.oauth2ClientId) {
        errors.push(this.validationError('oauth2ClientId', 'OAuth2 client ID required'));
      }
      if (!cfg.oauth2ClientSecret) {
        errors.push(this.validationError('oauth2ClientSecret', 'OAuth2 client secret required'));
      }
    }

    // Warnings
    if (cfg.baseUrl?.startsWith('http://')) {
      warnings.push(this.validationWarning('baseUrl', 'Using HTTP instead of HTTPS. Consider using HTTPS for security.'));
    }

    if (cfg.authType === 'none') {
      warnings.push(this.validationWarning('authType', 'No authentication configured'));
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  getConfigurationSchema(): ProtocolConfigurationSchema {
    return {
      type: 'object',
      title: 'HTTP REST Configuration',
      description: 'Configure HTTP/HTTPS REST API connection',
      required: ['baseUrl', 'endpoint', 'method'],
      properties: {
        baseUrl: {
          type: 'string',
          title: 'Base URL',
          description: 'API base URL (e.g., https://api.example.com)',
          'ui:placeholder': 'https://api.example.com',
          'ui:order': 1,
          'ui:group': 'connection',
        },
        endpoint: {
          type: 'string',
          title: 'Endpoint',
          description: 'API endpoint path (e.g., /v1/sensors/data)',
          'ui:placeholder': '/v1/sensors/data',
          'ui:order': 2,
          'ui:group': 'connection',
        },
        method: {
          type: 'string',
          title: 'HTTP Method',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          default: 'GET',
          'ui:order': 3,
          'ui:group': 'connection',
        },
        authType: {
          type: 'string',
          title: 'Authentication Type',
          enum: ['none', 'basic', 'bearer', 'apiKey', 'oauth2'],
          enumNames: ['None', 'Basic Auth', 'Bearer Token', 'API Key', 'OAuth2'],
          default: 'none',
          'ui:order': 4,
          'ui:group': 'authentication',
        },
        username: {
          type: 'string',
          title: 'Username',
          description: 'For Basic authentication',
          'ui:order': 5,
          'ui:group': 'authentication',
        },
        password: {
          type: 'string',
          title: 'Password',
          format: 'password',
          'ui:order': 6,
          'ui:group': 'authentication',
        },
        bearerToken: {
          type: 'string',
          title: 'Bearer Token',
          format: 'password',
          'ui:order': 7,
          'ui:group': 'authentication',
        },
        apiKey: {
          type: 'string',
          title: 'API Key',
          format: 'password',
          'ui:order': 8,
          'ui:group': 'authentication',
        },
        apiKeyHeader: {
          type: 'string',
          title: 'API Key Header',
          default: 'X-API-Key',
          'ui:order': 9,
          'ui:group': 'authentication',
        },
        oauth2TokenUrl: {
          type: 'string',
          title: 'OAuth2 Token URL',
          'ui:order': 10,
          'ui:group': 'oauth2',
        },
        oauth2ClientId: {
          type: 'string',
          title: 'OAuth2 Client ID',
          'ui:order': 11,
          'ui:group': 'oauth2',
        },
        oauth2ClientSecret: {
          type: 'string',
          title: 'OAuth2 Client Secret',
          format: 'password',
          'ui:order': 12,
          'ui:group': 'oauth2',
        },
        oauth2Scope: {
          type: 'string',
          title: 'OAuth2 Scope',
          'ui:order': 13,
          'ui:group': 'oauth2',
        },
        pollingEnabled: {
          type: 'boolean',
          title: 'Enable Polling',
          default: true,
          'ui:order': 14,
          'ui:group': 'polling',
        },
        pollingInterval: {
          type: 'integer',
          title: 'Polling Interval (ms)',
          default: 5000,
          minimum: 1000,
          'ui:order': 15,
          'ui:group': 'polling',
        },
        connectTimeout: {
          type: 'integer',
          title: 'Connect Timeout (ms)',
          default: 10000,
          minimum: 1000,
          'ui:order': 16,
          'ui:group': 'advanced',
        },
        readTimeout: {
          type: 'integer',
          title: 'Read Timeout (ms)',
          default: 30000,
          minimum: 1000,
          'ui:order': 17,
          'ui:group': 'advanced',
        },
        verifySsl: {
          type: 'boolean',
          title: 'Verify SSL Certificate',
          default: true,
          'ui:order': 18,
          'ui:group': 'security',
        },
        responseFormat: {
          type: 'string',
          title: 'Response Format',
          enum: ['json', 'xml', 'csv', 'text'],
          default: 'json',
          'ui:order': 19,
          'ui:group': 'data',
        },
        dataPath: {
          type: 'string',
          title: 'Data Path',
          description: 'JSON path to data (e.g., data.readings)',
          'ui:placeholder': 'data.readings',
          'ui:order': 20,
          'ui:group': 'data',
        },
      },
      'ui:groups': [
        { name: 'connection', title: 'Connection', fields: ['baseUrl', 'endpoint', 'method'] },
        { name: 'authentication', title: 'Authentication', fields: ['authType', 'username', 'password', 'bearerToken', 'apiKey', 'apiKeyHeader'] },
        { name: 'oauth2', title: 'OAuth2', fields: ['oauth2TokenUrl', 'oauth2ClientId', 'oauth2ClientSecret', 'oauth2Scope'] },
        { name: 'polling', title: 'Polling', fields: ['pollingEnabled', 'pollingInterval'] },
        { name: 'security', title: 'Security', fields: ['verifySsl'] },
        { name: 'data', title: 'Data Parsing', fields: ['responseFormat', 'dataPath'] },
        { name: 'advanced', title: 'Advanced', fields: ['connectTimeout', 'readTimeout'] },
      ],
    };
  }

  getDefaultConfiguration(): Record<string, unknown> {
    return {
      baseUrl: '',
      endpoint: '',
      method: 'GET',
      headers: {},
      authType: 'none',
      pollingEnabled: true,
      pollingInterval: 5000,
      connectTimeout: 10000,
      readTimeout: 30000,
      verifySsl: true,
      responseFormat: 'json',
    };
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      supportsDiscovery: false,
      supportsBidirectional: true,
      supportsPolling: true,
      supportsSubscription: false,
      supportsAuthentication: true,
      supportsEncryption: true,
      supportedDataTypes: ['json', 'xml', 'csv', 'text'],
      minimumPollingIntervalMs: 1000,
    };
  }
}
