import { createServer, type Server, type Socket } from 'node:net';

/**
 * A NATS broker that speaks just enough of the text protocol (INFO, CONNECT,
 * PING/PONG, SUB/UNSUB, MSG) for a real @nats-io client to connect,
 * subscribe and receive. It can go away and come back on the same port, so a
 * spec can watch the client recover instead of mocking it.
 */
export class FakeNatsServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  /** Subscriptions of the open sockets: sid → subject. */
  private readonly subscriptions = new Map<Socket, Map<string, string>>();
  /** Every connection accepted so far, across restarts. */
  accepted = 0;

  private constructor(readonly port: number) {}

  /** A server on a free port that is not listening yet. */
  static async onFreePort(): Promise<FakeNatsServer> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return new FakeNatsServer(port);
  }

  get url(): string {
    return `nats://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.server = server;
  }

  /** Stops listening and drops every client, as a broker that goes down. */
  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.subscriptions.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** The subscription ids the open clients hold on `subject`. */
  sidsOn(subject: string): string[] {
    return [...this.subscriptions.values()].flatMap((subs) =>
      [...subs].filter(([, s]) => s === subject).map(([sid]) => sid),
    );
  }

  /** Delivers `payload` once to every open subscription on `subject`. */
  publish(subject: string, payload: string): void {
    for (const [socket, subs] of this.subscriptions) {
      for (const [sid, s] of subs) {
        if (s === subject) {
          socket.write(`MSG ${subject} ${sid} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
        }
      }
    }
  }

  private accept(socket: Socket): void {
    this.accepted += 1;
    this.sockets.add(socket);
    this.subscriptions.set(socket, new Map());
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.subscriptions.delete(socket);
    });
    socket.on('error', () => undefined);
    socket.write(
      `INFO ${JSON.stringify({ server_id: 'fake', version: '2.10.0', proto: 1, headers: true, max_payload: 1048576 })}\r\n`,
    );
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let end = buffered.indexOf('\r\n');
      while (end !== -1) {
        this.command(socket, buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf('\r\n');
      }
    });
  }

  private command(socket: Socket, line: string): void {
    const [verb, ...args] = line.split(' ');
    const subs = this.subscriptions.get(socket);
    if (verb === 'PING') {
      socket.write('PONG\r\n');
    } else if (verb === 'SUB' && subs !== undefined) {
      // SUB <subject> [queue] <sid>
      subs.set(args[args.length - 1] ?? '', args[0] ?? '');
    } else if (verb === 'UNSUB' && subs !== undefined) {
      subs.delete(args[0] ?? '');
    }
  }
}
