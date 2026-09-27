import type { Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
// The host module is where @nestjs/config keeps ConfigService and its
// configuration token; ConfigModule only imports and re-exports it. It is not
// on the package's public index, hence the deep path.
import { ConfigHostModule } from '@nestjs/config/dist/config-host.module';
import { NestFactory } from '@nestjs/core';
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
  await context.close();
}
