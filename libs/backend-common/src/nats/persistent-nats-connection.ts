/**
 * PersistentNatsConnection — the NATS connection of a long-lived subscriber.
 *
 * WHY (PLAT-HIGH-939): the gateway's WebSocket bridges and sensor-service's
 * request responders each called `connect()` once at boot and logged the
 * error. A broker that was slow or away at that moment left the component
 * without a connection until the process restarted: on 2026-11-01 the farm
 * bridge's TLS handshake timed out while the gateway composed its supergraph,
 * and live farm updates stopped. The factory's reconnect budget (50 attempts,
 * NATS_MAX_RECONNECT_ATTEMPTS) also let a connected client give up for good
 * after a long outage.
 *
 * WHAT: the connection is made in the background, so boot never waits for the
 * broker. A failed attempt is retried with a growing delay (the factory's
 * reconnect wait, doubling up to 30 s) until one succeeds. Once connected, the
 * client reconnects without limit and restores every subscription itself, so
 * `onConnected` is the only place a component subscribes and no component
 * handles `reconnect`. If the broker closes the connection anyway, a new one
 * is made and `onConnected` runs again on it. Options come only from
 * {@link buildNatsConnectionOptions}: identity is the mTLS certificate (ADR-015).
 */
import type { ConnectionOptions, NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';

import { buildNatsConnectionOptions } from './nats-connection.factory';

const MAX_RETRY_DELAY_MS = 30_000;
/** Base retry delay until the factory has given one (its NATS_RECONNECT_TIME_WAIT_MS default). */
const DEFAULT_RETRY_WAIT_MS = 2_000;

export interface PersistentNatsConnectionOptions {
  /** Connection name passed to the factory; under mTLS the certificate CN is the identity. */
  readonly name: string;
  /**
   * Runs on every new connection: the first one, and one that replaces a
   * connection the broker closed. Subscriptions made here survive reconnects.
   */
  readonly onConnected: (connection: NatsConnection) => void;
}

export class PersistentNatsConnection {
  private readonly logger = new Logger(PersistentNatsConnection.name);
  private connection: NatsConnection | null = null;
  private running: Promise<void> | null = null;
  private endPause: (() => void) | null = null;
  private retryWaitMs = DEFAULT_RETRY_WAIT_MS;
  private stopped = false;

  constructor(private readonly options: PersistentNatsConnectionOptions) {}

  /** Starts connecting in the background. Calling it again does nothing. */
  open(): void {
    if (this.running === null && !this.stopped) {
      this.running = this.run();
    }
  }

  /** The live connection, or null while connecting. */
  get current(): NatsConnection | null {
    return this.connection;
  }

  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }

  /**
   * Drains the connection and stops connecting. An attempt still in flight
   * ends within the connect timeout, and the connection it makes is closed
   * at once, before this resolves.
   */
  async close(): Promise<void> {
    this.stopped = true;
    this.endPause?.();
    const connection = this.connection;
    this.connection = null;
    if (connection !== null && !connection.isClosed()) {
      try {
        await connection.drain();
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'nats_drain_failed',
            name: this.options.name,
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      }
    }
    await this.running;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const connection = await this.attempt(failures + 1);
      if (connection === null) {
        failures += 1;
        await this.pause(this.retryDelay(failures));
        continue;
      }
      if (this.stopped) {
        await connection.close();
        return;
      }
      this.logger.log(
        JSON.stringify({
          event: 'nats_connected',
          name: this.options.name,
          attempts: failures + 1,
        }),
      );
      failures = 0;
      this.connection = connection;
      this.watchStatus(connection);
      this.options.onConnected(connection);
      const closedBy = await connection.closed();
      if (this.stopped) {
        return;
      }
      this.connection = null;
      this.logger.error(
        JSON.stringify({
          event: 'nats_connection_closed_unexpectedly',
          name: this.options.name,
          errorType: closedBy instanceof Error ? closedBy.name : 'none',
        }),
      );
    }
  }

  private async attempt(attempt: number): Promise<NatsConnection | null> {
    try {
      const factoryOptions = buildNatsConnectionOptions(this.options.name);
      this.retryWaitMs = factoryOptions.reconnectTimeWait;
      // Unlimited: a connected client never gives up and closes on its own.
      const options: ConnectionOptions = { ...factoryOptions, maxReconnectAttempts: -1 };
      const connection: NatsConnection = await connect(options);
      return connection;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'nats_connect_failed',
          name: this.options.name,
          attempt,
          errorType: error instanceof Error ? error.name : 'UnknownError',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  private retryDelay(failures: number): number {
    return Math.min(this.retryWaitMs * 2 ** Math.min(failures - 1, 10), MAX_RETRY_DELAY_MS);
  }

  /** Waits `ms`, or less when close() is called meanwhile. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // `end` runs only after this executor returns, when `timer` is set.
      const end = (): void => {
        clearTimeout(timer);
        this.endPause = null;
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.endPause = end;
    });
  }

  private watchStatus(connection: NatsConnection): void {
    (async () => {
      for await (const status of connection.status()) {
        switch (status.type) {
          case 'disconnect':
            this.logger.warn(
              JSON.stringify({ event: 'nats_disconnected', name: this.options.name }),
            );
            break;
          case 'reconnect':
            this.logger.log(JSON.stringify({ event: 'nats_reconnected', name: this.options.name }));
            break;
          case 'error':
            this.logger.error(
              JSON.stringify({
                event: 'nats_error',
                name: this.options.name,
                error: String(status.error),
              }),
            );
            break;
        }
      }
    })().catch((error: unknown) => {
      this.logger.error(
        JSON.stringify({
          event: 'nats_status_loop_failed',
          name: this.options.name,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    });
  }
}
