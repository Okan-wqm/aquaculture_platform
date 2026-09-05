/**
 * INVARIANT — the committed admin OpenAPI artifact is what the code produces
 * (CONTRACT-CRITICAL-003, ADR-0015).
 *
 * `apps/admin-api-service/openapi.json` is the FE↔BE contract: the admin-panel
 * client is generated from it. An artifact that lags the controllers is worse
 * than no artifact, because every consumer then trusts a document the server
 * no longer honours. This gate regenerates the document from the module graph
 * and asserts the committed bytes are identical, so a route or DTO change that
 * is not regenerated fails the PR that made it.
 *
 * It also refuses a vacuous artifact. The schemas are produced by the
 * `@nestjs/swagger` plugin transformer reading TypeScript types and
 * class-validator decorators; if that transformer ever stops being applied,
 * every schema becomes `{}` — and a regenerate-and-compare on its own would
 * happily agree with an empty committed document. "No schema is empty" is the
 * assertion that keeps the contract meaning something.
 *
 * Regenerate with: `nx run admin-api-service:openapi`
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { allAdminRoutes } from './lib/admin-route-table';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACT = 'apps/admin-api-service/openapi.json';
const GENERATOR = 'tools/openapi/generate-admin-openapi.cjs';

interface OpenApiSchema {
  readonly properties?: Record<string, unknown>;
  readonly enum?: unknown[];
  readonly allOf?: unknown[];
  readonly type?: string;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components?: { readonly schemas?: Record<string, OpenApiSchema> };
}

function readArtifact(): string {
  return readFileSync(resolve(REPO_ROOT, ARTIFACT), 'utf8');
}

function regenerate(): string {
  const directory = mkdtempSync(join(tmpdir(), 'admin-openapi-'));
  const target = join(directory, 'openapi.json');
  try {
    execFileSync('node', [GENERATOR], {
      cwd: REPO_ROOT,
      env: { ...process.env, ADMIN_OPENAPI_OUT: target },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return readFileSync(target, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('INVARIANT (CONTRACT-CRITICAL-003): the committed OpenAPI artifact matches the code', () => {
  const committed = readArtifact();
  const document = JSON.parse(committed) as OpenApiDocument;

  it('is a document, not a stub', () => {
    expect(document.openapi.startsWith('3.')).toBe(true);
    expect(document.info.title).toBe('Aquaculture Admin API');
    expect(Object.keys(document.paths).length).toBeGreaterThan(300);
    expect(committed.endsWith('\n')).toBe(true);
  });

  it('describes every schema it names — an empty schema is a vacuous contract', () => {
    const schemas = document.components?.schemas ?? {};
    expect(Object.keys(schemas).length).toBeGreaterThan(100);
    const empty = Object.entries(schemas)
      .filter(
        ([, schema]) =>
          Object.keys(schema.properties ?? {}).length === 0 &&
          (schema.enum ?? []).length === 0 &&
          (schema.allOf ?? []).length === 0,
      )
      .map(([name]) => name)
      .sort();
    expect(empty).toEqual([]);
  });

  it('carries the routes the controllers declare', () => {
    // The document's paths use `{param}`; the route table uses `:param`.
    const documented = new Set(
      Object.keys(document.paths).map((path) => path.replace(/\{[^}]+\}/g, ':param')),
    );
    const missing = [
      ...new Set(
        allAdminRoutes()
          .map((route) => `/${route.fullPath}`.replace(/:[A-Za-z0-9_]+/g, ':param'))
          .filter((path) => !documented.has(path)),
      ),
    ].sort();
    expect(missing).toEqual([]);
  });

  it('is byte-identical to a fresh generation', () => {
    const regenerated = regenerate();
    if (regenerated !== committed) {
      throw new Error(
        `${ARTIFACT} is stale: it differs from a fresh generation ` +
          `(committed ${committed.length} bytes, generated ${regenerated.length} bytes). ` +
          `Run \`nx run admin-api-service:openapi\` and commit the result.`,
      );
    }
    expect(regenerated).toBe(committed);
  });
});
