import type { Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
// The host module is where @nestjs/config keeps ConfigService and its
// configuration token; ConfigModule only imports and re-exports it. It is not
// on the package's public index, hence the deep path.
import { ConfigHostModule } from '@nestjs/config/dist/config-host.module';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { InitializeOnPreviewAllowlist } from '@nestjs/core/inspector';

/**
 * Builds a NestJS application's dependency graph the way production does —
 * every module, provider, controller and resolver, every constructor and
 * property token — without instantiating a single provider.
 *
 * WHY: "Nest can't resolve dependencies of X (…, ?)" is thrown while the
 * container is BUILT, before any provider is constructed and before any
 * onModuleInit connects to a database or a broker. Nest's `preview` mode
 * runs exactly that phase and stops short of construction, so the check
 * needs no infrastructure and finishes in well under a second. Until it
 * existed the production container was the first thing to resolve a
 * service's modules: billing-service (a type-only import of an injected
 * class) and sensor-service (a class re-provided outside the module that
 * owns its repository) sat unbootable on main for 13 and 25 days behind
 * green CI, and farm-service and gateway-api carried two more shapes
 * (2026-09-20 outage, ORPHAN-HIGH-834).
 *
 * Every app owns `src/__tests__/di-graph.spec.ts` calling this with its
 * AppModule; the affected-test lane runs it whenever the app or a library
 * it depends on changes. The thrown error is Nest's own, naming the
 * provider, the missing token and the module — it is the message
 * production would have logged.
 *
 * Module factories still run (`forRoot`, `forRootAsync`, `forFeature`
 * return their metadata), so anything a module evaluates while being
 * DECLARED — a ConfigModule validation, an env read at import — runs here
 * too; a fail-closed config that refuses to be declared without an env
 * value is a real boot failure and belongs in the test's environment setup.
 */
export async function assertNestGraphResolves(rootModule: Type<unknown>): Promise<void> {
  await inspectNestGraph(rootModule, () => undefined);
}

/**
 * Build the graph like {@link assertNestGraphResolves} and hand the resolved
 * module container to `inspect` before closing it.
 *
 * WHY: some boot defects are not missing tokens but the SHAPE of the resolved
 * graph — e.g. a request-scoped provider (a GraphQL DataLoader) silently
 * turning a cron service or a message controller request-scoped through its
 * dependency tree, which Nest does not report. Preview mode resolves every
 * constructor dependency, so each InstanceWrapper can answer
 * `isDependencyTreeStatic()` without constructing anything.
 * WHAT: `inspect(modules)` runs against the preview container; its result is
 * returned.
 */
export async function inspectNestGraph<T>(
  rootModule: Type<unknown>,
  inspect: (modules: ModulesContainer) => T,
): Promise<T> {
  // GraphQLModule puts itself on Nest's preview allowlist (it is instantiated
  // even in preview so the schema can be built), and every subgraph's
  // `GraphQLModule.forRootAsync` factory injects ConfigService. A provider
  // outside the allowlist is null in preview, so the factory would fail on
  // `null.get(...)` before the graph is fully walked. Allowlisting ConfigModule
  // makes ConfigService real (it only reads the environment) and lets the
  // factory run as it does in production.
  InitializeOnPreviewAllowlist.add(ConfigModule);
  InitializeOnPreviewAllowlist.add(ConfigHostModule);
  const context = await NestFactory.createApplicationContext(rootModule, {
    preview: true,
    abortOnError: false,
    logger: false,
  });
  try {
    return inspect(context.get(ModulesContainer));
  } finally {
    await context.close();
  }
}
