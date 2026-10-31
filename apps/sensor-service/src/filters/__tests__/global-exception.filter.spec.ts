import { stub } from '@aquaculture/testing';
import {
  type ArgumentsHost,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { GraphQLError } from 'graphql';

import { GlobalExceptionFilter } from '../global-exception.filter';

/**
 * The GraphQL error a client sees: a domain refusal thrown with a
 * `{ message, code }` body keeps its own stable code (SENSOR_PLACEMENT_ERROR,
 * so the device page can say in the user's language what farm refused);
 * every other error keeps the code derived from its HTTP status.
 */
function graphqlHost(): ArgumentsHost {
  const args = [{}, {}, { req: { headers: {} } }, {}];
  return stub<ArgumentsHost>({
    getType: <T extends string>() => 'graphql' as T,
    getArgs: <T extends unknown[]>() => args as T,
    getArgByIndex: <T>(index: number) => args[index] as T,
  });
}

describe('GlobalExceptionFilter (GraphQL)', () => {
  const filter = new GlobalExceptionFilter();
  const answer = (exception: unknown): GraphQLError | undefined =>
    filter.catch(exception, graphqlHost());

  it('passes a domain refusal’s own code through, with its status', () => {
    const error = answer(
      new BadRequestException({
        message: 'The site is not active',
        code: 'PLACEMENT_REFUSED_SITE',
      }),
    );
    expect(error?.message).toBe('The site is not active');
    expect(error?.extensions).toEqual({ code: 'PLACEMENT_REFUSED_SITE', statusCode: 400 });

    expect(
      answer(new ServiceUnavailableException({ message: 'later', code: 'PLACEMENT_UNAVAILABLE' }))
        ?.extensions,
    ).toEqual({ code: 'PLACEMENT_UNAVAILABLE', statusCode: 503 });
  });

  it('keeps the status-derived code for every other error', () => {
    expect(answer(new NotFoundException('Sensor not found'))?.extensions).toEqual({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(answer(new BadRequestException(['name must be a string']))?.extensions).toEqual({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(answer(new Error('boom'))?.extensions).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      statusCode: 500,
    });
  });
});
