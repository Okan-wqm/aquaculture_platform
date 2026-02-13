import { ConsoleLogger, Injectable, Scope } from '@nestjs/common';

import { getCorrelationId } from './correlation-id.middleware';

/**
 * Structured logger that extends the built-in NestJS ConsoleLogger.
 * Automatically includes the correlation ID (when available) in every log line
 * so that all log entries for a single request can be traced end-to-end.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLoggerService extends ConsoleLogger {
  private prependCorrelationId(message: unknown): string {
    const correlationId = getCorrelationId();
    const prefix = correlationId ? `[cid:${correlationId}] ` : '';
    return `${prefix}${message}`;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(this.prependCorrelationId(message), ...optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(this.prependCorrelationId(message), ...optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(this.prependCorrelationId(message), ...optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(this.prependCorrelationId(message), ...optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(this.prependCorrelationId(message), ...optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(this.prependCorrelationId(message), ...optionalParams);
  }
}
