/**
 * The admin-api OpenAPI document's identity, named once (CONTRACT-CRITICAL-003).
 *
 * `main.ts` hands this to the bootstrap factory, which serves the document at
 * `/docs`; `generate-openapi.ts` hands the same object to the same builder to
 * write `openapi.json`. Two literals here would be two contracts.
 */
import type { OpenApiDocumentOptions } from '@aquaculture/backend-common/bootstrap';

export const ADMIN_OPENAPI_OPTIONS: OpenApiDocumentOptions & { path: string } = {
  title: 'Aquaculture Admin API',
  description: 'Platform administration API for the Aquaculture SaaS platform',
  version: '1.0.0',
  path: 'docs',
};

/** Where the committed artifact lives, relative to the repository root. */
export const ADMIN_OPENAPI_ARTIFACT = 'apps/admin-api-service/openapi.json';
