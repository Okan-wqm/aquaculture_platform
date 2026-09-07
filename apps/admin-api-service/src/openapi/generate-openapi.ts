/**
 * Build the committed admin OpenAPI document (CONTRACT-CRITICAL-003, ADR-0015).
 *
 * The document is generated from the Nest module graph — the same controllers,
 * the same DTO classes, the same `DocumentBuilder` config the running service
 * serves — so the frontend's generated client cannot describe a request the
 * backend does not accept.
 *
 * The app is created in PREVIEW mode: Nest builds the full module graph and
 * registers every controller, but instantiates no provider and runs no
 * lifecycle hook. Nothing connects to Postgres, Redis or NATS, so the artifact
 * regenerates identically on a laptop, in CI and in a container with no
 * infrastructure at all.
 *
 * This module produces the DOCUMENT, not the file. Serialising and writing an
 * artifact is a build-tool concern and lives with every other artifact writer
 * under `tools/` — service source stays free of the pretty-printer the
 * structured-logging lint rule bans inside `apps/`.
 *
 * Run: `nx run admin-api-service:openapi`
 */
import 'reflect-metadata';

import { buildOpenApiConfig } from '@aquaculture/backend-common/bootstrap';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { AppModule } from '../app.module';

import { ADMIN_OPENAPI_OPTIONS } from './admin-openapi.options';

export async function generateAdminOpenApiDocument(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  try {
    return SwaggerModule.createDocument(app, buildOpenApiConfig(ADMIN_OPENAPI_OPTIONS));
  } finally {
    await app.close();
  }
}
