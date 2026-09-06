/**
 * NatsV3Client — a platform-owned NATS `ClientProxy` on @nats-io/* v3.
 *
 * WHY (PLAT-HIGH-003): @nestjs/microservices' built-in `ClientNats` constructs its
 * serializer with `require('nats').JSONCodec()`, removed in the v3 split. This is a
 * faithful port of `ClientNats` (node_modules/@nestjs/microservices/client/client-nats.js)
 * that swaps only the nats-v2 client API for `@nats-io/{nats-core,transport-node}` and
 * the JSONCodec serializers for the byte-compatible `nats-v3-codec`. Request/reply uses
 * the same unique-inbox + reply-subject protocol, so a v3 client interoperates with an
 * un-migrated v2 server during a rolling deploy.
 *
 * WHAT: extends the Nest `ClientProxy` base (reusing `assignPacketId`, `normalizePattern`,
 * `serializer`/`deserializer` wiring) and implements `connect`/`close`/`publish`/
 * `dispatchEvent`/`unwrap`. Connection options are resolved internally from
 * `buildNatsConnectionOptions(serviceName)` (the ADR-015 cert-is-identity SSoT), so the
 * registration site passes only `{ serviceName, inboxPrefix }`.
 */
import type { ConnectionOptions, Msg, NatsConnection } from '@nats-io/nats-core';
import { createInbox } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import {
  ClientProxy,
  IncomingResponse,
  ReadPacket,
  WritePacket,
} from '@nestjs/microservices';

import { buildNatsConnectionOptions } from './nats-connection.factory';
import { NatsV3RequestSerializer, NatsV3ResponseDeserializer } from './nats-v3-codec';

/**
 * Client options. `serviceName` is the connection display name; the mounted
 * certificate selects identity through {@link buildNatsConnectionOptions}.
 * `inboxPrefix` selects an explicitly granted domain-specific reply contract.
 * Otherwise replies use the factory's certificate-scoped inbox (ADR-015).
 */
export interface NatsV3ClientOptions {
  serviceName?: string;
  inboxPrefix?: string;
}

export class NatsV3Client extends ClientProxy {
  private natsConnection: NatsConnection | null = null;
  private connectionPromise: Promise<NatsConnection> | null = null;
  private replyInboxPrefix: string | undefined;

  constructor(private readonly options: NatsV3ClientOptions = {}) {
    super();
    this.serializer = new NatsV3RequestSerializer();
    this.deserializer = new NatsV3ResponseDeserializer();
  }

  public async connect(): Promise<NatsConnection> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    // ADR-015: factory yields fully-formed ConnectionOptions; spread whole (authMode
    // is an excess field connect() ignores), mirroring the PR-A event-bus pattern.
    const factoryOptions = buildNatsConnectionOptions(this.options.serviceName);
    const connectionOptions: ConnectionOptions = { ...factoryOptions };
    this.replyInboxPrefix = this.options.inboxPrefix ?? factoryOptions.inboxPrefix;
    this.connectionPromise = connect(connectionOptions);
    try {
      this.natsConnection = await this.connectionPromise;
    } catch (err) {
      this.connectionPromise = null;
      throw err;
    }
    return this.natsConnection;
  }

  public async close(): Promise<void> {
    await this.natsConnection?.close();
    this.natsConnection = null;
    this.connectionPromise = null;
  }

  /**
   * Escape hatch declared abstract by the Nest `ClientProxy` base (client-proxy.d.ts:35)
   * as the unsound generic `unwrap<T>(): T`. We surface the live `NatsConnection` through
   * an `unknown` intermediate, mirroring Nest's own `ClientNats.unwrap`.
   */
  public unwrap<T>(): T {
    if (!this.natsConnection) {
      throw new Error('NatsV3Client is not connected — call connect() first.');
    }
    const connection: unknown = this.natsConnection;
    return connection as T;
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    try {
      const nc = this.assertConnection();
      const packet = this.assignPacketId(partialPacket);
      const channel = this.normalizePattern(partialPacket.pattern);
      const serialized = this.serializer.serialize(packet);
      const inbox = createInbox(this.replyInboxPrefix);
      // Inline non-async callback (contextually typed by @nats-io MsgCallback) that
      // fire-and-forgets the async reply handling — mirrors the server strategy's
      // subscribe pattern and avoids the Promise<void>-vs-void mismatch a returned
      // async MsgCallback hits.
      const subscription = nc.subscribe(inbox, {
        callback: (err, natsMsg) => {
          void this.handleReply(err, natsMsg, packet.id, channel, callback);
        },
      });
      nc.publish(channel, serialized.data, { reply: inbox });
      return () => subscription.unsubscribe();
    } catch (err) {
      callback({ err });
      return () => {
        /* connection failed before subscribe — nothing to tear down */
      };
    }
  }

  protected dispatchEvent<T = unknown>(packet: ReadPacket): Promise<T> {
    const nc = this.assertConnection();
    const channel = this.normalizePattern(packet.pattern);
    const serialized = this.serializer.serialize(packet);
    nc.publish(channel, serialized.data);
    // Events carry no reply; the abstract base types this as Promise<T> for the
    // request case, so a void resolution is surfaced through the framework generic.
    return Promise.resolve() as Promise<T>;
  }

  private async handleReply(
    err: unknown,
    natsMsg: Msg,
    requestId: string,
    channel: string,
    callback: (packet: WritePacket) => void,
  ): Promise<void> {
    if (err) {
      callback({ err });
      return;
    }
    if (natsMsg.data.length === 0) {
      // Functionally equivalent to Nest's EmptyResponseException (isDisposed + error
      // path); that class is not re-exported from the package root, and nothing
      // catches it by type, so a plain Error with the same message suffices.
      callback({
        err: new Error(`Empty NATS response for pattern "${channel}".`),
        isDisposed: true,
      });
      return;
    }
    const message: IncomingResponse = await this.deserializer.deserialize(natsMsg.data);
    // The inbox is unique per request; a mismatched id can only be a stray
    // late delivery — ignore it defensively (mirrors Nest's ClientNats).
    if (message.id && message.id !== requestId) {
      return;
    }
    const { err: responseErr, response, isDisposed } = message;
    callback({
      err: responseErr,
      response,
      isDisposed: Boolean(isDisposed) || Boolean(responseErr),
    });
  }

  private assertConnection(): NatsConnection {
    if (!this.natsConnection) {
      throw new Error('NatsV3Client is not connected — call connect() first.');
    }
    return this.natsConnection;
  }
}
