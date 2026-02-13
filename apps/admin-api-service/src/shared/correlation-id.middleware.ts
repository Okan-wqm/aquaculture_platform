import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/** Store for the correlation ID scoped to the current async context */
export const correlationStorage = new AsyncLocalStorage<string>();

/** Retrieve the correlation ID for the current request, if available */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export const CORRELATION_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incomingId = req.headers[CORRELATION_HEADER] as string | undefined;
    const correlationId = incomingId?.trim() || randomUUID();

    // Set on response so callers can trace back
    res.setHeader('X-Correlation-Id', correlationId);

    // Run the rest of the request inside the async local storage context
    correlationStorage.run(correlationId, () => {
      next();
    });
  }
}
