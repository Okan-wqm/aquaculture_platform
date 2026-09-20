import type { INestApplicationContext, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';

/**
 * A provider that a service MAY register — `undefined` when no module did.
 *
 * `app.get()` cannot express this. NestFactory hands the application back
 * behind an ExceptionsZone proxy, and under the default `abortOnError` that
 * zone logs an `UnknownElementException` and calls `process.exit(1)` before
 * the caller's `catch` ever runs. A `try { app.get(token) } catch { … }` block
 * is therefore not a fallback but a crash — gateway-api, which registers no
 * event bus by design, restart-looped on exactly that in production
 * (INFRA-HIGH-184). `ModuleRef` performs the same container lookup without
 * the zone, so a miss is an ordinary exception this function can answer.
 */
export function resolveOptionalProvider<T>(
  app: INestApplicationContext,
  token: string | symbol | Type<T>,
): T | undefined {
  const moduleRef = app.get(ModuleRef, { strict: false });
  try {
    return moduleRef.get<T>(token, { strict: false });
  } catch (error: unknown) {
    if (error instanceof UnknownElementException) {
      return undefined;
    }
    throw error;
  }
}
