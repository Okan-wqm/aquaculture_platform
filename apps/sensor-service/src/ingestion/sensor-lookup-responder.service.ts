import { buildNatsConnectionOptions } from '@platform/event-bus/nats-connection';
// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// nats-core (connection + Msg/Subscription primitives) and transport-node
// (Node connect). StringCodec was REMOVED — encode a string by passing it
// directly to respond(), decode via msg.string(). The wire bytes are UTF-8
// either way, so this stays byte-for-byte compatible with the Rust sidecar.
import type { Msg, NatsConnection, Subscription } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SensorMetaCacheService } from './sensor-meta-cache.service';

/**
 * NATS request-reply responder for `sensor.lookup.by-topic`.
 *
 * WHY this service exists (Faz 3 follow-on):
 *   The Rust ingestion sidecar's `TopicCache` (Faz 2 stage 8) was
 *   allocated at boot but nothing populated it — the drain hot path
 *   used `cache.get()` only for a hit/miss log. This service is the
 *   responder side of the cache-fill pair: the sidecar publishes a
 *   lookup request on cache miss; we reply with the sensor's
 *   `{ sensorId, tenantId, channelIds }` shape backed by the existing
 *   {@link SensorMetaCacheService} (the same cache the
 *   {@link NatsIngestionConsumerService} enrichment path uses, so a
 *   single Map per process serves both flows).
 *
 *   Wire shape MUST stay byte-for-byte equal to the sidecar's
 *   `apps/sensor-ingestion/src/sensor_lookup.rs` decoder. The Rust
 *   side pins the shape via the `sensor_meta_wire_shape_camelCase`
 *   test in `cache.rs`; this service pins the same literal subject
 *   `'sensor.lookup.by-topic'` plus the camelCase response shape via
 *   the spec at `__tests__/sensor-lookup-responder.service.spec.ts`.
 *   Both sides break loud if either drifts.
 *
 * WHY raw `nats` connection instead of the JetStream-based IEventBus:
 *   Mirrors `automation/compiler/nats-handlers/st-language.handler.ts`
 *   — JetStream is for persistent pub/sub, NOT request-reply. Raw NATS
 *   is the right primitive for a lookup that has no "deliver later"
 *   semantic. The connection is established on `onModuleInit` and
 *   drained on `onModuleDestroy`; subscriptions are tracked in an
 *   array so shutdown is deterministic.
 *
 * WHY the SEC-M01 tenant cross-check:
 *   The lookup request carries the requesting tenant's id alongside
 *   the sensor id. Defence in depth: even if a future code path or a
 *   compromised intermediary sends a request whose tenantId does not
 *   match the resolved sensor's `sensor.tenantId`, we reply with `null`
 *   (and log a warn) instead of leaking the cross-tenant sensor's
 *   metadata. The Rust side mirrors the same check inside
 *   `spawn_lookup_and_populate_cache` — both layers refuse the cache
 *   insert independently.
 *
 * WHY `null` for not-found / mismatch (not an error reply):
 *   The Rust client decodes the body as `Option<SensorMeta>` directly;
 *   the JSON literal `null` maps to `None` byte-for-byte. Encoding
 *   not-found as a structured `{ found: false }` envelope would force
 *   the client to special-case the error path AND change the wire
 *   shape — both work against the architectural-tier-1 "make the
 *   wrong shape impossible" pattern.
 */
@Injectable()
export class SensorLookupResponderService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SensorLookupResponderService.name);

  /**
   * Subject the Rust sidecar publishes its cache-miss request to.
   * Pinned by the responder's subscribe-time test AND mirrored by the
   * Rust `LOOKUP_SUBJECT` constant (`sensor_lookup.rs`). A drift on
   * either side fails its own subject-literal test — the two literals
   * are co-located at the architectural boundary they share.
   */
  static readonly SUBJECT = 'sensor.lookup.by-topic';

  /**
   * Queue group used for load-balancing across multiple
   * sensor-service replicas. NATS dispatches each request to exactly
   * one subscriber in the group — picking the same group name across
   * replicas means a horizontally-scaled deploy does not respond
   * N times to a single request.
   */
  private static readonly QUEUE_GROUP = 'sensor-lookup-responders';

  private connection: NatsConnection | null = null;
  private readonly subscriptions: Subscription[] = [];
  private readonly natsUrl: string;

  constructor(
    private readonly cacheService: SensorMetaCacheService,
    private readonly configService: ConfigService,
  ) {
    this.natsUrl = this.configService.get<string>(
      'NATS_URL',
      'nats://localhost:4222',
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.connectAndSubscribe();
    } catch (error) {
      // Mirrors STLanguageHandler's posture: a NATS-unavailable boot
      // must not crash the app. Operators see the warn; the responder
      // re-attempts on next process restart (NATS is a hard
      // dependency in production but local dev / unit-test runs may
      // not have a broker).
      this.logger.warn(
        `Failed to connect NATS for sensor lookup responder: ${(error as Error).message}. ` +
          'Cache-miss requests from the Rust sidecar will go unanswered until NATS is reachable.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.length = 0;
    if (this.connection) {
      try {
        await this.connection.drain();
      } catch (error) {
        this.logger.warn(
          `NATS drain failed at shutdown: ${(error as Error).message}`,
        );
      }
      this.connection = null;
    }
  }

  /**
   * Public for the spec — the test feeds a synthetic NATS `Msg` so we
   * can pin the wire shape without spinning a broker. Production
   * callers reach this via the subscription loop in
   * {@link connectAndSubscribe}.
   *
   * The method NEVER throws; every failure mode logs + replies with
   * the JSON literal `null` so the Rust client sees a single shape
   * for "no usable result". Throwing would leave the request hanging
   * until the client's tokio::time::timeout fires (2s default), which
   * is the worst possible operator signal — `null` is the right
   * negative reply.
   */
  async handleLookupRequest(msg: Msg): Promise<void> {
    let request: { tenantId?: unknown; sensorId?: unknown };
    try {
      request = JSON.parse(msg.string()) as {
        tenantId?: unknown;
        sensorId?: unknown;
      };
    } catch (error) {
      this.logger.warn(
        `sensor.lookup.by-topic request body is not valid JSON: ${(error as Error).message}`,
      );
      this.respondNull(msg);
      return;
    }

    const tenantId =
      typeof request.tenantId === 'string' ? request.tenantId : null;
    const sensorId =
      typeof request.sensorId === 'string' ? request.sensorId : null;
    if (!tenantId || !sensorId) {
      this.logger.warn(
        'sensor.lookup.by-topic request missing tenantId or sensorId; replying null',
      );
      this.respondNull(msg);
      return;
    }

    let sensor;
    try {
      sensor = await this.cacheService.getSensor(sensorId);
    } catch (error) {
      // Cache / repo failure: do not leak the error class to the
      // sidecar; reply null so the cache stays cold for this key
      // and the operator alarms on the structured log.
      this.logger.error(
        `getSensor failed for sensorId=${sensorId}: ${(error as Error).message}`,
      );
      this.respondNull(msg);
      return;
    }

    if (!sensor) {
      // Authoritative not-found. Logged at debug because a legitimate
      // onboarding window will see this until the operator registers
      // the sensor; a sustained spike is visible in the sidecar's
      // cache_miss_lookup_spawn_count tail counter.
      this.logger.debug(
        `sensor.lookup.by-topic for unknown sensorId=${sensorId} (tenant=${tenantId}); replying null`,
      );
      this.respondNull(msg);
      return;
    }

    if (sensor.tenantId !== tenantId) {
      // SEC-M01 defence-in-depth — the responder MUST NOT leak a
      // cross-tenant sensor's metadata even by accident. The Rust
      // side checks the same invariant inside
      // spawn_lookup_and_populate_cache; both layers refuse
      // independently. Logged at warn so the security team's alarm
      // fires.
      this.logger.warn(
        `sensor.lookup.by-topic tenant mismatch: request.tenantId=${tenantId} sensor.tenantId=${sensor.tenantId}; replying null`,
      );
      this.respondNull(msg);
      return;
    }

    let channels;
    try {
      channels = await this.cacheService.getChannels(sensorId);
    } catch (error) {
      this.logger.error(
        `getChannels failed for sensorId=${sensorId}: ${(error as Error).message}`,
      );
      this.respondNull(msg);
      return;
    }

    // The wire shape mirrors the Rust SensorMeta serde shape:
    //   { sensorId, tenantId, channelIds[], farmId?, pondId? } — all
    //   camelCase, all lower-case hyphenated UUID strings. Pinned by
    //   both spec files.
    //
    // WHY farmId / pondId are conditionally added (not always written
    // as `key: undefined`):
    //   `JSON.stringify` drops `undefined` values silently — if we
    //   wrote `farmId: undefined` the wire shape would be the same as
    //   omitting the property, BUT a future refactor that swapped the
    //   stringify path for a typed serialiser would surface the
    //   undefined as `null`. Building the reply with the property
    //   only present when the value exists makes the absent-not-null
    //   contract structural, not stringify-dependent.
    //
    // WHY this matters byte-for-byte:
    //   The Rust `SensorMeta` derives use
    //   `skip_serializing_if = "Option::is_none"` — `farmId: null`
    //   would deserialise as `Some(Uuid::nil())` after a serde tweak
    //   OR fail decode outright depending on the tweak. Absence is
    //   the only safe encoding for "no farm".
    const reply: {
      sensorId: string;
      tenantId: string;
      channelIds: string[];
      farmId?: string;
      pondId?: string;
    } = {
      sensorId: sensor.id,
      tenantId: sensor.tenantId,
      channelIds: channels.map((c) => c.id),
    };
    if (sensor.farmId) {
      reply.farmId = sensor.farmId;
    }
    if (sensor.pondId) {
      reply.pondId = sensor.pondId;
    }
    this.respond(msg, reply);
  }

  private async connectAndSubscribe(): Promise<void> {
    /** SEC-H01: shared NATS connection factory for consistent auth. */
    // Hold the connection in a local so it narrows to non-null for subscribe()
    // below — the intervening logger.log() call resets TS property narrowing on
    // the `NatsConnection | null` field.
    const connection = await connect({
      ...buildNatsConnectionOptions(
        `sensor-service-lookup-responder-${process.pid}`,
      ),
      maxReconnectAttempts: -1,
    });
    this.connection = connection;
    this.logger.log(
      `Connected to NATS for sensor.lookup.by-topic responder (url=${this.natsUrl})`,
    );

    const sub = connection.subscribe(
      SensorLookupResponderService.SUBJECT,
      {
        queue: SensorLookupResponderService.QUEUE_GROUP,
      },
    );
    this.subscriptions.push(sub);
    this.logger.log(
      `Subscribed to ${SensorLookupResponderService.SUBJECT} (queue=${SensorLookupResponderService.QUEUE_GROUP})`,
    );

    // Spawn the request loop in the background; awaiting here would
    // block onModuleInit forever (the loop only ends when the broker
    // closes the subscription on shutdown).
    void this.runSubscriptionLoop(sub);
  }

  private async runSubscriptionLoop(sub: Subscription): Promise<void> {
    try {
      for await (const msg of sub) {
        // handleLookupRequest never throws; any failure surfaces as a
        // logged warn + a `null` reply.
        await this.handleLookupRequest(msg);
      }
    } catch (error) {
      const message = (error as Error).message ?? '';
      // "closed" is the normal shutdown path when onModuleDestroy
      // unsubscribes; suppress that log line so a clean stop is silent.
      if (!message.includes('closed')) {
        this.logger.error(
          `Subscription loop error for ${SensorLookupResponderService.SUBJECT}: ${message}`,
        );
      }
    }
  }

  /**
   * Reply with the canonical not-found shape. The Rust client decodes
   * `Option<SensorMeta>` from the reply body; the JSON literal `null`
   * maps to `None` byte-for-byte. No-op when `msg.reply` is absent
   * (the request was a fire-and-forget publish — log nothing because
   * the sender did not ask for an answer).
   */
  private respondNull(msg: Msg): void {
    if (msg.reply) {
      msg.respond('null');
    }
  }

  /**
   * Reply with a fully-populated meta. JSON.stringify produces the
   * exact camelCase shape the Rust `SensorMeta` deserialiser expects.
   */
  private respond(msg: Msg, reply: unknown): void {
    if (msg.reply) {
      msg.respond(JSON.stringify(reply));
    }
  }
}
