import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  catch(exception: unknown, host: ArgumentsHost): void | GraphQLError {
    const contextType = host.getType<GqlContextType>();

    if (contextType === 'graphql') {
      return this.handleGraphQLException(exception, host);
    }

    this.handleHttpException(exception, host);
  }

  private handleHttpException(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const { statusCode, message } = this.parseException(exception);

    response.status(statusCode).json({
      statusCode,
      message: this.isProduction ? this.sanitize(message) : message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });

    if (statusCode >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }
  }

  private handleGraphQLException(exception: unknown, host: ArgumentsHost): GraphQLError {
    const { statusCode, message } = this.parseException(exception);

    if (statusCode >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }

    return new GraphQLError(this.isProduction ? this.sanitize(message) : message, {
      extensions: { code: this.getCode(statusCode), statusCode },
    });
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
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: exception instanceof Error ? exception.message : 'Unknown error' };
  }

  private extractMessage(response: unknown): string | undefined {
    if (response && typeof response === 'object' && 'message' in response) {
      const msg = (response as { message: unknown }).message;
      return typeof msg === 'string' ? msg : undefined;
    }
    return undefined;
  }

  private getCode(statusCode: number): string {
    const codes: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND' };
    return codes[statusCode] || 'INTERNAL_SERVER_ERROR';
  }

  private sanitize(message: string): string {
    return /password|secret|token|sql/i.test(message) ? 'An error occurred' : message;
  }
}
