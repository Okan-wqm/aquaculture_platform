import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

import { toError } from '../../common/error-normalization';

/**
 * RedisIoAdapter
 *
 * Application-level Socket.IO adapter that attaches `@socket.io/redis-adapter`
 * to every namespace created by NestJS gateways. Used in place of the
 * default in-memory `IoAdapter` so horizontally scaled `gateway-api` pods
 * broadcast Socket.IO events to every connected client — not just to the
 * clients that happen to be connected to the pod that received the NATS
 * message.
 *
 * # Why app-level, not per-gateway
 *
 * Each NestJS gateway (`@WebSocketGateway`) creates its own Socket.IO
 * server instance on a distinct namespace. Historically the messaging
 * gateway wired its own `createAdapter(pub, sub)` inside `afterInit()`,
 * but that pattern has three structural problems:
 *
 *   1. Per-gateway adapters mean each new gateway must reimplement the
 *      wiring, guaranteeing drift and broken gateways (verified: as of
 *      the P-M6 audit, farm/sensor/st-language gateways had NO adapter
 *      at all, so their broadcasts were pod-local and clients connected
 *      to peer pods never received the events).
 *
 *   2. Each per-gateway adapter creates its OWN pair of Redis pub/sub
 *      clients. N gateways × 2 connections per pod = N × 2 Redis
 *      connections per pod, scaling linearly with gateway count.
 *
 *   3. Lifecycle is fragmented — a Redis connection drop in one gateway
 *      does not surface to the others, so the pod partially degrades
 *      in ways that are hard to reason about and monitor.
 *
 * An app-level adapter registered via `app.useWebSocketAdapter()` hooks
 * the Socket.IO server creation for EVERY gateway in the app with a
 * SINGLE pair of pub/sub Redis clients. New gateways inherit the
 * horizontal-scale behaviour for free without adapter code.
 *
 * # Lifecycle
 *
 *   1. `bootstrapService()` calls `NestFactory.create(AppModule)`.
 *   2. `onBeforeListen` hook constructs this adapter, calls
 *      `connectToRedis(url)` to open the pub/sub clients, and registers
 *      the adapter via `app.useWebSocketAdapter(adapter)`. This MUST
 *      happen before `app.listen()` — see main.ts.
 *   3. When `app.listen()` binds, NestJS calls `createIOServer()` on
 *      the registered adapter for each gateway namespace. This class
 *      overrides that method to attach the Redis adapter to the newly
 *      created `Server` instance.
 *   4. On SIGTERM / graceful shutdown, NestJS invokes
 *      `onApplicationShutdown` (via `enableShutdownHooks()`), which
 *      closes both Redis clients so the pod exits cleanly.
 *
 * # Fail-closed in production
 *
 * The adapter itself does not decide the fail mode — `main.ts` is
 * responsible for the hard-fail on missing `REDIS_URL` in production.
 * If `connectToRedis()` throws, the caller (main.ts) decides whether
 * to propagate (prod) or fall back to the default in-memory adapter
 * (dev). Keeping the policy at the boot site keeps this class
 * re-usable from any NestJS entry point.
 *
 * @see apps/gateway-api/src/main.ts for the wiring + hard-fail policy.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient?: Redis;
  private subClient?: Redis;
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  /**
   * Open the Redis pub/sub connection pair and prepare the adapter
   * constructor. Must be awaited before `app.useWebSocketAdapter(this)`
   * so the adapter is ready when NestJS invokes `createIOServer`.
   *
   * Throws if the connection fails. Callers in production contexts
   * should propagate the error and fail startup; dev contexts may
   * catch and fall back to in-memory broadcasting.
   *
   * @param url Full Redis connection URL including optional auth and
   *   database index, e.g. `redis://:password@host:6379/0`. Mirrors
   *   the `REDIS_URL` environment variable used across the platform.
   */
  async connectToRedis(url: string): Promise<void> {
    // ioredis is the platform's single Redis client (A4 dead-weight: the
    // `redis`/node-redis package was a second client used ONLY here).
    // `@socket.io/redis-adapter` accepts ioredis pub/sub clients directly.
    // `lazyConnect: true` keeps the fail-closed semantics the boot site
    // relies on: `connect()` REJECTS on a failed connection (so main.ts can
    // hard-fail in production) rather than only emitting an 'error' event.
    const pubClient = new Redis(url, { lazyConnect: true });
    const subClient = pubClient.duplicate();

    // Attach an error handler BEFORE connect() so transient errors
    // after connection do not become unhandled exceptions. Redis
    // clients emit 'error' for network blips; without a handler the
    // Node process would crash.
    pubClient.on('error', (err: Error) => {
      this.logger.error(
        `Socket.IO Redis pub client error: ${err.message}`,
      );
    });
    subClient.on('error', (err: Error) => {
      this.logger.error(
        `Socket.IO Redis sub client error: ${err.message}`,
      );
    });

    await Promise.all([pubClient.connect(), subClient.connect()]);

    this.pubClient = pubClient;
    this.subClient = subClient;
    this.adapterConstructor = createAdapter(pubClient, subClient);

    this.logger.log(
      'Socket.IO Redis adapter connected — horizontal-scale broadcast enabled for all gateways',
    );
  }

  /**
   * NestJS calls this for every Socket.IO server instance it creates
   * (one per `@WebSocketGateway` namespace). We chain to the base
   * `IoAdapter` to build the server as usual, then attach the Redis
   * adapter constructor so subscriptions fan out across pods.
   *
   * If `connectToRedis` was never called (e.g. dev environment with
   * no `REDIS_URL` and the boot site chose to register this adapter
   * anyway), we log a warning once per namespace and return the base
   * server unchanged — the gateway continues to work in single-pod mode.
   * In practice main.ts never registers this adapter without a
   * successful connect, so this branch is a safety net.
   */
  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      this.logger.warn(
        'Socket.IO server created before connectToRedis() — falling back to in-memory adapter for this namespace',
      );
    }

    return server;
  }

  /**
   * Graceful shutdown — NestJS invokes this when the app receives
   * SIGTERM / SIGINT (because `enableShutdownHooks()` is called in
   * the shared bootstrap factory). We close the pub/sub clients so
   * the process exits cleanly and Redis releases the server-side
   * connection slots.
   *
   * `quit()` flushes any in-flight commands before closing; `disconnect()`
   * would be a hard close and may lose pending publishes. For Socket.IO
   * pub/sub the difference is rarely observable, but `quit()` is the
   * polite default and costs nothing.
   */
  async dispose(): Promise<void> {
    const errors: Error[] = [];

    if (this.pubClient) {
      try {
        await this.pubClient.quit();
      } catch (err) {
        errors.push(toError(err));
      } finally {
        this.pubClient = undefined;
      }
    }

    if (this.subClient) {
      try {
        await this.subClient.quit();
      } catch (err) {
        errors.push(toError(err));
      } finally {
        this.subClient = undefined;
      }
    }

    this.adapterConstructor = undefined;

    if (errors.length > 0) {
      this.logger.warn(
        `RedisIoAdapter shutdown completed with ${errors.length} client close error(s): ${errors.map((e) => e.message).join('; ')}`,
      );
    } else {
      this.logger.log('RedisIoAdapter shut down cleanly');
    }
  }
}

/**
 * Helper: register a `RedisIoAdapter` on the given app and hook a
 * shutdown listener so the pub/sub clients close on SIGTERM. Kept in
 * this file rather than in `main.ts` so the adapter's lifecycle is
 * owned end-to-end in one place — callers only need to decide the
 * fail-mode (hard-fail vs warn) and pass a URL.
 *
 * Returns the registered adapter so callers can reference it for
 * observability or advanced lifecycle control. Callers that just want
 * "the adapter is wired" can ignore the return value.
 *
 * @throws Any error from the initial Redis connection. Callers in
 *   production should propagate; dev callers may catch and fall back.
 */
export async function registerRedisIoAdapter(
  app: INestApplication,
  redisUrl: string,
): Promise<RedisIoAdapter> {
  const adapter = new RedisIoAdapter(app);
  await adapter.connectToRedis(redisUrl);
  app.useWebSocketAdapter(adapter);

  // Hook graceful shutdown. `enableShutdownHooks()` is already called
  // by the shared bootstrap factory so we can rely on NestJS to fire
  // `beforeApplicationShutdown` / `onApplicationShutdown` in order.
  // Registering via `beforeApplicationShutdown` specifically so the
  // Redis clients close BEFORE NestJS tears down gateway Socket.IO
  // servers (which would otherwise try to publish one last disconnect
  // event through an already-closed adapter and log an error).
  app.enableShutdownHooks();

  // INestApplication does not expose beforeApplicationShutdown as a
  // direct method — the proper hook is an `OnModuleDestroy` provider
  // or a SIGTERM listener. Use a SIGTERM listener here so the teardown
  // works regardless of the NestJS lifecycle internals, and guard
  // against double-wiring by using `once`.
  const teardown = async (): Promise<void> => {
    try {
      await adapter.dispose();
    } catch {
      // Silent — the adapter logs its own errors.
    }
  };
  process.once('SIGTERM', teardown);
  process.once('SIGINT', teardown);

  return adapter;
}
