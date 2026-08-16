import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Type,
} from '@nestjs/common';
import { Client as PgClient, type ClientConfig } from 'pg';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import {
  OUTBOX_ENTITY_CLASS,
  OUTBOX_NOTIFY_DEBOUNCE_MS,
  OUTBOX_NOTIFY_RECONNECT_INITIAL_MS,
  OUTBOX_NOTIFY_RECONNECT_MAX_MS,
} from './constants';
import { OutboxEntityBase } from './outbox-entity.base';
import { OutboxWorkerService } from './outbox-worker.service';

/**
 * OutboxNotifyListener
 *
 * Long-lived PostgreSQL `LISTEN` connection that wakes the outbox
 * worker immediately on every new outbox row insert. Replaces the
 * polling-only model (1-second cron) with an event-driven model that
 * drops median publish latency from ~500 ms to ~5 ms for the bulk
 * of events, while keeping the cron running at a slower cadence
 * (5 seconds) as a deterministic safety net.
 *
 * # Why a separate service, not built into OutboxWorker
 *
 * The worker uses the shared TypeORM DataSource pool, whose
 * connections are rented per query and returned to the pool. `LISTEN`
 * requires a **single long-lived session** that persists across
 * queries — renting from a pool would drop the listener as soon as
 * the query finished, and subsequent NOTIFYs would never arrive.
 * A dedicated `pg.Client` owned by this service solves the lifecycle
 * cleanly: the DataSource remains free to handle normal queries
 * while the listener keeps a single session open.
 *
 * # Why the cron stays as a safety net
 *
 * PostgreSQL NOTIFY is NOT delivered to disconnected clients. If the
 * listener's session drops (network blip, PG restart, container
 * swap), every NOTIFY emitted during the drop window is lost forever.
 * A polling fallback recovers the system deterministically — at a
 * 5-second cadence, stuck rows are drained within one extra cycle
 * even if the listener is offline for minutes. Without a fallback,
 * a single missed NOTIFY could strand an event until a manual reply.
 *
 * # Channel naming — derived from the entity's table name
 *
 * Each consuming service registers its own concrete outbox entity
 * (e.g. `FarmOutbox extends OutboxEntityBase`) via
 * `OutboxModule.forFeature(FarmOutbox)`. This listener reads
 * `repo.metadata.tableName` at bootstrap and subscribes to the
 * channel `${tableName}_notify` (e.g. `farm_outbox_notify`). The
 * migration that installs the trigger MUST call
 * `pg_notify(tableName + '_notify', ...)` with the same name.
 * Keeping the derivation algorithmic eliminates config drift between
 * the trigger and the listener.
 *
 * # Debounce — collapsing bursts into one worker cycle
 *
 * A burst of N inserts within <100 ms produces N NOTIFY events. The
 * listener debounces them: the first NOTIFY arms a 100 ms timer, and
 * any further NOTIFY before the timer fires is coalesced. When the
 * timer fires, `worker.pollAndPublish()` runs once and drains up to
 * `OUTBOX_BATCH_SIZE` rows. This is the architecturally correct
 * behaviour — the worker already batches — and keeps CPU / DB
 * round-trips bounded on high-write bursts.
 *
 * # Reconnect loop
 *
 * On client error or unexpected disconnect, the listener logs the
 * cause and schedules a reconnect with exponential backoff starting
 * at `OUTBOX_NOTIFY_RECONNECT_INITIAL_MS` and capped at
 * `OUTBOX_NOTIFY_RECONNECT_MAX_MS`. While the listener is offline
 * the cron cycle continues to drain the outbox, so delivery is
 * never stalled — only the near-real-time latency is temporarily
 * degraded to the cron cadence.
 *
 * # Shutdown
 *
 * On `OnModuleDestroy`, the listener:
 *   1. Clears any pending debounce timer so the shutdown path does
 *      not fire a new worker cycle mid-teardown.
 *   2. Sends `UNLISTEN *` and `.end()` to the pg client.
 *   3. Does NOT wait for any in-flight worker cycle — the worker
 *      owns its own shutdown sequence and will finish cleanly via
 *      NestJS's normal lifecycle.
 *
 * @see Phase 2 checkpoint — P-C1 LISTEN/NOTIFY latency fix
 */
@Injectable()
export class OutboxNotifyListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxNotifyListener.name);
  private client?: PgClient;
  private channelName!: string;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = OUTBOX_NOTIFY_RECONNECT_INITIAL_MS;
  private shuttingDown = false;

  constructor(
    @Inject(OUTBOX_ENTITY_CLASS)
    private readonly entityClass: Type<OutboxEntityBase>,
    private readonly dataSource: DataSource,
    private readonly worker: OutboxWorkerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Derive the channel name from the concrete entity's table name.
    // The matching trigger migration MUST call pg_notify with the
    // same name — see AddFarmOutboxNotifyTrigger for the farm
    // consumer's implementation.
    const metadata = this.dataSource.getMetadata(this.entityClass);
    this.channelName = `${metadata.tableName}_notify`;

    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimers();
    if (this.client) {
      try {
        // UNLISTEN * unsubscribes from every channel this client is
        // on — there is only one, but the wildcard is the safest
        // form and matches the documented shutdown pattern.
        await this.client.query('UNLISTEN *');
        await this.client.end();
        this.logger.log(
          `Outbox LISTEN client for ${this.channelName} closed cleanly`,
        );
      } catch (err) {
        this.logger.warn(
          `Error closing outbox LISTEN client for ${this.channelName}: ${this.errorMessage(err)}`,
        );
      } finally {
        this.client = undefined;
      }
    }
  }

  /**
   * Open a dedicated pg.Client using the DataSource's connection
   * settings, attach the notification + error handlers, and run
   * `LISTEN` on the derived channel. On any failure, schedules a
   * reconnect — the cron cycle drains the outbox in the meantime.
   */
  private async connect(): Promise<void> {
    if (this.shuttingDown) return;

    const config = this.buildClientConfig();
    if (!config) {
      // Non-postgres DataSource (e.g. sqlite in tests) — LISTEN is a
      // pg-only feature, so the listener disables itself without
      // crashing the app. The worker still polls via the cron
      // safety net, which gives the same delivery guarantees at a
      // slightly higher latency.
      this.logger.warn(
        'DataSource is not PostgreSQL — outbox LISTEN/NOTIFY disabled. The worker will continue to drain via cron polling.',
      );
      return;
    }

    const client = new PgClient(config);

    client.on('notification', (msg) => {
      if (msg.channel !== this.channelName) return;
      this.scheduleDrain();
    });

    client.on('error', (err) => {
      this.logger.error(
        `Outbox LISTEN client error on ${this.channelName}: ${err.message}`,
      );
      this.handleDisconnect(client);
    });

    client.on('end', () => {
      if (this.shuttingDown) return;
      this.logger.warn(
        `Outbox LISTEN client unexpectedly ended on ${this.channelName}`,
      );
      this.handleDisconnect(client);
    });

    try {
      await client.connect();
      // Channel name is derived from metadata.tableName, which is
      // a compile-time constant from the consuming service's entity
      // decorator — not user input. SQL injection is not possible
      // here because the value is controlled by trusted code only,
      // but we still quote defensively.
      await client.query(`LISTEN "${this.channelName}"`);
      this.client = client;
      this.reconnectDelayMs = OUTBOX_NOTIFY_RECONNECT_INITIAL_MS;
      this.logger.log(
        `Outbox LISTEN connected for ${this.channelName} — event-driven wake-up active`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to open outbox LISTEN connection for ${this.channelName}: ${this.errorMessage(err)}`,
      );
      // Best-effort cleanup — ignore errors from a client that never
      // finished connecting.
      try {
        await client.end();
      } catch {
        // Silent — the initial connect already failed, client may
        // be in an unrecoverable state.
      }
      this.scheduleReconnect();
    }
  }

  /**
   * Debounce: arm a single-shot timer that fires `pollAndPublish()`
   * after `OUTBOX_NOTIFY_DEBOUNCE_MS`. Subsequent NOTIFY events
   * within the window reset the timer back to the same one-shot
   * schedule, so a burst of N inserts produces exactly one worker
   * drain call.
   */
  private scheduleDrain(): void {
    if (this.shuttingDown) return;
    if (this.debounceTimer) return; // already armed, coalesce

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      // `pollAndPublish` is async but we intentionally do not await
      // it — the listener's job is to wake the worker, not to block
      // on its completion. The worker owns its own re-entry guard
      // via the `processing` flag.
      void this.worker.pollAndPublish();
    }, OUTBOX_NOTIFY_DEBOUNCE_MS);
  }

  /**
   * Drop a failed client and schedule a reconnect with exponential
   * backoff. The cron safety net continues to drain the outbox
   * while the listener is offline, so events are never lost — only
   * the near-real-time latency degrades to the cron cadence.
   */
  private handleDisconnect(failedClient: PgClient): void {
    if (this.shuttingDown) return;

    // Guard against double-handling if both 'error' and 'end'
    // fire for the same failure.
    if (this.client !== failedClient) return;
    this.client = undefined;

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    const delay = Math.min(this.reconnectDelayMs, OUTBOX_NOTIFY_RECONNECT_MAX_MS);
    this.logger.log(
      `Outbox LISTEN reconnect scheduled for ${this.channelName} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // Double the next backoff (capped by max) for exponential
      // behaviour. Successful connect resets this in connect().
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        OUTBOX_NOTIFY_RECONNECT_MAX_MS,
      );
      void this.connect();
    }, delay);
  }

  /**
   * Build a pg.ClientConfig from the DataSource's Postgres options.
   * Returns `null` for non-Postgres DataSources so the listener can
   * cleanly no-op on sqlite/test environments.
   */
  private buildClientConfig(): ClientConfig | null {
    const options = this.dataSource.options;
    if (options.type !== 'postgres') {
      return null;
    }
    // Narrow to the Postgres-specific options type. TypeORM's union
    // type is widened to DataSourceOptions here; the type guard
    // above satisfies the narrowing.
    const pgOptions: PostgresConnectionOptions = options;

    const config: ClientConfig = {
      host: pgOptions.host,
      port: pgOptions.port,
      user: pgOptions.username,
      password:
        typeof pgOptions.password === 'string' ? pgOptions.password : undefined,
      database: pgOptions.database,
    };

    // Propagate SSL settings if present — the shared bootstrap
    // factory enforces cert validation in production, and the
    // listener must use the same trust settings as the pooled
    // connections to avoid a mixed-trust surprise.
    if (pgOptions.ssl !== undefined && pgOptions.ssl !== false) {
      config.ssl = pgOptions.ssl as ClientConfig['ssl'];
    }

    return config;
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
