import type { ArgumentsHost } from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';

/**
 * The transport-neutral request envelope used by Nest GraphQL adapters.
 * Apollo integrations have historically exposed the HTTP request as either
 * `req` or `request`; keeping that variation here prevents every guard,
 * interceptor, filter, and parameter decorator from inventing its own cast.
 */
interface GraphQLRequestEnvelope<TRequest> {
  req?: TRequest;
  request?: TRequest;
}

/**
 * Resolve the typed HTTP request behind either a REST or GraphQL Nest context.
 *
 * This is the single boundary where Nest's untyped GraphQL context is given a
 * concrete shape. Consumers still have to model their own narrow request
 * contract and handle an absent request; no broad Express or `any` surface is
 * leaked into application code.
 */
export function getRequestFromArgumentsHost<TRequest>(host: ArgumentsHost): TRequest | undefined {
  if (host.getType<string>() === 'graphql') {
    const envelope = GqlArgumentsHost.create(host).getContext<GraphQLRequestEnvelope<TRequest>>();
    return envelope.req ?? envelope.request;
  }

  return host.switchToHttp().getRequest<TRequest | undefined>();
}
