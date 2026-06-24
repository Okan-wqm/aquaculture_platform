/**
 * NatsV3Server — a platform-owned NATS `CustomTransportStrategy` on @nats-io/* v3.
 *
 * WHY (PLAT-HIGH-003): @nestjs/microservices' built-in `ServerNats` constructs its
 * serializers with `require('nats').JSONCodec()`, removed in the v3 split. This is a
 * faithful port of `ServerNats` (node_modules/@nestjs/microservices/server/server-nats.js)
 * that swaps only the nats-v2 client API for `@nats-io/{nats-core,transport-node}` and
 * the JSONCodec serializers for the byte-compatible `nats-v3-codec` (proven in
 * nats-v3-wire-compat.spec.ts). The wire payload, subject naming (`normalizePattern`,
 * inherited from the Nest `Server` base), queue groups, and reply protocol are
 * unchanged, so a migrated v3 service answers an un-migrated v2 caller during a
 * rolling deploy with zero broker migration.
 *
 * WHAT: extends the Nest `Server` base (reusing `messageHandlers`, `getHandlerByPattern`,
 * `handleEvent`, `transformToObservable`, `send`, `normalizePattern`) and implements
 * `listen`/`close`/`unwrap`. The connection options are resolved internally from
 * `buildNatsConnectionOptions(serviceName)` (the ADR-015 cert-is-identity SSoT), so the
 * cutover site passes only `{ serviceName, queue }`.
 */
import type { ConnectionOptions, Msg, NatsConnection, Subscription } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import {
  CustomTransportStrategy,
  IncomingRequest,
  NatsContext,
  Server,
  WritePacket,
} from '@nestjs/microservices';

import { buildNatsConnectionOptions } from './nats-connection.factory';
import { NatsV3RequestDeserializer, NatsV3ResponseSerializer } from './nats-v3-codec';

// Nest's exact constants.NO_MESSAGE_HANDLER string, inlined so the error envelope a v3
// server returns is byte-identical to what v2 callers expect.
const NO_MESSAGE_HANDLER = 'There is no matching message handler defined in the remote service.';

/**
 * Strategy options. `serviceName` selects the mTLS client cert through
 * {@link buildNatsConnectionOptions} (ADR-015 cert-is-identity); `queue` is the default
 * NATS queue group for handlers that don't override it via `@MessagePattern` extras.
 */
export interface NatsV3ServerOptions {
  serviceName?: string;
  queue?: string;
}

export class NatsV3Server extends Server implements CustomTransportStrategy {
  private natsConnection: NatsConnection | null = null;
  private readonly subscriptions: Subscription[] = [];

  constructor(private readonly options: NatsV3ServerOptions = {}) {
    super();
    // Drop-in for Nest's JSONCodec serializers; the Server base invokes these.
    this.serializer = new NatsV3ResponseSerializer();
    this.deserializer = new NatsV3RequestDeserializer();
  }

  public async listen(callback: (...optionalParams: unknown[]) => void): Promise<void> {
    try {
      this.natsConnection = await this.createNatsConnection();
      this.bindHandlers(this.natsConnection);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  public async close(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    await this.natsConnection?.close();
    this.natsConnection = null;
  }

  /**
   * Escape hatch declared abstract by the Nest `Server` base (server.d.ts:37) as the
   * unsound generic `unwrap<T>(): T` — the caller asserts the concrete client type. We
   * surface the live `NatsConnection` through an `unknown` intermediate, mirroring
   * Nest's own `ServerNats.unwrap`; the single framework-mandated assertion is explicit.
   */
  public unwrap<T>(): T {
    if (!this.natsConnection) {
      throw new Error('NatsV3Server is not initialized — call listen() first.');
    }
    const connection: unknown = this.natsConnection;
    return connection as T;
  }

  /**
   * Abstract on the Nest `Server` base (server.d.ts:32). PR-B surfaces no transport
   * status events — @nats-io owns reconnect — so this is a no-op. The signature
   * mirrors the base's default `EventsMap = Record<string, Function>` instantiation
   * exactly so it satisfies the abstract member.
   */
  public on<
    EventKey extends keyof Record<string, Function> = keyof Record<string, Function>,
    EventCallback extends Record<string, Function>[EventKey] = Record<string, Function>[EventKey],
  >(_event: EventKey, _callback: EventCallback): void {
    /* intentionally empty — see doc comment */
  }

  private createNatsConnection(): Promise<NatsConnection> {
    // ADR-015: the factory yields fully-formed ConnectionOptions at connect time.
    // Spread the whole result (authMode is an excess field connect() ignores),
    // matching the PR-A event-bus pattern that keeps the type-aware lint clean.
    const factoryOptions = buildNatsConnectionOptions(this.options.serviceName);
    const connectionOptions: ConnectionOptions = { ...factoryOptions };
    return connect(connectionOptions);
  }

  private bindHandlers(nc: NatsConnection): void {
    const defaultQueue = this.options.queue;
    for (const channel of this.messageHandlers.keys()) {
      const handlerRef = this.messageHandlers.get(channel);
      const queue = handlerRef?.extras?.['queue'] ?? defaultQueue;
      const subscription = nc.subscribe(channel, {
        ...(queue ? { queue } : {}),
        // err/msg infer from @nats-io's MsgCallback<Msg> via the subscribe options.
        callback: (err, msg) => {
          if (err) {
            this.logger.error(err instanceof Error ? err.message : String(err));
            return;
          }
          void this.handleNatsMessage(channel, msg);
        },
      });
      this.subscriptions.push(subscription);
    }
  }

  private async handleNatsMessage(channel: string, natsMsg: Msg): Promise<void> {
    const natsCtx = new NatsContext([natsMsg.subject, natsMsg.headers]);
    const message = (await this.deserializer.deserialize(natsMsg.data, {
      channel,
      replyTo: natsMsg.reply,
    })) as IncomingRequest;

    // No id ⇒ fire-and-forget event (no reply expected).
    if (message.id === undefined) {
      await this.handleEvent(channel, message, natsCtx);
      return;
    }

    const handler = this.getHandlerByPattern(channel);
    if (!handler) {
      // Byte-identical to Nest's no-handler envelope: id FIRST, then status, err
      // (Nest hand-builds `{ id, status, err }`; routing it through buildPublisher's
      // `{ ...response, id }` spread would put id LAST and diverge on the wire).
      if (natsMsg.reply) {
        const outgoing = this.serializer.serialize({
          id: message.id,
          status: 'error',
          err: NO_MESSAGE_HANDLER,
        });
        natsMsg.respond(outgoing.data);
      }
      return;
    }

    const publish = this.buildPublisher(natsMsg, message.id);
    const response$ = this.transformToObservable(await handler(message.data, natsCtx));
    this.send(response$, publish);
  }

  private buildPublisher(natsMsg: Msg, id: string): (response: WritePacket) => void {
    return (response: WritePacket): void => {
      // Reply only when the caller supplied a reply inbox (request/response).
      if (!natsMsg.reply) {
        return;
      }
      const outgoing = this.serializer.serialize({ ...response, id });
      natsMsg.respond(outgoing.data);
    };
  }
}
