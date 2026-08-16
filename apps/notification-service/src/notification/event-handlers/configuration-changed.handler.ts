import { CONFIGURATION_CATALOG_DIGEST } from '@aquaculture/configuration-contracts';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  type ConfigurationChangedEvent,
} from '@platform/event-contracts';

import {
  SMTP_CONFIGURATION_IDS,
  SmtpConfigurationProvider,
} from '../services/smtp-configuration.provider';

const SMTP_CONFIGURATION_ID_SET = new Set(SMTP_CONFIGURATION_IDS);

@Injectable()
export class ConfigurationChangedHandler
  implements IEventHandler<ConfigurationChangedEvent>, OnModuleInit
{
  private readonly logger = new Logger(ConfigurationChangedHandler.name);

  constructor(
    private readonly smtpConfiguration: SmtpConfigurationProvider,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn('ConfigurationChanged subscription unavailable; SMTP TTL remains active');
      return;
    }
    await this.eventBus.subscribeWildcard('ConfigurationChanged', this);
  }

  getEventType(): string {
    return 'ConfigurationChanged';
  }

  async handle(event: ConfigurationChangedEvent): Promise<void> {
    if (
      event.tenantId === CONFIG_RUNTIME_SYSTEM_TENANT_ID &&
      event.catalogDigest === CONFIGURATION_CATALOG_DIGEST &&
      SMTP_CONFIGURATION_ID_SET.has(event.catalogId)
    ) {
      this.smtpConfiguration.invalidate();
    }
    return Promise.resolve();
  }
}
