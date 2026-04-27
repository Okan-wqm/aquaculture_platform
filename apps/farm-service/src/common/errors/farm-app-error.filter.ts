/**
 * FarmAppErrorFilter
 *
 * GraphQL-only filter that lifts a FarmAppError's structured
 * metadata into the error's `extensions` block. Non-FarmAppError
 * exceptions fall through to the catch-all filter provided by
 * @aquaculture/backend-common so the existing generic error path is
 * preserved.
 *
 * Phase 6.4 of the "Farm modülü kalan kör noktalar" plan.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

import { FarmAppError } from './farm-app-error';

interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
}

@Catch(FarmAppError)
export class FarmAppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(FarmAppErrorFilter.name);

  catch(exception: FarmAppError, host: ArgumentsHost): GraphQLError {
    // The filter is GraphQL-scoped (the FarmAppError subclasses are
    // all thrown inside resolvers), but NestJS can invoke filters
    // for HTTP too. For HTTP we hand back the exception so the
    // default HTTP behaviour still fires — NestJS will then call
    // any downstream HTTP filter. For GraphQL we emit a structured
    // GraphQLError.
    const contextType = host.getType<GqlContextType>();
    if (contextType !== 'graphql') {
      throw exception;
    }

    const gqlHost = GqlArgumentsHost.create(host);
    const ctx = gqlHost.getContext<{ req?: RequestWithHeaders }>();
    const correlationHeader =
      ctx?.req?.headers?.['x-correlation-id'];
    const correlationId =
      typeof correlationHeader === 'string' ? correlationHeader : undefined;

    this.logger.warn(
      `FarmAppError ${exception.code}${correlationId ? ` [corr=${correlationId}]` : ''}: ${exception.message}`,
    );

    return new GraphQLError(exception.userMessage, {
      extensions: {
        code: exception.code,
        userMessage: exception.userMessage,
        fieldPath: exception.fieldPath,
        retryable: exception.retryable,
        statusCode: exception.getStatus(),
        correlationId,
        context: exception.context,
      },
    });
  }
}
