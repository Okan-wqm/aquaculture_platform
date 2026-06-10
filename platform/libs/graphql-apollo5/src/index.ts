import { ApolloGateway, type GatewayConfig } from '@apollo/gateway';
import { ApolloServer, type ApolloServerOptions } from '@apollo/server';
import { unwrapResolverError, ApolloServerErrorCode } from '@apollo/server/errors';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { HttpStatus, Injectable, type Type } from '@nestjs/common';
import { isFunction } from '@nestjs/common/utils/shared.utils';
import { ModulesContainer } from '@nestjs/core';
import {
  AbstractGraphQLDriver,
  extend,
  GraphQLFederationFactory,
  GqlSubscriptionService,
  type GqlModuleAsyncOptions,
  type GqlModuleOptions,
  type GqlOptionsFactory,
  type GraphQLDriver,
} from '@nestjs/graphql';
import { GraphQLError, type GraphQLSchema } from 'graphql';

type ApolloServerConfig = ApolloServerOptions<Record<string, unknown>>;

export interface GraphqlRuntimePolicy {
  csrfPrevention: true;
  allowBatchedHttpRequests: false;
  landingPage: 'disabled';
  productionIntrospection: 'catalog-approved-only';
}

export const GRAPHQL_RUNTIME_POLICY: GraphqlRuntimePolicy = {
  csrfPrevention: true,
  allowBatchedHttpRequests: false,
  landingPage: 'disabled',
  productionIntrospection: 'catalog-approved-only',
};

export type ApolloDriverConfig = GqlModuleOptions &
  Omit<Partial<ApolloServerConfig>, 'schema'> & {
    autoTransformHttpErrors?: boolean;
    installSubscriptionHandlers?: boolean;
    preserveHttpStatusForExecutionErrors?: boolean;
    playground?: false;
    graphiql?: false;
    subscriptions?: Record<string, unknown>;
  };

export type ApolloDriverConfigFactory = GqlOptionsFactory<ApolloDriverConfig>;
export type ApolloDriverAsyncConfig = GqlModuleAsyncOptions<ApolloDriverConfig>;
export type ApolloFederationDriverConfig = ApolloDriverConfig;
export type ApolloFederationDriverConfigFactory = ApolloDriverConfigFactory;
export type ApolloFederationDriverAsyncConfig = ApolloDriverAsyncConfig;

export interface ApolloGatewayDriverConfig<TDriver extends GraphQLDriver = GraphQLDriver> {
  driver?: Type<TDriver>;
  gateway?: GatewayConfig;
  server?: Omit<
    ApolloDriverConfig,
    | 'typeDefs'
    | 'typePaths'
    | 'include'
    | 'resolvers'
    | 'resolverValidationOptions'
    | 'directiveResolvers'
    | 'autoSchemaFile'
    | 'transformSchema'
    | 'definitions'
    | 'schema'
    | 'subscriptions'
    | 'buildSchemaOptions'
    | 'fieldResolverEnhancers'
    | 'driver'
  >;
  transformSchema?: (schema: GraphQLSchema) => GraphQLSchema | Promise<GraphQLSchema>;
}

export type ApolloGatewayDriverConfigFactory = GqlOptionsFactory<ApolloGatewayDriverConfig>;
export type ApolloGatewayDriverAsyncConfig = GqlModuleAsyncOptions<ApolloGatewayDriverConfig>;

const httpExceptionCodeByStatus: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ApolloServerErrorCode.BAD_REQUEST,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ApolloServerErrorCode.BAD_USER_INPUT,
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
};

abstract class Apollo5BaseDriver extends AbstractGraphQLDriver<any> {
  protected apolloServer?: ApolloServer;

  get instance(): ApolloServer | undefined {
    return this.apolloServer;
  }

  async stop(): Promise<void> {
    await this.apolloServer?.stop();
  }

  override async mergeDefaultOptions(options: any): Promise<any> {
    if (options.playground || options.graphiql) {
      throw new Error('graphql_playground_disabled_by_platform_policy');
    }

    const merged = await super.mergeDefaultOptions(
      {
        stopOnTerminationSignals: false,
        csrfPrevention: GRAPHQL_RUNTIME_POLICY.csrfPrevention,
        allowBatchedHttpRequests: GRAPHQL_RUNTIME_POLICY.allowBatchedHttpRequests,
        ...options,
      },
      {
        path: '/graphql',
        fieldResolverEnhancers: [],
        stopOnTerminationSignals: false,
      },
    );

    merged.plugins = [
      ...(merged.plugins ?? []),
      ApolloServerPluginLandingPageDisabled(),
      ...(merged.preserveHttpStatusForExecutionErrors === false
        ? []
        : [this.createPreserveHttpStatusPlugin()]),
    ];
    this.wrapContextResolver(merged);
    this.wrapFormatErrorFn(merged);
    return merged;
  }

  override subscriptionWithFilter(
    instanceRef: unknown,
    filterFn: (payload: unknown, variables: unknown, context: unknown) => boolean | Promise<boolean>,
    createSubscribeContext: () => (...args: unknown[]) => AsyncIterable<unknown>,
  ): any {
    return (...args: unknown[]) => {
      const iterator = createSubscribeContext()(...args);
      const asyncIterator = iterator[Symbol.asyncIterator]();
      return {
        async next() {
          for (;;) {
            const result = await asyncIterator.next();
            if (result.done) return result;
            if (await filterFn.call(instanceRef, result.value, args[1], args[2])) {
              return result;
            }
          }
        },
        async return() {
          return asyncIterator.return
            ? asyncIterator.return()
            : { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          if (asyncIterator.throw) return asyncIterator.throw(error);
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }

  protected async registerApolloServer(options: ApolloDriverConfig): Promise<void> {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const platformName = httpAdapter.getType();
    if (platformName !== 'express') {
      throw new Error(`graphql_platform_driver_unsupported:${platformName}`);
    }

    const { expressMiddleware } = require('@as-integrations/express5') as typeof import('@as-integrations/express5');
    const path = String(options.path ?? '/graphql');
    httpAdapter.use(path, (req: { body?: unknown }, _res: unknown, next: () => void) => {
      req.body ??= {};
      next();
    });

    const drainHttpServer = ApolloServerPluginDrainHttpServer({
      httpServer: httpAdapter.getHttpServer(),
    });
    const server = new ApolloServer({
      ...options,
      plugins: [...(options.plugins ?? []), drainHttpServer],
    } as ApolloServerConfig);
    await server.start();
    httpAdapter.getInstance().use(
      path,
      expressMiddleware(server, {
        context: options.context as any,
      }),
    );
    this.apolloServer = server;
  }

  private createPreserveHttpStatusPlugin() {
    return {
      async requestDidStart() {
        return {
          async willSendResponse(requestContext: {
            response?: {
              body?: { kind?: string; singleResult?: Record<string, unknown> };
              http?: { status?: number };
            };
          }) {
            const body = requestContext.response?.body;
            if (
              body?.kind === 'single' &&
              body.singleResult &&
              Object.prototype.hasOwnProperty.call(body.singleResult, 'data') &&
              requestContext.response?.http
            ) {
              requestContext.response.http.status = 200;
            }
          },
        };
      },
    };
  }

  private wrapFormatErrorFn(options: ApolloDriverConfig): void {
    if (options.autoTransformHttpErrors === false) return;
    const transformHttpError = this.createTransformHttpErrorFn();
    const originalFormatError = options.formatError;
    options.formatError = originalFormatError
      ? (formattedError, error) => originalFormatError(transformHttpError(formattedError, error), error)
      : transformHttpError;
  }

  private createTransformHttpErrorFn() {
    return (formattedError: any, originalError: unknown): any => {
      const exceptionRef = unwrapResolverError(originalError) as {
        message?: string;
        status?: number;
        response?: { statusCode?: number } & Record<string, unknown>;
      };
      if (!exceptionRef?.response?.statusCode || !exceptionRef.status) {
        return formattedError;
      }

      const httpStatus = exceptionRef.status;
      const code = httpExceptionCodeByStatus[httpStatus] ?? ApolloServerErrorCode.INTERNAL_SERVER_ERROR;
      return new GraphQLError(exceptionRef.message ?? formattedError.message, {
        path: formattedError.path,
        extensions: {
          ...formattedError.extensions,
          code,
          ...(code === ApolloServerErrorCode.INTERNAL_SERVER_ERROR ? { status: httpStatus } : {}),
          originalError: exceptionRef.response,
        },
      });
    };
  }

  private wrapContextResolver(targetOptions: ApolloDriverConfig): void {
    const originalContext = targetOptions.context;
    if (!originalContext) {
      targetOptions.context = async (contextOrRequest: { req?: unknown }) => ({
        req: contextOrRequest.req ?? contextOrRequest,
      });
      return;
    }

    if (isFunction(originalContext)) {
      targetOptions.context = async (...args: unknown[]) => {
        const ctx = await originalContext(...args);
        const contextOrRequest = args[0] as { req?: unknown };
        return this.assignReqProperty(ctx, contextOrRequest.req ?? contextOrRequest);
      };
      return;
    }

    targetOptions.context = async (contextOrRequest: { req?: unknown }) =>
      this.assignReqProperty(originalContext, contextOrRequest.req ?? contextOrRequest);
  }

  private assignReqProperty(ctx: unknown, req: unknown): unknown {
    if (!ctx) return { req };
    if (typeof ctx !== 'object' || ('req' in ctx && typeof ctx.req === 'object')) return ctx;
    return Object.assign(ctx, { req });
  }
}

@Injectable()
export class ApolloFederationDriver extends Apollo5BaseDriver {
  private _subscriptionService?: GqlSubscriptionService;

  constructor(
    private readonly graphqlFederationFactory: GraphQLFederationFactory,
    _modulesContainer: ModulesContainer,
  ) {
    super();
  }

  async start(options: ApolloFederationDriverConfig): Promise<void> {
    if (options.definitions?.path) {
      const { printSubgraphSchema } = require('@apollo/subgraph') as typeof import('@apollo/subgraph');
      await this.graphQlFactory.generateDefinitions(printSubgraphSchema(options.schema!), options);
    }
    await this.registerApolloServer(options);
    if (options.installSubscriptionHandlers || options.subscriptions) {
      this._subscriptionService = new GqlSubscriptionService(
        {
          schema: options.schema!,
          path: options.path,
          context: options.context,
          ...(options.subscriptions || { 'subscriptions-transport-ws': {} }),
        },
        this.httpAdapterHost.httpAdapter?.getHttpServer(),
      );
    }
  }

  override generateSchema(options: ApolloFederationDriverConfig): Promise<GraphQLSchema> {
    return this.graphqlFederationFactory.generateSchema(options);
  }
}

@Injectable()
export class ApolloGatewayDriver extends Apollo5BaseDriver {
  constructor(_modulesContainer: ModulesContainer) {
    super();
  }

  async start(options: ApolloGatewayDriverConfig): Promise<void> {
    const gateway = new ApolloGateway(options.gateway ?? {});
    await this.registerApolloServer({
      ...(options.server ?? {}),
      gateway: options.transformSchema
        ? this.wrapGatewayWithSchemaTransform(gateway, options.transformSchema)
        : gateway,
    } as any);
  }

  override async mergeDefaultOptions(
    options: ApolloGatewayDriverConfig,
  ): Promise<ApolloGatewayDriverConfig> {
    return {
      ...options,
    server: await super.mergeDefaultOptions((options.server ?? {}) as ApolloDriverConfig),
    };
  }

  override generateSchema(): null {
    return null;
  }

  private wrapGatewayWithSchemaTransform(
    gateway: ApolloGateway,
    transformSchema: (schema: GraphQLSchema) => GraphQLSchema | Promise<GraphQLSchema>,
  ) {
    const queuedListeners = new Set<(schemaContext: { apiSchema: GraphQLSchema }) => void>();
    let initialContext: { apiSchema: GraphQLSchema } | undefined;
    let initialEmitted = false;

    gateway.onSchemaLoadOrUpdate((schemaContext) => {
      if (!initialEmitted) {
        initialContext = schemaContext;
        return;
      }
      queuedListeners.forEach((listener) => listener(schemaContext));
    });

    return {
      load: async (loadOptions: Parameters<ApolloGateway['load']>[0]) => {
        const result = await gateway.load(loadOptions);
        if (initialContext) {
          const transformedSchema = await transformSchema(initialContext.apiSchema);
          queuedListeners.forEach((listener) =>
            listener({ ...initialContext, apiSchema: transformedSchema }),
          );
        }
        initialEmitted = true;
        return result;
      },
      onSchemaLoadOrUpdate: (callback: (schemaContext: { apiSchema: GraphQLSchema }) => void) => {
        queuedListeners.add(callback);
        return () => queuedListeners.delete(callback);
      },
      stop: () => gateway.stop(),
    };
  }
}
