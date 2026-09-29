import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { from, type Observable } from 'rxjs';

/** One request-reply exchange that crossed the in-process "wire". */
export interface WireExchange {
  readonly subject: string;
  /** The request exactly as ai-service put it on the wire (after JSON round-trip). */
  readonly request: Record<string, unknown>;
  /** The reply exactly as the responder put it on the wire (after JSON round-trip). */
  readonly reply: unknown;
}

type ResponderMethod = (payload: unknown) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON round-trip — what NATS does to every request and reply (Dates → strings, no prototypes). */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * A NATS request-reply transport that routes each subject to the REAL
 * farm-service responder method registered for it with `@MessagePattern`,
 * the way Nest's microservice server does in production.
 *
 * WHY route by the decorator metadata instead of a hand-written subject map:
 * the red-team must exercise the responder production would call for a
 * subject. A hand map could point at a different method and still pass.
 *
 * `serveAs` simulates the failure the consumer-side check exists for — a
 * responder (or anything between it and ai-service) that serves a DIFFERENT
 * tenant than the request named. The rewrite happens before the real
 * responder runs, so the reply really carries that tenant's rows.
 */
export class InProcessNatsTransport {
  readonly exchanges: WireExchange[] = [];
  private readonly routes = new Map<string, ResponderMethod>();
  private servedTenantOverride: string | null = null;

  /**
   * The `send` a TenantBoundNatsClient calls. Declared as a plain `jest.Mock`
   * because `ClientProxy.send` is generic in its reply type: what comes back
   * is decided by the responder at runtime, exactly as on a real wire, and the
   * client's own `verifyTenantBoundReply` is what types it.
   */
  readonly send: jest.Mock = jest.fn(
    (subject: string, data: unknown): Observable<unknown> => from(this.dispatch(subject, data)),
  );

  constructor(responders: readonly object[]) {
    for (const responder of responders) {
      const prototype: unknown = Object.getPrototypeOf(responder);
      if (!isRecord(prototype)) continue;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const method: unknown = Reflect.get(responder, name);
        if (typeof method !== 'function') continue;
        const patterns: unknown = Reflect.getMetadata(PATTERN_METADATA, method);
        if (!Array.isArray(patterns)) continue;
        for (const pattern of patterns) {
          if (typeof pattern !== 'string') continue;
          if (this.routes.has(pattern)) throw new Error(`two responders claim ${pattern}`);
          this.routes.set(pattern, async (payload): Promise<unknown> => {
            // The responder's reply is whatever it put on the wire: unknown until verified.
            const reply: unknown = await Reflect.apply(method, responder, [payload]);
            return reply;
          });
        }
      }
    }
  }

  /** Subjects this transport can answer (sanity: the red-team really reaches farm-service). */
  get subjects(): string[] {
    return [...this.routes.keys()];
  }

  /**
   * One request straight to the responder for `subject`, as a caller other
   * than ai-service would send it — used by controls that must prove a row
   * really exists in its own tenant.
   */
  ask(subject: string, data: Record<string, unknown>): Promise<unknown> {
    return this.dispatch(subject, data);
  }

  /** Make every following exchange be served for `tenantId` regardless of the request (null = honest). */
  serveAs(tenantId: string | null): void {
    this.servedTenantOverride = tenantId;
  }

  private async dispatch(subject: string, data: unknown): Promise<unknown> {
    const route = this.routes.get(subject);
    if (route === undefined) throw new Error(`no responder for ${subject}`);
    const request = overTheWire(data);
    if (!isRecord(request)) throw new Error(`non-object request on ${subject}`);
    const served =
      this.servedTenantOverride === null
        ? request
        : { ...request, tenantId: this.servedTenantOverride };
    const reply = overTheWire(await route(served));
    this.exchanges.push({ subject, request, reply });
    return reply;
  }
}
