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
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const { statusCode, message } = this.parseException(exception);

    const errorResponse = {
      statusCode,
      message: this.isProduction ? this.sanitize(message) : message,
      timestamp: new Date().toISOString(),
      path: request.url,
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
        message: typeof response === 'string' ? response : (response as any).message || exception.message,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : 'Unknown error',
    };
  }

  private sanitize(message: string): string {
    return /password|secret|token|sql/i.test(message) ? 'An error occurred' : message;
  }
}
