import { Controller, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { StandardHealthController } from '@aquaculture/backend-common/health';
import { DataSource } from 'typeorm';
import { SmsService } from '../notification/services/sms.service';
import { PushService } from '../notification/services/push.service';

/**
 * Notification Service Health Controller
 * Extends the standard health controller with SMS and Push provider checks.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
    @Optional() private readonly smsService?: SmsService,
    @Optional() private readonly pushService?: PushService,
  ) {
    super(dataSource);
    this.serviceName = 'notification-service';
  }

  /**
   * Adds SMS and Push provider readiness checks.
   * A provider is only considered unhealthy if it is enabled but not healthy.
   */
  protected override async getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    const checks: Record<string, 'ok' | 'error'> = {};

    if (this.smsService) {
      const smsStatus = this.smsService.getProviderStatus();
      if (smsStatus.enabled) {
        checks.sms = smsStatus.healthy ? 'ok' : 'error';
      }
    }

    if (this.pushService) {
      const pushStatus = this.pushService.getProviderStatus();
      if (pushStatus.enabled) {
        checks.push = pushStatus.healthy ? 'ok' : 'error';
      }
    }

    return checks;
  }
}
