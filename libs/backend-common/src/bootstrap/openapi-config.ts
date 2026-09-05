/**
 * One OpenAPI document configuration, shared by the running service and by
 * the committed artifact (CONTRACT-CRITICAL-003, ADR-0015).
 *
 * The document a service serves at `/docs` and the `openapi.json` a
 * frontend generates its client from must be the same document. Building
 * the `DocumentBuilder` in two places is how they drift: a security scheme
 * or a server entry added to one and not the other silently changes the
 * generated client. This module is the single construction.
 */
import { DocumentBuilder } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

export interface OpenApiDocumentOptions {
  readonly title: string;
  readonly description: string;
  readonly version: string;
}

/** The document config minus `paths`, which `SwaggerModule.createDocument` fills from the routes. */
export function buildOpenApiConfig(options: OpenApiDocumentOptions): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle(options.title)
    .setDescription(options.description)
    .setVersion(options.version)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
    .build();
}
