import {
  createSignedFeatureEvaluationTransport,
  FailClosedFeatureToggleClient,
  resolveFeatureEvaluationKeyring,
} from '@aquaculture/backend-common/feature-toggle';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const MARINE_EXPLORER_FEATURE_KEY = 'marine_explorer';

@Injectable()
export class MarineExplorerFeatureService {
  private readonly logger = new Logger(MarineExplorerFeatureService.name);
  private readonly client: FailClosedFeatureToggleClient;
  private lastFailureLogAt = 0;

  constructor(configService: ConfigService, circuitBreaker: CircuitBreakerService) {
    const adminBaseUrl = resolveAdminBaseUrl(configService);
    const { keyring } = resolveFeatureEvaluationKeyring({
      rawKeyring: configService.get<string>('SERVICE_IDENTITY_KEYRING'),
      configuredActiveKeyId: configService.get<string>('SERVICE_IDENTITY_SIGNING_KID'),
      developmentSecret: configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET'),
      isProduction: configService.get<string>('NODE_ENV') === 'production',
    });
    this.client = new FailClosedFeatureToggleClient({
      audience: 'gateway-api',
      keyring,
      cacheTtlMs: 5_000,
      maxCacheEntries: 1_024,
      transport: createSignedFeatureEvaluationTransport({
        adminBaseUrl,
        serviceName: 'gateway-api',
        timeoutMs: 2_000,
        circuitBreaker: {
          service: circuitBreaker,
          serviceName: 'admin-feature-evaluation',
        },
        circuitBreakerOptions: {
          ...DEFAULT_BREAKER_OPTIONS,
          failureMode: 'fail-closed',
        },
      }),
      onFailure: () => this.logFailClosed(),
    });
  }

  isEnabled(tenantId: string): Promise<boolean> {
    return this.client.isEnabled(tenantId, MARINE_EXPLORER_FEATURE_KEY);
  }

  private logFailClosed(): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < 60_000) return;
    this.lastFailureLogAt = now;
    this.logger.warn('Marine Explorer feature evaluation failed closed');
  }
}

function resolveAdminBaseUrl(configService: ConfigService): string {
  const configured = configService.get<string>('ADMIN_SERVICE_REST_URL')?.trim();
  if (configured) return configured;
  if (configService.get<string>('NODE_ENV') === 'production') {
    throw new Error('ADMIN_SERVICE_REST_URL is required for Marine Explorer feature evaluation');
  }
  return 'http://admin-api-service:3000';
}
