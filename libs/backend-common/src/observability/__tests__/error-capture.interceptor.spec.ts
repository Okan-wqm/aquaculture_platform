/**
 * The fleet's defects become one stream, and nothing else changes
 * (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `admin.error_groups` had a page, a dashboard, four endpoints and a
 * 1,000-line service reading it, and no producer at all. These cases pin the
 * three properties that decide whether the producer is safe to switch on:
 * it never alters what a client sees, it never captures a fact that is already
 * recorded somewhere else, and its volume is bounded by construction rather
 * than by the fleet's 5xx rate.
 */
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { ServiceErrorCapturedEvent } from '@platform/event-contracts';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ErrorCaptureInterceptor } from '../error-capture.interceptor';

interface Published {
  events: ServiceErrorCapturedEvent[];
  publish: jest.Mock;
}

function publisher(): Published {
  const events: ServiceErrorCapturedEvent[] = [];
  const publish = jest.fn((event: ServiceErrorCapturedEvent) => {
    events.push(event);
    return Promise.resolve();
  });
  return { events, publish };
}

/** ExecutionContextHost wants a constructor ref; only its identity is read. */
class TestController {
  readonly name = 'TestController';
}

function handler(): void {
  // named so the rpc case has a pattern to report
}

/**
 * A REAL ExecutionContext, not a shaped object: `ExecutionContextHost` is what
 * Nest itself constructs, so the interceptor is exercised against the same
 * `getType` / `switchToHttp` / `getHandler` behaviour it meets in production.
 */
function httpContext(
  request: Record<string, unknown> = { method: 'POST', originalUrl: '/api/tenants/abc' },
): ExecutionContext {
  const context = new ExecutionContextHost([request, {}], TestController, handler);
  context.setType('http');
  return context;
}

function throwing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

async function run(
  interceptor: ErrorCaptureInterceptor,
  context: ExecutionContext,
  error: unknown,
): Promise<unknown> {
  return firstValueFrom(interceptor.intercept(context, throwing(error)));
}

describe('ErrorCaptureInterceptor', () => {
  it('re-throws the original exception untouched — capture never changes the response', async () => {
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });
    const original = new InternalServerErrorException('database is unreachable');

    await expect(run(interceptor, httpContext(), original)).rejects.toBe(original);
  });

  it('passes a successful response through without touching it', async () => {
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });

    const succeeding: CallHandler = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(interceptor.intercept(httpContext(), succeeding));

    expect(result).toEqual({ ok: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it('captures a 500 with its stack, service and normalized route', async () => {
    const { events, publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor(
      'farm-service',
      { publish },
      {
        environment: 'staging',
        release: 'v1.2.3',
      },
    );

    await expect(
      run(
        interceptor,
        httpContext({
          method: 'GET',
          originalUrl: '/api/tenants/550e8400-e29b-41d4-a716-446655440000/farms?page=2',
        }),
        new InternalServerErrorException('boom'),
      ),
    ).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    const event = events[0] as ServiceErrorCapturedEvent;
    expect(event.eventType).toBe('ServiceErrorCaptured');
    expect(event.service).toBe('farm-service');
    expect(event.statusCode).toBe(500);
    expect(event.httpMethod).toBe('GET');
    // The query string is dropped and the uuid collapsed, so the group joins to
    // the same label Prometheus uses instead of inventing a second convention.
    expect(event.httpRoute).toBe('/api/tenants/:id/farms');
    expect(event.environment).toBe('staging');
    expect(event.release).toBe('v1.2.3');
    expect(event.stackTrace).toBeDefined();
  });

  it('treats a non-HttpException as critical with statusCode 0', async () => {
    const { events, publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });

    await expect(
      run(interceptor, httpContext(), new TypeError('x is not a function')),
    ).rejects.toBeDefined();

    const event = events[0] as ServiceErrorCapturedEvent;
    expect(event.severity).toBe('critical');
    expect(event.statusCode).toBe(0);
    expect(event.errorType).toBe('TypeError');
  });

  it.each([
    ['a validation rejection', new BadRequestException('name must be a string')],
    ['an auth rejection', new UnauthorizedException()],
    ['a rate-limit rejection', new HttpException('Too many', HttpStatus.TOO_MANY_REQUESTS)],
  ])('does not capture %s — the client is not this service defecting', async (_label, error) => {
    // 4xx is the client's input. 401/403 is already an AUTH_TOKEN_REJECTED
    // security event; 429 is already projected into admin.api_usage_logs, and
    // capturing it here would put one fact in two admin tables.
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });

    await expect(run(interceptor, httpContext(), error)).rejects.toBe(error);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not capture a 503 — that is dependency state the RED rules already alert on', async () => {
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });
    const error = new ServiceUnavailableException('circuit open');

    await expect(run(interceptor, httpContext(), error)).rejects.toBe(error);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not capture a client abort', async () => {
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });

    await expect(run(interceptor, httpContext(), aborted)).rejects.toBe(aborted);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['/health/live', '/metrics'])('does not capture failures on %s', async (path) => {
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });

    await expect(
      run(
        interceptor,
        httpContext({ method: 'GET', originalUrl: path }),
        new Error('probe failed'),
      ),
    ).rejects.toBeDefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it('masks PII out of the message and the stack', async () => {
    const { events, publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('auth-service', { publish });

    await expect(
      run(interceptor, httpContext(), new Error('no user for alice@example.com')),
    ).rejects.toBeDefined();

    const event = events[0] as ServiceErrorCapturedEvent;
    expect(event.message).not.toContain('alice@example.com');
    expect(event.message).toContain('[EMAIL-REDACTED]');
    expect(event.stackTrace).not.toContain('alice@example.com');
  });

  it('bounds its own volume — a storm cannot become the ingest', async () => {
    // Without this the ingest volume equals the fleet's 5xx rate during exactly
    // the incident that produces the most of them.
    const clock = 0;
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor(
      'farm-service',
      { publish },
      { ratePerSecond: 5, burst: 3, now: () => clock },
    );

    for (let i = 0; i < 50; i += 1) {
      await expect(run(interceptor, httpContext(), new Error(`boom ${i}`))).rejects.toBeDefined();
    }

    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('refills the bucket as time passes', async () => {
    let clock = 0;
    const { publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor(
      'farm-service',
      { publish },
      { ratePerSecond: 5, burst: 3, now: () => clock },
    );

    for (let i = 0; i < 10; i += 1) {
      await expect(run(interceptor, httpContext(), new Error('boom'))).rejects.toBeDefined();
    }
    expect(publish).toHaveBeenCalledTimes(3);

    clock = 1000;
    await expect(run(interceptor, httpContext(), new Error('boom'))).rejects.toBeDefined();
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it('is inert without a publisher rather than failing the request', async () => {
    // gateway-api registers no EventBusModule; capture must be a no-op there,
    // not a boot failure or a second exception.
    const interceptor = new ErrorCaptureInterceptor('gateway-api', undefined);
    const error = new InternalServerErrorException('boom');

    await expect(run(interceptor, httpContext(), error)).rejects.toBe(error);
  });

  it('does not let a publish failure escalate the application error', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('NATS down'));
    const interceptor = new ErrorCaptureInterceptor('farm-service', { publish });
    const error = new InternalServerErrorException('boom');

    await expect(run(interceptor, httpContext(), error)).rejects.toBe(error);
  });

  it('captures a failing message handler too, marked rpc', async () => {
    const { events, publish } = publisher();
    const interceptor = new ErrorCaptureInterceptor('billing-service', { publish });
    function handleInvoiceCreated(): void {
      // the handler name is what the rpc pattern reports
    }
    const rpcContext = new ExecutionContextHost([{}], TestController, handleInvoiceCreated);
    rpcContext.setType('rpc');

    await expect(run(interceptor, rpcContext, new Error('boom'))).rejects.toBeDefined();

    const event = events[0] as ServiceErrorCapturedEvent;
    expect(event.transport).toBe('rpc');
    expect(event.rpcPattern).toBe('handleInvoiceCreated');
    expect(event.httpRoute).toBeUndefined();
  });
});
