import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  catch(exception: unknown, host: ArgumentsHost): void {
    // This service is event-driven; the only HTTP surface is /health.
    // Guard against calling switchToHttp() in non-HTTP contexts (e.g., any
    // future NATS microservice handlers) to prevent a secondary exception.
    if (host.getType() !== 'http') {
      this.logger.error(
        'Unhandled exception in non-HTTP context',
        exception instanceof Error ? exception.stack : String(exception),
      );
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const { statusCode, message } = this.parseException(exception);

    const errorResponse = {
      statusCode,
      message: this.isProduction ? this.sanitize(message) : message,
      timestamp: new Date().toISOString(),
      // SECURITY: Strip query parameters in production to avoid reflecting
      // sensitive data (tokens, IDs) that may be passed inadvertently in URLs.
      path: this.isProduction ? request.url.split('?')[0] : request.url,
    };

    if (statusCode >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(statusCode).json(errorResponse);
  }

  private parseException(exception: unknown): { statusCode: number; message: string } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      return {
        statusCode: exception.getStatus(),
        message: typeof response === 'string'
          ? response
          : this.extractMessage(response) || exception.message,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : 'Unknown error',
    };
  }

  private extractMessage(response: unknown): string | undefined {
    if (response && typeof response === 'object' && 'message' in response) {
      const msg = (response as { message: unknown }).message;
      return typeof msg === 'string' ? msg : undefined;
    }
    return undefined;
  }

  private sanitize(message: string): string {
    return /password|secret|token|sql/i.test(message) ? 'An error occurred' : message;
  }
}
