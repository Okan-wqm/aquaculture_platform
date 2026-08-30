import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sensor-service runtime profile (ADR-022 control / data plane split).
 *
 * Two profiles ship in the same binary:
 *
 *   - **legacy** (default): the historical NestJS path. Subscribes to
 *     MQTT, parses payloads via the in-process protocol adapters,
 *     persists via `SensorMetricWriterService`, publishes typed
 *     `SensorReadingEvent`s.
 *
 *   - **control-plane**: the post-Faz-2 split. The Rust ingestion
 *     sidecar (ADR-025) owns MQTT subscribe + protocol parse +
 *     TimescaleDB COPY. NestJS receives `SensorMetricIngested` events
 *     via NATS, enriches with sensor-meta, calls
 *     `SensorMetricWriterService.enqueue`, re-emits the typed
 *     `SensorReadingEvent` for downstream consumers (alert-engine,
 *     AI, audit). The MQTT listener + per-sensor data-collection task
 *     is skipped.
 *
 * WHY a single source of truth (this service) instead of per-service
 * env reads:
 *   Each ingestion-related service (`MqttListenerService`,
 *   `DataIngestionService`, `NatsIngestionConsumerService`) needs the
 *   same gating decision. Reading `process.env.SENSOR_SERVICE_PROFILE`
 *   in three places is the textbook drift surface — a typo in one
 *   string check sets two services to one mode and the third to the
 *   other. Centralising the parse + enum here means the only place
 *   the env var name appears is this file; every other call site asks
 *   the typed `Profile` enum.
 *
 * WHY `legacy` is the default:
 *   Safe rollout: an operator who deploys without setting the env
 *   keeps the existing behaviour. Opt in to `control-plane` by
 *   explicit env, never by accident.
 */
export enum SensorServiceProfile {
  Legacy = 'legacy',
  ControlPlane = 'control-plane',
}

const ENV_VAR = 'SENSOR_SERVICE_PROFILE';

@Injectable()
export class SensorServiceProfileService {
  private readonly logger = new Logger(SensorServiceProfileService.name);
  private readonly profile: SensorServiceProfile;

  constructor(configService: ConfigService) {
    const raw = (configService.get<string>(ENV_VAR) ?? '').trim().toLowerCase();
    if (raw === SensorServiceProfile.ControlPlane) {
      this.profile = SensorServiceProfile.ControlPlane;
    } else if (raw === '' || raw === SensorServiceProfile.Legacy) {
      this.profile = SensorServiceProfile.Legacy;
    } else {
      // Unknown value: log loudly + fall back to legacy. Refusing to
      // boot on a typo would block deploys; silently mapping to
      // control-plane would risk misrouting traffic. Loud warning +
      // safe default keeps ops in control.
      this.logger.warn(
        `${ENV_VAR}="${raw}" is not a recognised profile; falling back to "${SensorServiceProfile.Legacy}"`,
      );
      this.profile = SensorServiceProfile.Legacy;
    }
    this.logger.log(`SensorServiceProfile resolved → ${this.profile}`);
  }

  /**
   * The resolved profile. Prefer the `is*` predicates below over
   * comparing strings at call sites; the predicates name the gate
   * rather than the implementation.
   */
  getProfile(): SensorServiceProfile {
    return this.profile;
  }

  /**
   * `true` when the legacy NestJS data-plane (MQTT subscribe + per-
   * sensor data-collection task) should run. `false` on the
   * control-plane profile where the Rust sidecar owns that work.
   *
   * Used by `MqttListenerService.onModuleInit` and
   * `DataIngestionService.onModuleInit` to skip their boot-time
   * subscribe / scheduling.
   */
  isLegacyDataPlaneEnabled(): boolean {
    return this.profile === SensorServiceProfile.Legacy;
  }

  /**
   * `true` when the NATS ingestion consumer (bridge to the Rust
   * sidecar) should run.
   *
   * Returns `true` for BOTH profiles by design: during the strangler-
   * fig rollout window the sidecar may already be publishing for some
   * tenants while the legacy MQTT path still runs for others. The
   * NATS consumer is harmless when no events arrive — it just sits
   * idle on its subscription.
   */
  isNatsConsumerEnabled(): boolean {
    return true;
  }
}
