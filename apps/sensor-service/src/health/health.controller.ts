import { Controller, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { StandardHealthController } from '@aquaculture/backend-common/health';
import { DataSource } from 'typeorm';

import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

interface ExtensionQueryResult {
  extname: string;
}

/**
 * Sensor Service Health Controller
 * Extends the standard health controller with TimescaleDB readiness check.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
    @Optional()
    private readonly mqttClient?: MqttClientService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {
    super(dataSource);
    this.serviceName = 'sensor-service';
  }

  /**
   * Adds TimescaleDB extension check to readiness probe.
   */
  protected override async getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    return {
      timescale: await this.checkTimescale(),
      // SENSOR-MEDIUM-123: a connected-but-unsubscribed listener used to pass
      // every readiness probe. Readiness now requires BOTH an established
      // broker connection AND at least one broker-acknowledged filter.
      mqtt: this.checkMqtt(),
    };
  }

  /**
   * MQTT is this service's data plane: readiness requires BOTH an established
   * broker connection AND at least the base filter subscribed. A deployment
   * that intentionally runs without it (control-plane profile per ADR-022,
   * or MQTT_ENABLED=false) skips the check — anything else must not report
   * ready while unsubscribed, the exact state that used to deploy green.
   */
  private checkMqtt(): 'ok' | 'error' {
    const profile = this.configService?.get<string>('SENSOR_SERVICE_PROFILE');
    const mqttEnabled = this.configService?.get<string>('MQTT_ENABLED') !== 'false';
    const intentionallyDisabled = profile === 'control-plane' || !mqttEnabled;
    if (intentionallyDisabled) return 'ok';
    if (!this.mqttClient) return 'error';
    if (!this.mqttClient.isConnectedToBroker()) return 'error';
    return this.mqttClient.isSubscribed('sensors/#') ? 'ok' : 'error';
  }

  private async checkTimescale(): Promise<'ok' | 'error'> {
    try {
      if (!this.dataSource.isInitialized) {
        return 'error';
      }
      const result = await this.dataSource.query<ExtensionQueryResult[]>(
        "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
      );
      return result.length > 0 ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  }
}
