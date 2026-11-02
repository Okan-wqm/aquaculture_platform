import type { Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

type ParamFactory = (data: unknown, context: ExecutionContextHost) => unknown;

interface RouteArgument {
  readonly data?: unknown;
  readonly factory?: ParamFactory;
}

function routeArguments(target: object, method: string): Readonly<Record<string, RouteArgument>> {
  const metadata: unknown = Reflect.getMetadata(ROUTE_ARGS_METADATA, target, method);
  return typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, RouteArgument>)
    : {};
}

/**
 * The metadata key prefix `createParamDecorator` gave one custom parameter decorator: every use of
 * it is stored under `<prefix>:<index>`. Read off a probe method the decorator is applied to here.
 */
function keyPrefixOf(decorator: () => ParameterDecorator): string {
  class Probe {
    probe(_value: unknown): void {}
  }
  decorator()(Probe.prototype, 'probe', 0);
  const keys = Object.keys(routeArguments(Probe, 'probe'));
  const [key] = keys;
  if (keys.length !== 1 || key === undefined) {
    throw new Error('the decorator is not a custom parameter decorator');
  }
  return key.slice(0, key.lastIndexOf(':'));
}

/** Whether `cls.method` takes the custom parameter decorator. */
export function takesParamDecorator(
  decorator: () => ParameterDecorator,
  cls: Type,
  method: string,
): boolean {
  const prefix = `${keyPrefixOf(decorator)}:`;
  return Object.keys(routeArguments(cls, method)).some((key) => key.startsWith(prefix));
}

/**
 * Runs the factory of a custom parameter decorator as Nest registered it on `cls.method`, for one
 * GraphQL request whose context is `{ req: request }`: the same factory, metadata and handler a
 * real request reaches, without booting a module. A guard runs before it in a real request; this
 * runs only the parameter. Throws what the factory throws (for `@AccessCaller()`, the
 * ForbiddenException of a deny).
 */
export function runGraphqlParamDecorator(
  decorator: () => ParameterDecorator,
  cls: Type,
  method: string,
  request: unknown,
): unknown {
  const prefix = `${keyPrefixOf(decorator)}:`;
  const entry = Object.entries(routeArguments(cls, method)).find(([key]) => key.startsWith(prefix));
  const factory = entry?.[1].factory;
  if (factory === undefined) throw new Error(`${cls.name}.${method} does not take the decorator`);
  const handler: unknown = Reflect.get(cls.prototype as object, method);
  if (typeof handler !== 'function') throw new Error(`${cls.name}.${method} does not exist`);
  const context = new ExecutionContextHost(
    [{}, {}, { req: request }, {}],
    cls,
    handler as (...args: unknown[]) => unknown,
  );
  context.setType('graphql');
  return factory(entry?.[1].data, context);
}
