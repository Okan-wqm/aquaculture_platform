/**
 * Write the committed admin OpenAPI artifact (CONTRACT-CRITICAL-003, ADR-0015).
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
 * Run: `nx run admin-api-service:openapi`
 */
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildOpenApiConfig } from '@aquaculture/backend-common/bootstrap';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';

import { AppModule } from '../app.module';

import { ADMIN_OPENAPI_ARTIFACT, ADMIN_OPENAPI_OPTIONS } from './admin-openapi.options';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export async function generateAdminOpenApiDocument(): Promise<string> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  try {
    const document = SwaggerModule.createDocument(app, buildOpenApiConfig(ADMIN_OPENAPI_OPTIONS));
    // Two spaces and a trailing newline: the artifact is reviewed as a diff,
    // and byte-equality is what the parity gate asserts.
    return `${JSON.stringify(document, null, 2)}\n`;
  } finally {
    await app.close();
  }
}

/**
 * Write the artifact. Called by `tools/openapi/generate-admin-openapi.cjs`.
 *
 * `ADMIN_OPENAPI_OUT` redirects the output so the parity gate can regenerate
 * into a scratch path and compare bytes without touching the committed one.
 */
export async function writeAdminOpenApiArtifact(): Promise<void> {
  const serialized = await generateAdminOpenApiDocument();
  const override = process.env['ADMIN_OPENAPI_OUT'];
  const target = override ?? resolve(REPO_ROOT, ADMIN_OPENAPI_ARTIFACT);
  writeFileSync(target, serialized, 'utf8');
  process.stdout.write(`openapi: wrote ${target} (${serialized.length} bytes)\n`);
}
