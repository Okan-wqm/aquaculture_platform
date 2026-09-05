/**
 * The deploy artefact states the same production posture the service asserts.
 *
 * `apps/admin-api-service/src/config/production-posture.ts` is the single
 * declaration: three feature flags that must be an explicit 'false' in
 * production and the variables a public, nginx-fronted service cannot run
 * without. admin-api refuses to boot in production otherwise. This spec is
 * the other half: docker-compose.droplet.yml must carry each decision as a
 * literal — not an interpolation with a default, which is an omission
 * wearing a value — and main.ts must run the assertion before the app is
 * created. A compose refactor that drops a pin fails here, on the PR, not
 * on the droplet at the first boot after deploy.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#INFRA-HIGH-142
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as yaml from 'js-yaml';

import { ADMIN_API_PRODUCTION_POSTURE } from '../../apps/admin-api-service/src/config/production-posture';

const REPO_ROOT = resolve(__dirname, '..', '..');
const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.droplet.yml');
const MAIN_PATH = join(REPO_ROOT, 'apps/admin-api-service/src/main.ts');

interface ComposeService {
  environment?: Record<string, unknown> | string[];
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

function adminApiEnvironment(): Record<string, string> {
  const doc = yaml.load(readFileSync(COMPOSE_PATH, 'utf8')) as ComposeDocument;
  const service = doc.services?.['admin-api-service'];
  if (!service) throw new Error('docker-compose.droplet.yml has no admin-api-service');
  const environment = service.environment;
  if (!environment || Array.isArray(environment)) {
    throw new Error('admin-api-service.environment must be a mapping');
  }
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, String(value)]),
  );
}

describe('admin-api production posture is stated in the droplet compose (INFRA-HIGH-142)', () => {
  const env = adminApiEnvironment();

  it('runs as production', () => {
    expect(env['NODE_ENV']).toBe('production');
  });

  it.each(ADMIN_API_PRODUCTION_POSTURE.pinnedFalse)(
    '%s is the literal false, not an interpolation',
    (name) => {
      expect(env[name]).toBe('false');
    },
  );

  it.each(ADMIN_API_PRODUCTION_POSTURE.required)(
    '%s is set and is not a defaulted interpolation',
    (name) => {
      const value = env[name];
      expect(value).toBeDefined();
      expect(value?.trim()).not.toBe('');
      expect(value).not.toMatch(/\$\{[^}]*:-/);
    },
  );

  it('main.ts asserts the posture before the application is created', () => {
    const main = readFileSync(MAIN_PATH, 'utf8');
    const assertion = main.indexOf('assertProductionPosture();');
    const bootstrap = main.indexOf('bootstrapService(AppModule');
    expect(assertion).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(-1);
    expect(assertion).toBeLessThan(bootstrap);
  });
});
