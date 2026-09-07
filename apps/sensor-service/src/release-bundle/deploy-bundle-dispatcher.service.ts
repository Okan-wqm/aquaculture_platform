import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { withTenantContext } from '@aquaculture/backend-common/context';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import type { DeployBundleRequestedEvent } from '@platform/event-contracts';
import {
  formatValidationErrors,
  validateCommandEnvelope,
  validateDeployBundleParams,
} from '@platform/sensor-contracts/validators';

import { canonicalJsonStringify } from '../deploy-artifact/artifact.service';
import { DeployArtifact } from '../deploy-artifact/entities/deploy-artifact.entity';
import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

import { ReleaseBundle, ReleaseBundleStatus } from './entities/release-bundle.entity';
import { ReleaseBundleService } from './release-bundle.service';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Outbox-relay consumer that turns a committed `DeployBundleRequested`
 * event into the `deploy_bundle` MQTT command (enterprise plan Faz 5).
 *
 * Trust model: the event is only a WAKE-UP — every load-bearing value
 * (manifest, signature, artifact contents) comes from this service's own
 * database, scoped by the event's tenantId. A forged event on the NATS
 * subject can at worst re-dispatch an EXISTING pending bundle, which is
 * safe: publishing is idempotent (fixed commandId; the edge dedupes on
 * it) and non-PENDING bundles are skipped.
 *
 * Delivery semantics: the outbox relay gives at-least-once up to NATS;
 * consumer-side MQTT publish failures are retried inline with bounded
 * backoff and then transition the bundle PENDING → FAILED so the state
 * machine never lies about a dispatch that silently died.
 */
@Injectable()
export class DeployBundleDispatcherService
  implements OnModuleInit, OnModuleDestroy, IEventHandler<DeployBundleRequestedEvent>
{
  private readonly logger = new Logger(DeployBundleDispatcherService.name);

  private static readonly SUBJECT_PATTERN = 'events.*.DeployBundleRequested';

  /** Inline publish retry schedule (ms) before PENDING → FAILED. */
  private static readonly PUBLISH_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

  constructor(
    @InjectRepository(ReleaseBundle)
    private readonly bundleRepository: Repository<ReleaseBundle>,
    @InjectRepository(DeployArtifact)
    private readonly artifactRepository: Repository<DeployArtifact>,
    private readonly releaseBundleService: ReleaseBundleService,
    @Optional()
    @Inject(MqttClientService)
    private readonly mqttClient: MqttClientService | null,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
  ) {}

  getEventType(): string {
    return 'DeployBundleRequested';
  }

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not provided; DeployBundleDispatcherService will not subscribe — bundle deploys cannot dispatch',
      );
      return;
    }
    await this.eventBus.subscribeTo<DeployBundleRequestedEvent>(
      DeployBundleDispatcherService.SUBJECT_PATTERN,
      this,
    );
    this.logger.log(`Subscribed to ${DeployBundleDispatcherService.SUBJECT_PATTERN}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.eventBus) {
      try {
        await this.eventBus.unsubscribeFrom(DeployBundleDispatcherService.SUBJECT_PATTERN);
      } catch (error) {
        this.logger.warn(`Unsubscribe failed on shutdown: ${(error as Error).message}`);
      }
    }
  }

  async handle(event: DeployBundleRequestedEvent): Promise<HandlerOutcome> {
    // Structural guard — the event is untrusted wake-up data.
    if (
      !UUID_RE.test(event.tenantId ?? '') ||
      !UUID_RE.test(event.bundleId ?? '') ||
      !UUID_RE.test(event.deviceId ?? '')
    ) {
      this.logger.warn('Dropped malformed DeployBundleRequested event');
      return HandlerOutcome.terminate('DeployBundleRequested: malformed identifiers');
    }

    await withTenantContext(event.tenantId, async () => {
      const bundle = await this.bundleRepository.findOne({
        where: { id: event.bundleId, tenantId: event.tenantId },
      });
      if (!bundle) {
        this.logger.warn(`DeployBundleRequested for unknown bundle ${event.bundleId} — dropped`);
        return;
      }
      if (bundle.status !== ReleaseBundleStatus.PENDING) {
        this.logger.log(
          `Bundle ${bundle.id} already ${bundle.status} — duplicate dispatch event skipped`,
        );
        return;
      }
      await this.dispatch(bundle);
    });
    return HandlerOutcome.ack();
  }

  private async dispatch(bundle: ReleaseBundle): Promise<void> {
    const artifactIds = bundle.manifest.artifacts.map((a) => a.artifactId);
    const artifacts = await this.artifactRepository.find({
      where: { id: In(artifactIds), tenantId: bundle.tenantId },
    });
    const bySha = new Map(artifacts.map((a) => [a.contentSha256, a] as const));

    const contents: Record<string, string> = {};
    for (const ref of bundle.manifest.artifacts) {
      const artifact = bySha.get(ref.sha256);
      if (!artifact) {
        await this.releaseBundleService.markFailed(
          bundle.tenantId,
          bundle.commandId,
          `Artifact ${ref.artifactId} (sha ${ref.sha256.slice(0, 12)}…) missing from the content-addressed store`,
        );
        return;
      }
      contents[ref.sha256] = canonicalJsonStringify(artifact.content);
    }

    const params = {
      bundleId: bundle.id,
      manifest: canonicalJsonStringify(bundle.manifest),
      manifestSha256: bundle.manifestSha256,
      signature: bundle.signature,
      contents,
    };
    const payload = {
      commandId: bundle.commandId,
      command: 'deploy_bundle',
      params,
      timestamp: new Date().toISOString(),
    };

    if (!validateDeployBundleParams(params)) {
      await this.releaseBundleService.markFailed(
        bundle.tenantId,
        bundle.commandId,
        `deploy_bundle payload violates the canonical contract: ${formatValidationErrors(validateDeployBundleParams)}`,
      );
      return;
    }
    if (!validateCommandEnvelope(payload)) {
      await this.releaseBundleService.markFailed(
        bundle.tenantId,
        bundle.commandId,
        `Command envelope violates the canonical contract: ${formatValidationErrors(validateCommandEnvelope)}`,
      );
      return;
    }

    const topic = `tenants/${bundle.tenantId}/devices/${bundle.deviceId}/commands`;
    const delays = DeployBundleDispatcherService.PUBLISH_RETRY_DELAYS_MS;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        if (!this.mqttClient) {
          throw new Error('MQTT service not available');
        }
        await this.mqttClient.publish(topic, payload);
        this.logger.log(
          `deploy_bundle ${bundle.id} dispatched to device ${bundle.deviceId} (command ${bundle.commandId}, ${bundle.manifest.artifacts.length} artifact(s))`,
        );
        return;
      } catch (error) {
        const message = (error as Error).message;
        const delay = delays[attempt];
        if (delay === undefined) {
          await this.releaseBundleService.markFailed(
            bundle.tenantId,
            bundle.commandId,
            `MQTT dispatch failed after ${delays.length + 1} attempts: ${message}`,
          );
          return;
        }
        this.logger.warn(
          `deploy_bundle ${bundle.id} publish attempt ${attempt + 1} failed (${message}); retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
