import * as os from 'os';

import { emitBootInvariantSignal } from '@aquaculture/backend-common/constants';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
// NATS v3 (@nats-io/* 3.x). v2 monolithic `nats` package split into
// transport-node (Node connect), nats-core (connection + Msg primitives),
// and jetstream (JS client/manager + policy enums). StringCodec/JSONCodec
// were REMOVED — encode a string by passing it directly to publish(), decode
// via msg.string()/msg.json(). The wire bytes are UTF-8 either way, so the
// migration is byte-for-byte compatible with v2 producers/consumers during
// a rolling deploy (durable names + stream config unchanged).
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerConfig,
  type Consumer,
  type JsMsg,
  type StreamConfig,
} from '@nats-io/jetstream';
import type { ConnectionOptions, NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventUpcasterRegistry } from '@platform/event-contracts';

import {
  IEventBus,
  IEvent,
  IEventHandler,
  EventBusHealth,
  SubscriptionOptions,
  PublishOptions,
  EventMetadata,
} from '../interfaces/event-bus.interface';
import {
  buildSystemEventSubject,
  buildTenantEventSubject,
  buildWildcardEventSubject,
  assertSubjectMatchesEvent,
} from '../subjects/tenant-event-subject';


import { DEFAULT_NATS_URL, DEFAULT_NATS_STREAM_NAME } from './event-bus-config.factory';
import type { EventBusModuleOptions } from './nats.module';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStreamReplicas(rawValue: string | number | undefined, defaultValue: number): number {
  const parsed =
    rawValue === undefined ? defaultValue : Number.parseInt(String(rawValue), 10);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error(
      `NATS_STREAM_REPLICAS must be an integer from 1 to 5, got: ${String(rawValue)}`,
    );
  }

  return parsed;
}

function isIEvent(value: unknown): value is IEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['eventId'] === 'string' &&
    typeof value['eventType'] === 'string' &&
    typeof value['timestamp'] === 'string'
  );
}

/**
 * NATS JetStream Event Bus Implementation
 * Enterprise-grade event bus with persistence, replay, and exactly-once delivery
 * Designed for 10K+ tenant scale with proper isolation
 */
@Injectable()
export class NatsEventBus
  implements IEventBus, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NatsEventBus.name);
  private connection: NatsConnection | null = null;
  private jetStream: JetStreamClient | null = null;
  private jetStreamManager: JetStreamManager | null = null;
  private readonly consumers = new Map<string, Consumer>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly handlers = new Map<string, IEventHandler[]>();
  /** Subscriptions requested before JetStream was connected, to be activated on connect. */
  private readonly pendingSubscriptions: Array<{
    subject: string;
    options?: SubscriptionOptions;
  }> = [];
  private lastConnectedAt: Date | null = null;
  private connectionState: 'connected' | 'disconnected' | 'reconnecting' =
    'disconnected';

  // Configuration
  // ADR-015: TLS + auth fields are NOT stored on the instance — the shared
  // `buildNatsConnectionOptions()` factory reads env at connect time and
  // returns fully-formed ConnectionOptions. Duplicating state here was the
  // source-of-truth drift this refactor eliminates.
  private readonly natsUrl: string;
  private readonly streamName: string;
  private readonly streamReplicas: number;
  private readonly clientId: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectTimeWaitMs: number;

  /** Optional event upcaster registry for v1→v2+ event schema migration */
  private readonly upcasterRegistry?: EventUpcasterRegistry;

  /**
   * IMPORTANT: fail-closed — when true, broker unavailability always prevents
   * module startup regardless of environment.  Production ALWAYS fails closed.
   */
  private readonly requireBroker: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject('EVENT_BUS_OPTIONS') @Optional() moduleOptions?: EventBusModuleOptions,
    @Inject('EVENT_UPCASTER_REGISTRY') @Optional() upcasterRegistry?: EventUpcasterRegistry,
  ) {
    this.upcasterRegistry = upcasterRegistry;
    this.requireBroker = moduleOptions?.required ?? false;
    this.natsUrl = this.configService.get<string>('NATS_URL', DEFAULT_NATS_URL);
    this.streamName = this.configService.get<string>(
      'NATS_STREAM_NAME',
      DEFAULT_NATS_STREAM_NAME,
    );
    // JetStream replica count is a property of the NATS DEPLOYMENT TOPOLOGY
    // (how many nodes the cluster has), NOT of the application environment.
    // Coupling it to NODE_ENV/AQUA_ENV (production ⇒ 3) was an architectural
    // defect: a single-node production deployment (e.g. the self-contained
    // droplet) then demanded a 3-replica stream its standalone server cannot
    // host, leaving an unrecoverable stream that failed the JetStream health
    // check and cascaded every dependent service into a stuck `Created` state.
    //
    // Durability is owned by the transactional outbox + event-store (the SSoT):
    // every event is written to the outbox in the SAME DB transaction as the
    // domain change and republished by the outbox worker, so nothing is lost if
    // a JetStream message is. JetStream replication therefore provides transport
    // HA, NOT durability — and R=1 is correct and complete on a single node.
    //
    // The DESIRED replica count comes from NATS_STREAM_REPLICAS (the
    // deployment's topology profile), defaulting to 1 (always hostable). A
    // clustered deployment opts into higher replication by setting it to the
    // node count. setupStream() additionally CLAMPS the value to what the
    // connected server can actually host (resolveEffectiveReplicas), so an
    // over-specified count can never re-create the unrecoverable-stream outage.
    this.streamReplicas = parseStreamReplicas(
      this.configService.get<string | number>('NATS_STREAM_REPLICAS'),
      1,
    );
    // ARCH-020: Use SERVICE_NAME for stable consumer identity across pod restarts.
    // PID-based names caused orphan consumers and duplicate message processing.
    // Same SERVICE_NAME across scaled instances enables JetStream queue-group
    // semantics: messages are load-balanced, not duplicated.
    const serviceName = this.configService.get<string>(
      'SERVICE_NAME',
      os.hostname(),
    );
    this.clientId = this.configService.get<string>(
      'NATS_CLIENT_ID',
      `aquaculture-${serviceName}`,
    );
    this.maxReconnectAttempts = this.configService.get<number>(
      'NATS_MAX_RECONNECT_ATTEMPTS',
      10,
    );
    this.reconnectTimeWaitMs = this.configService.get<number>(
      'NATS_RECONNECT_TIME_WAIT_MS',
      2000,
    );
    // ADR-015: TLS / auth config is read inside `connect()` via the shared
    // `buildNatsConnectionOptions()` factory. Production security enforcement
    // (no-auth throw) lives in the factory so every NATS consumer on the
    // platform shares exactly one validation path.
  }

  /**
   * IMPORTANT: fail-closed — broker availability is an explicit startup dependency.
   *
   * The service MUST NOT boot when NATS is unreachable if:
   *   1. The environment is production (NODE_ENV=production), OR
   *   2. The module was configured with `required: true`.
   *
   * Only non-production environments without the `required` flag fall back to
   * background reconnection.  This prevents services from appearing healthy
   * while async event workflows are silently disabled.
   */
  async onModuleInit(): Promise<void> {
    const isProduction = process.env['NODE_ENV'] === 'production';
    // IMPORTANT: fail-closed — production OR explicit required flag means the
    // service cannot start without a working broker connection.
    const mustHaveBroker = isProduction || this.requireBroker;

    try {
      await this.connect();
      await this.setupStream();
      // Activate any subscriptions that were registered before connect completed
      await this.activatePendingSubscriptions();
    } catch (error) {
      if (mustHaveBroker) {
        this.logger.error(
          `CRITICAL: Failed to connect to NATS (required=${this.requireBroker}, ` +
          `production=${isProduction}). Service startup aborted. ` +
          `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        throw error;
      }
      this.logger.warn(
        `Failed to connect to NATS on startup (non-production, optional). ` +
        `Service will continue without event bus. ` +
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Track current reconnect-attempt depth so scheduleReconnect respects
   * `maxReconnectAttempts` (NATS_MAX_RECONNECT_ATTEMPTS, default 10).
   *
   * # Why this counter exists (PLAT-MEDIUM-001 closure)
   *
   * Pre-fix scheduleReconnect recursed infinitely on every failure
   * without consulting maxReconnectAttempts — the field was read into
   * the constructor but never used. A pod stuck on a permanently-broken
   * NATS endpoint (DNS misconfiguration, certificate revoked, broker
   * decommissioned) would log warnings forever, masking the underlying
   * issue. The cap forces the pod into a clear non-healthy state after
   * the configured attempts so liveness/readiness probes can intervene.
   *
   * Counter resets to 0 on every successful connect so legitimate
   * cycle-out periods (e.g. broker rolling restart) do not exhaust
   * the budget for the next outage.
   */
  private reconnectAttemptCount = 0;

  private scheduleReconnect(): void {
    if (this.reconnectAttemptCount >= this.maxReconnectAttempts) {
      // Cap reached. Log loud and stop scheduling. The pod's liveness
      // probe will eventually mark the container unhealthy and the
      // orchestrator will restart it — at which point the counter
      // resets via fresh module init.
      this.logger.error(
        `NATS reconnect attempts exhausted (${this.reconnectAttemptCount}/${this.maxReconnectAttempts}). ` +
          'Stopping reconnect loop. The pod is in a degraded state — ' +
          'liveness probe will trigger orchestrator restart.',
      );
      return;
    }

    this.reconnectAttemptCount += 1;
    const attempt = this.reconnectAttemptCount;
    setTimeout(() => {
      void this.reconnect(attempt);
    }, this.reconnectTimeWaitMs);
  }

  private async reconnect(attempt: number): Promise<void> {
    if (this.connectionState === 'disconnected') {
      this.logger.log(
        `Attempting to reconnect to NATS (attempt ${attempt}/${this.maxReconnectAttempts})...`,
      );
      try {
        await this.connect();
        await this.setupStream();
        await this.activatePendingSubscriptions();
        this.reconnectAttemptCount = 0; // reset budget on success
        this.logger.log('Successfully reconnected to NATS');
      } catch (error) {
        this.logger.warn(
          `Reconnection attempt ${attempt}/${this.maxReconnectAttempts} failed: ${errorMessage(error)}`,
        );
        this.scheduleReconnect();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  async connect(): Promise<void> {
    try {
      this.connectionState = 'reconnecting';
      this.logger.log(`Connecting to NATS at ${this.natsUrl}...`);

      // ADR-015: build ConnectionOptions via the shared factory so this
      // service uses the same auth + TLS resolution as every NestJS
      // ClientProxy-based NATS consumer on the platform. The factory
      // handles:
      //   - URL scheme ↔ NATS_TLS_ENABLED consistency check
      //   - CA / cert / key validation and PEM loading
      //   - mTLS cert-only mode (production; cert CN IS identity)
      //   - user/pass fallback (dev/CI when TLS is disabled)
      //   - production no-auth hard-fail
      //
      // Override only the fields where this class's identity matters:
      // `name` becomes the durable JetStream consumer identity
      // (see ARCH-020 comment in constructor).
      const factoryOptions = buildNatsConnectionOptions(this.clientId);
      // Spread the WHOLE factory result (authMode is an excess spread field that
      // connect() ignores) instead of rest-destructuring it out — the
      // `{ authMode, ...rest }` rest-spread made the connect() call resolve to an
      // `error`/`any`-typed value under the type-aware lint (the gateway bridges
      // that spread the whole factory result are clean).
      const connectionOptions: ConnectionOptions = {
        ...factoryOptions,
        name: this.clientId,
        maxReconnectAttempts: this.maxReconnectAttempts,
        reconnectTimeWait: this.reconnectTimeWaitMs,
      };

      // Each auth mode has a distinct operational meaning; log accurately
      // so packet-capture / log-grep investigations aren't misled.
      const authModeDescription: Record<typeof factoryOptions.authMode, string> = {
        'mtls-cert': 'cert CN is identity; verify_and_map on server',
        'token': 'service-account token (CONNECT frame)',
        'user-pass': 'dev/legacy fallback (CONNECT frame user/password)',
        'none': 'unauthenticated (dev/local only; production throws)',
      };
      this.logger.log(
        `NATS auth mode selected: ${factoryOptions.authMode}`,
        {
          authMode: factoryOptions.authMode,
          description: authModeDescription[factoryOptions.authMode],
        },
      );

      // ORPHAN-MEDIUM-093 — verified FALSE POSITIVE, not a real unsafe
      // assignment. @typescript-eslint type-checks this lib's source standalone
      // against the bare tsconfig.base.json (selected first + match-all in
      // .eslintrc parserOptions.project), where @nats-io/* (an exports-only ESM
      // package) does not resolve, so `connect`'s result widens to `error`. The
      // code is type-correct: the platform-wide `type-check`, the `build`, and
      // the event-bus unit tests all PASS (they run in the consumer/app context
      // where @nats-io resolves). Six config fixes were attempted; the proper
      // fix (reorder parserOptions.project so per-project tsconfigs precede base,
      // or give every platform lib a selected tsconfig) is a cross-cutting
      // eslint-config change tracked separately from the NATS migration.
      // Suppressed via a scoped `.eslintrc.json` override (no-unsafe-assignment OFF for this
      // ONE file, with the same WHY) — the in-line per-line disable-comment form
      // is banned by the repo's banned-construct gate, which directs false-
      // positive suppressions to the .eslintrc lint-policy SSoT. Tracked as
      // ORPHAN-MEDIUM-093; both the override and this note are removable once the
      // parserOptions.project-order fix lands.
      this.connection = await connect(connectionOptions);

      // v3: jetstream()/jetstreamManager() are top-level functions taking the
      // connection, not methods on it (v2 was `this.connection.jetstream()`).
      this.jetStream = jetstream(this.connection);
      this.jetStreamManager = await jetstreamManager(this.connection);

      this.connectionState = 'connected';
      this.lastConnectedAt = new Date();
      this.logger.log('Successfully connected to NATS JetStream');
      if (factoryOptions.authMode === 'mtls-cert') {
        emitBootInvariantSignal(this.logger, 'nats_auth_mode_mtls', {
          authMode: factoryOptions.authMode,
          description: authModeDescription[factoryOptions.authMode],
          clientId: this.clientId,
          natsUrl: this.natsUrl,
        });
      }

      // Handle connection events
      this.setupConnectionHandlers();
    } catch (error) {
      this.connectionState = 'disconnected';
      this.logger.error('Failed to connect to NATS', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      // Abort all message processing loops
      for (const [topic, controller] of this.abortControllers) {
        try {
          controller.abort();
          this.logger.log(`Aborted processing for ${topic}`);
        } catch (err) {
          this.logger.warn(`Error aborting ${topic}`, err);
        }
      }
      this.abortControllers.clear();
      this.consumers.clear();

      // Close connection
      if (this.connection) {
        await this.connection.drain();
        await this.connection.close();
        this.connection = null;
        this.jetStream = null;
        this.jetStreamManager = null;
      }

      this.connectionState = 'disconnected';
      this.logger.log('Disconnected from NATS');
    } catch (error) {
      this.logger.error('Error during NATS disconnect', error);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connectionState === 'connected' && this.connection !== null;
  }

  /**
   * Internal accessor used by {@link NatsRequestReply} to reach the
   * raw core-NATS connection for request-reply (which is NOT a
   * JetStream concern — it uses the core pub/sub path).
   *
   * WHY this accessor exists rather than the request-reply class
   * holding its own connection: ADR-015 mandates ONE mTLS handshake
   * per service process. Sharing through a narrow accessor keeps
   * the connection lifecycle owned by a single class (NatsEventBus)
   * while letting request-reply be a peer concern in a separate
   * file. Marked `@internal` so library consumers do not reach past
   * the abstraction.
   *
   * @internal
   */
  getRawConnection(): NatsConnection | null {
    return this.connection;
  }

  /**
   * Publish via core NATS (NOT JetStream) to a subject OUTSIDE the
   * stream filter list. Used for control-plane signals that live
   * deliberately outside the event namespace:
   *
   *   - ADR-031 `policy.ingest_backend.changed` — admin-api
   *     publishes each rollout decision change; the Rust sidecar's
   *     `policy.ingest_backend.>` subscriber consumes via core
   *     subscribe. Not a JetStream concern because the downstream
   *     durability guarantee is ALREADY satisfied by the sidecar's
   *     disk-fallback file + cold-start snapshot request-reply
   *     against admin-api.
   *
   * WHY a dedicated method rather than `publishTo` + a
   * `normalizeSubject` change — `publishTo` is JetStream-backed
   * and adds msgID dedup + the stream's duplicate_window. A
   * non-event subject would either fail ("no stream matches
   * subject") or quietly escape into a sibling stream if one is
   * added later. Segregating core-NATS publishes on their own
   * method makes the "this is NOT a durable event" invariant
   * load-bearing — impossible to downgrade by a refactor that
   * renamed the subject.
   *
   * Core-NATS publish semantics: at-most-once delivery with no
   * ack, no dedup, no replay. The caller is responsible for
   * idempotency at the consumer (the sidecar's apply_change is
   * structurally idempotent under duplicate delivery).
   *
   * @throws {Error} when the connection is not established — a
   *   misconfigured boot surfaces the problem at publish rather
   *   than silently dropping the payload.
   */
  async publishCore(subject: string, payload: Uint8Array): Promise<void> {
    if (this.connection === null) {
      throw new Error(
        `NATS core publish to "${subject}" failed: connection not established`,
      );
    }
    this.connection.publish(subject, payload);
    // `publish` on a core NATS connection returns void synchronously
    // — the write lands in the connection's send buffer and flushes
    // on the next tick. Await `flush()` so the returned Promise
    // resolves only after the broker has acknowledged receipt of
    // the bytes (equivalent to the publish guarantee tests rely on).
    await this.connection.flush();
  }

  getHealth(): Promise<EventBusHealth> {
    return Promise.resolve({
      isHealthy: this.isConnected(),
      connectionState: this.connectionState,
      lastConnectedAt: this.lastConnectedAt ?? undefined,
      pendingMessages: this.consumers.size,
    });
  }

  /**
   * Derive the tenant-scoped NATS subject for an event.
   *
   * Subject format:
   *   With tenantId:    events.{tenantId}.{eventType}   (tenant-isolated routing)
   *   Without tenantId: events.system.{eventType}       (platform-level events)
   *
   * Consumers that handle all tenants subscribe with wildcard:
   *   events.*.{eventType}   — receives events from every tenant
   *
   * Consumers that handle a single tenant subscribe with:
   *   events.{tenantId}.{eventType}
   *
   * The JetStream stream already has subjects: ['events.>'] so both formats
   * are captured without stream reconfiguration.
   */
  private deriveSubject(event: IEvent): string {
    if (!event.tenantId) {
      return buildSystemEventSubject(event.eventType);
    }
    return buildTenantEventSubject(event.tenantId, event.eventType);
  }

  async publish<TEvent extends IEvent>(
    event: TEvent,
    options?: PublishOptions,
  ): Promise<void> {
    await this.publishTo(this.deriveSubject(event), event, options);
  }

  async publishBatch<TEvent extends IEvent>(events: TEvent[]): Promise<void> {
    await Promise.all(events.map((event) => this.publish(event)));
  }

  async publishTo<TEvent extends IEvent>(
    topic: string,
    event: TEvent,
    _options?: PublishOptions,
  ): Promise<void> {
    if (!this.jetStream) {
      throw new Error('NATS JetStream not connected');
    }

    try {
      const subject = this.normalizeSubject(topic);
      if (subject.startsWith('events.')) {
        assertSubjectMatchesEvent(subject, event);
      }
      const payload = this.serializeEvent(event);

      // NOTE: Intentionally NO `expect: { lastMsgID: ... }` option here.
      // `expect.lastMsgID` is a CAS-style assertion — it succeeds only on
      // the FIRST publish to an empty stream; every subsequent publish
      // fails with "wrong last msg ID", making publishing impossible in
      // any real-world workload. Event deduplication is already handled
      // by the combination of `msgID` (stable per-event) and the stream's
      // `duplicate_window` — JetStream drops a second publish with the
      // same msgID within the dedup window, which is exactly the
      // idempotency guarantee the outbox worker relies on for retries.
      // v3: publish() accepts a string directly (UTF-8 encoded by the lib) —
      // no StringCodec.encode(). Byte-identical wire to the v2 producer.
      await this.jetStream.publish(subject, payload, {
        msgID: event.eventId,
      });

      this.logger.debug(`Published event ${event.eventType} to ${subject}`);
    } catch (error) {
      this.logger.error(
        `Failed to publish event ${event.eventType}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Subscribe to an event type across ALL tenants.
   *
   * Uses the NATS wildcard `events.*.{eventType}` so this consumer receives
   * events published to `events.{anyTenantId}.{eventType}` and
   * `events.system.{eventType}`.
   *
   * NOTE: kept on the class so existing callers keep compiling. New consumers
   * should call `subscribeWildcard` (semantically identical here, but the
   * name asserts intent) or `subscribeForTenant` (per-tenant subscription).
   */
  async subscribe<TEvent extends IEvent>(
    eventType: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void> {
    // Wildcard '*' matches any single segment — all tenants and 'system'.
    // Delegates through the explicit helper so there is exactly one place
    // that constructs `events.*.{eventType}` (no string-format drift).
    await this.subscribeWildcard(eventType, handler);
  }

  /**
   * Subscribe to an event type ACROSS EVERY TENANT.
   *
   * WHAT — Builds `events.*.{eventType}` and delegates to `subscribeTo`.
   * The wildcard `*` matches a single segment, so every per-tenant publish
   * (`events.{tenantId}.{eventType}`) and the platform-level publish
   * (`events.system.{eventType}`) are both captured by this one subscription.
   *
   * WHY explicit helper instead of letting consumers format the subject —
   * the publisher emits exactly 3 dot-separated segments. Hand-formatting
   * at the call site is the drift surface ORPHAN-013 documented (a 2-segment
   * subscriber silently misses every publish; NATS matching is segment-exact,
   * not "starts with"). Centralising the format string here makes the wrong
   * shape impossible to write accidentally — Tier-1 "make it impossible".
   */
  async subscribeWildcard<TEvent extends IEvent>(
    eventType: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void> {
    const subject = buildWildcardEventSubject(eventType);
    await this.subscribeTo(subject, handler);
  }

  /**
   * Subscribe to an event type FOR A SPECIFIC TENANT only.
   *
   * WHAT — Builds `events.{tenantId}.{eventType}` (literal segments, no
   * wildcards) and delegates to `subscribeTo`. Receives ONLY that tenant's
   * publishes — never `events.system.*` and never any other tenant's events.
   *
   * WHY validate tenantId at this boundary instead of trusting the caller —
   * the subject IS the routing key. NATS `.` is the segment delimiter, `*`
   * is the single-segment wildcard, `>` is the tail wildcard. A tenantId
   * containing any of those metacharacters silently expands the subject to
   * a different shape (e.g. `tenantId = "foo.bar"` → 4 segments) or matches
   * across tenants (subject-injection). Reject obviously malformed values
   * here so the wrong shape can never reach the broker — Tier-1 boundary
   * defence. Full UUID validation is the caller's concern; this helper only
   * enforces the structural invariant that the segment is a single, literal,
   * non-empty token.
   *
   * @throws {TypeError} If tenantId contains NATS subject metacharacters,
   *   whitespace, or is empty. The bad value is masked to the first 8 chars
   *   in the error message so an attacker cannot exfiltrate the value via
   *   error logs.
   */
  async subscribeForTenant<TEvent extends IEvent>(
    eventType: string,
    tenantId: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void> {
    const subject = buildTenantEventSubject(tenantId, eventType);
    await this.subscribeTo(subject, handler);
  }

  async subscribeTo<TEvent extends IEvent>(
    topic: string,
    handler: IEventHandler<TEvent>,
    options?: SubscriptionOptions,
  ): Promise<void> {
    const subject = this.normalizeSubject(topic);

    // Store handler regardless of connection state so it is ready when
    // the connection comes up.
    const handlers = this.handlers.get(subject) ?? [];
    handlers.push(handler);
    this.handlers.set(subject, handlers);

    if (!this.jetStream) {
      // JetStream is not yet connected.  Queue the subscription so it will
      // be activated once the connection is established.
      this.logger.warn(
        `NATS JetStream not connected yet. Queuing subscription for ${subject}`,
      );
      if (!this.pendingSubscriptions.some((p) => p.subject === subject)) {
        this.pendingSubscriptions.push({ subject, options });
      }
      return;
    }

    // Create consumer if not already subscribed
    if (!this.consumers.has(subject)) {
      await this.createSubscription(subject, options);
    }
  }

  async unsubscribe(eventType: string): Promise<void> {
    // Match the wildcard subject used by subscribe()
    const topic = buildWildcardEventSubject(eventType);
    await this.unsubscribeFrom(topic);
  }

  unsubscribeFrom(topic: string): Promise<void> {
    const subject = this.normalizeSubject(topic);
    const controller = this.abortControllers.get(subject);

    if (controller) {
      controller.abort();
      this.abortControllers.delete(subject);
      this.consumers.delete(subject);
      this.handlers.delete(subject);
      this.logger.log(`Unsubscribed from ${subject}`);
    }
    return Promise.resolve();
  }

  /**
   * Activate subscriptions that were queued while JetStream was disconnected.
   *
   * IMPORTANT: fail-closed — activation errors are collected and re-thrown
   * so the caller (onModuleInit) can decide whether to abort startup.
   * Previously errors were swallowed per-subscription, allowing the service
   * to boot with partial event handling.
   *
   * @throws {Error} Aggregated error if any pending subscription fails to activate
   */
  private async activatePendingSubscriptions(): Promise<void> {
    if (this.pendingSubscriptions.length === 0) {
      return;
    }

    this.logger.log(
      `Activating ${this.pendingSubscriptions.length} pending subscription(s)...`,
    );

    // Drain the queue (splice so new entries during iteration are not lost)
    const pending = this.pendingSubscriptions.splice(0);
    const failures: Array<{ subject: string; message: string }> = [];

    for (const { subject, options } of pending) {
      try {
        if (!this.consumers.has(subject)) {
          await this.createSubscription(subject, options);
        }
        this.logger.log(`Activated pending subscription for ${subject}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Failed to activate pending subscription for ${subject}: ${message}`,
        );
        failures.push({ subject, message });
      }
    }

    // IMPORTANT: fail-closed — surface ALL activation failures as a single
    // error so the boot-time decision (throw vs continue) is made by the caller.
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.subject}: ${f.message}`)
        .join('\n');
      throw new Error(
        `Failed to activate ${failures.length} pending subscription(s):\n${summary}`,
      );
    }
  }

  /**
   * Clamp the desired JetStream replica count to what the connected server can
   * actually host. A standalone server (no cluster) can only host R=1 streams;
   * requesting R>1 yields a stream that cannot be recovered on restart, which
   * fails the JetStream health check and cascades every dependent service into
   * a stuck `Created` state (the production droplet outage this fixes).
   *
   * Topology is read from the server's own ServerInfo (`cluster` is populated
   * only when the node belongs to a cluster) — the authoritative source.
   * Durability is unaffected: the transactional outbox + event-store is the
   * SSoT, so JetStream replication is transport HA only, never the durability
   * contract.
   */
  private resolveEffectiveReplicas(desired: number): number {
    const info = this.connection?.info;
    const clustered =
      !!info && typeof info.cluster === 'string' && info.cluster.length > 0;
    if (!clustered && desired > 1) {
      this.logger.warn(
        `NATS server is standalone (no cluster); clamping JetStream stream ` +
          `replicas from ${desired} to 1. A standalone server cannot host a ` +
          `replicated stream. Durability is guaranteed by the transactional ` +
          `outbox + event-store, not JetStream replication. To run replicated ` +
          `JetStream, deploy a NATS cluster and set NATS_STREAM_REPLICAS to the ` +
          `node count.`,
        { desiredReplicas: desired, effectiveReplicas: 1, clustered: false },
      );
      return 1;
    }
    return desired;
  }

  /**
   * Setup the NATS JetStream stream.
   * Creates the stream if missing, or updates existing stream config to enforce
   * current limits and prevent drift from server-side nats.conf changes.
   */
  private async setupStream(): Promise<void> {
    if (!this.jetStreamManager) {
      return;
    }

    const streamConfig = this.getStreamConfig(
      this.resolveEffectiveReplicas(this.streamReplicas),
    );

    try {
      // ARCH-031: Always update existing stream config to enforce current limits.
      // Prevents drift when nats.conf max_file_store or application limits change.
      await this.jetStreamManager.streams.info(this.streamName);
      this.logger.log(`Stream ${this.streamName} already exists — updating config`);
      await this.jetStreamManager.streams.update(this.streamName, streamConfig);
      this.logger.log(`Updated stream ${this.streamName} configuration`);
    } catch {
      // Stream doesn't exist — create it
      await this.jetStreamManager.streams.add({
        name: this.streamName,
        ...streamConfig,
      });
      this.logger.log(`Created stream ${this.streamName}`);
    }
  }

  /**
   * ARCH-031: Shared JetStream stream configuration.
   * max_bytes MUST be less than nats.conf max_file_store (2GB) to leave headroom
   * for metadata and potential additional streams.
   */
  private getStreamConfig(replicas: number): Partial<StreamConfig> {
    return {
      subjects: ['events.>', 'commands.>', 'queries.>'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
      max_bytes: 1536 * 1024 * 1024, // 1.5GB — must be < nats.conf max_file_store (2GB)
      max_msg_size: 1024 * 1024, // 1MB per message
      max_msgs: 1_000_000, // 1M messages safety net
      discard: DiscardPolicy.Old,
      duplicate_window: 2 * 60 * 1_000_000_000, // 2 minutes for deduplication
      num_replicas: replicas,
    };
  }

  /**
   * Create a subscription for a subject
   */
  private async createSubscription(
    subject: string,
    options?: SubscriptionOptions,
  ): Promise<void> {
    if (!this.jetStream || !this.jetStreamManager) {
      return;
    }

    const consumerName = this.generateConsumerName(subject);

    try {
      // Create or get a pull-based consumer
      const consumerConfig: Partial<ConsumerConfig> = {
        durable_name: consumerName,
        deliver_policy:
          options?.startFrom === 'beginning'
            ? DeliverPolicy.All
            : DeliverPolicy.New,
        ack_policy: AckPolicy.Explicit,
        ack_wait: (options?.ackWait ?? 30) * 1000000000, // Convert to nanoseconds
        max_deliver: options?.maxRetries ?? 3,
        filter_subject: subject,
      };

      // ARCH-020: Use add() which creates OR updates the durable consumer.
      // Previous approach deleted and recreated, losing ack position on every restart.
      // With stable consumer names (SERVICE_NAME-based), the same durable consumer
      // survives across restarts and scaled replicas share it for load-balanced delivery.
      await this.jetStreamManager.consumers.add(this.streamName, consumerConfig);

      // Get the consumer and create a pull subscription
      const consumer = await this.jetStream.consumers.get(this.streamName, consumerName);

      // Store consumer reference
      this.consumers.set(subject, consumer);

      // Start processing messages with abort support
      this.processMessagesFromConsumer(subject, consumer);

      this.logger.log(`Subscribed to ${subject}`);
    } catch (error) {
      this.logger.error(`Failed to subscribe to ${subject}`, error);
      throw error;
    }
  }

  /**
   * Process messages from a pull-based consumer
   */
  private processMessagesFromConsumer(
    subject: string,
    consumer: Consumer,
  ): void {
    const abortController = new AbortController();
    this.abortControllers.set(subject, abortController);

    const processLoop = async (): Promise<void> => {
      try {
        const messages = await consumer.consume({
          callback: (msg) => {
            void this.processConsumerMessage(subject, msg);
          },
        });

        // Keep running until aborted
        abortController.signal.addEventListener('abort', () => {
          messages.stop();
        });
      } catch (err) {
        if (!abortController.signal.aborted) {
          this.logger.error(`Consumer error for ${subject}`, err);
        }
      }
    };

    processLoop().catch((err: unknown) => {
      if (
        !abortController.signal.aborted &&
        !errorMessage(err).includes('consumer closed')
      ) {
        this.logger.error(`Consumer loop error for ${subject}`, err);
      }
    });
  }

  private async processConsumerMessage(
    subject: string,
    msg: JsMsg,
  ): Promise<void> {
    try {
      // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
      const event = this.deserializeEvent(msg.string());
      const handlers = this.handlers.get(subject) ?? [];

      // SECURITY: Handler failures must NOT be swallowed while the
      // message is acked. A swallowed handler error permanently loses
      // the event for that handler. Route failures to retry/DLQ instead.
      let handlerFailed = false;
      for (const handler of handlers) {
        try {
          await handler.handle(event);
        } catch (handlerError) {
          handlerFailed = true;
          this.logger.error(
            `Handler error for ${event.eventType} — message will be NAK'd for retry`,
            handlerError,
          );
        }
      }

      if (handlerFailed) {
        // v3: deliveryCount replaces v2's deprecated redeliveryCount alias
        // (identical value) — exponential-backoff math unchanged.
        const deliveryCount = msg.info?.deliveryCount ?? 0;
        const backoffMs = Math.min(1000 * Math.pow(2, deliveryCount), 30000);
        msg.nak(backoffMs);
      } else {
        msg.ack();
      }
    } catch (error) {
      this.logger.error(`Message processing error on ${subject}`, error);
      // Exponential backoff on NAK: redelivery delay doubles per attempt.
      // v3 deliveryCount = number of times delivered (v2's deprecated
      // redeliveryCount alias, same value) — backoff math unchanged.
      const deliveryCount = msg.info?.deliveryCount ?? 0;
      const backoffMs = Math.min(1000 * Math.pow(2, deliveryCount), 30000);
      msg.nak(backoffMs);
    }
  }

  /**
   * Serialize event to JSON string.
   *
   * timestamp is always a string (ISO 8601) per BaseEvent contract.
   * Legacy callers that somehow pass a Date are handled via duck-typing.
   */
  private serializeEvent<TEvent extends IEvent>(event: TEvent): string {
    return JSON.stringify({
      ...event,
      timestamp:
        typeof event.timestamp === 'object' && event.timestamp !== null
          ? (event.timestamp as unknown as Date).toISOString()
          : event.timestamp,
    });
  }

  /**
   * Deserialize JSON string to event.
   *
   * WHY: Pre-fix this method applied a string→Date re-coercion on
   * `parsed.timestamp` after upcasters ran — directly contradicting
   * `IEvent.timestamp: string` and `BaseEvent.timestamp: string`. Every
   * NATS consumer therefore received a Date where TypeScript said it
   * would be a string, a kernel-level type lie (PLAT-CRITICAL-002).
   * The wire format is JSON; JSON has no Date type; the canonical
   * representation is ISO 8601 string. Removing the re-coercion aligns
   * runtime with the type system. Consumers that previously relied
   * on Date methods (e.g. `event.timestamp.getTime()`) must call
   * `Date.parse(event.timestamp)` or `new Date(event.timestamp)` at
   * the point of use — those callers were already incorrect under
   * the contract.
   *
   * WHAT: Apply upcasters and return the parsed payload as-is. The
   * timestamp stays a string per contract.
   *
   * Closes: docs/reviews/platform-kernel-expert/2026-04-28-core-platform-review.md#PLAT-CRITICAL-002
   */
  private deserializeEvent(data: string): IEvent {
    let parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) {
      throw new Error('Decoded NATS event payload must be a JSON object');
    }

    // ARCH-C01: Apply upcasters to migrate legacy event schemas
    if (this.upcasterRegistry) {
      parsed = this.upcasterRegistry.upcast(parsed);
    }

    if (!isIEvent(parsed)) {
      throw new Error('Decoded NATS event payload is missing base event fields');
    }

    return parsed;
  }

  /**
   * Normalize subject to match stream configuration
   */
  private normalizeSubject(topic: string): string {
    if (
      topic.startsWith('events.') ||
      topic.startsWith('commands.') ||
      topic.startsWith('queries.')
    ) {
      return topic;
    }

    throw new Error(
      `NATS subject must be canonical and start with events., commands., or queries.; ` +
        `got ${JSON.stringify(topic)}`,
    );
  }

  /**
   * Generate a consumer name from subject
   */
  private generateConsumerName(subject: string): string {
    return `${this.clientId}-${subject.replace(/[.>*]/g, '-')}`;
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionHandlers(): void {
    const connection = this.connection;
    if (!connection) {
      return;
    }

    // Handle connection status changes
    void (async (): Promise<void> => {
      for await (const status of connection.status()) {
        // v3: Status is a discriminated union on `type`; switching on it
        // narrows each case. The error variant carries `error: Error` (v2's
        // untyped `status.data` field was removed).
        switch (status.type) {
          case 'disconnect':
            this.connectionState = 'disconnected';
            this.logger.warn('Disconnected from NATS');
            break;
          case 'reconnecting':
            this.connectionState = 'reconnecting';
            this.logger.log('Reconnecting to NATS...');
            break;
          case 'reconnect':
            this.connectionState = 'connected';
            this.lastConnectedAt = new Date();
            this.logger.log('Reconnected to NATS');
            break;
          case 'error':
            this.logger.error('NATS connection error', String(status.error));
            break;
        }
      }
    })().catch((err: unknown) => {
      this.logger.error('Status monitor error', err);
    });
  }
}

/**
 * Helper function to create an event with metadata
 */
export function createEvent(
  eventType: string,
  tenantId: string,
  metadata?: EventMetadata,
): IEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    tenantId,
    metadata,
  };
}
