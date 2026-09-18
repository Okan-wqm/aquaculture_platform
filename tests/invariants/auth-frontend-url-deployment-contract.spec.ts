import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

/**
 * INVARIANT: FRONTEND_URL reaches auth-service in every deployed compose file
 * and nowhere else.
 *
 * DEPLOY-HIGH-016: the origin of every e-mailed invitation / password-reset
 * link was read by auth-service with a silent localhost default, while the
 * variable was set on admin-api-service (where nothing reads it). A key that
 * is wired to the wrong service block passes every compose review and every
 * boot. This spec binds the variable to its one reader:
 *
 *  - production and droplet compose: `${FRONTEND_URL:?…}` on auth-service
 *    (fail-closed at `docker compose config`, matching PASSWORD_PEPPER);
 *  - staging overlay: an https staging origin default on auth-service;
 *  - no other service block in any compose file carries the key;
 *  - the service catalog lists it under auth-service, so the generated deploy
 *    env manifest declares it;
 *  - the only reader in apps/ is the fail-closed parser.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALL_COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'docker-compose.prod.yml',
  'docker-compose.droplet.yml',
  'docker-compose.staging.yml',
  'docker-compose.watch.yml',
] as const;
const FAIL_CLOSED_COMPOSE_FILES = [
  'docker-compose.prod.yml',
  'docker-compose.droplet.yml',
] as const;
const STAGING_COMPOSE_FILE = 'docker-compose.staging.yml';
const PARSER = 'apps/auth-service/src/config/frontend-url.ts';

interface ComposeService {
  environment?: Record<string, unknown> | string[];
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

interface RequiredSecretsManifest {
  runtime_required_env: Array<{ name: string }>;
}

function readCompose(fileName: string): ComposeDocument {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, fileName), 'utf8')) as ComposeDocument;
}

function environmentMap(service: ComposeService | undefined): Map<string, unknown> {
  const environment = service?.environment;
  if (Array.isArray(environment)) {
    return new Map(
      environment.map((entry) => {
        const separator = entry.indexOf('=');
        return separator < 0
          ? [entry, undefined]
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
  }
  return new Map(Object.entries(environment ?? {}));
}

function listTypeScriptFiles(directory: string): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  const files: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const childPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(childPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(childPath);
    }
  }
  return files;
}

describe('INVARIANT: FRONTEND_URL deployment contract (DEPLOY-HIGH-016)', () => {
  it.each(FAIL_CLOSED_COMPOSE_FILES)('%s requires FRONTEND_URL on auth-service', (fileName) => {
    const environment = environmentMap(readCompose(fileName).services?.['auth-service']);
    expect(String(environment.get('FRONTEND_URL'))).toMatch(/^\$\{FRONTEND_URL:\?/);
  });

  it('the staging overlay defaults auth-service to the https staging origin', () => {
    const environment = environmentMap(
      readCompose(STAGING_COMPOSE_FILE).services?.['auth-service'],
    );
    expect(String(environment.get('FRONTEND_URL'))).toBe(
      '${FRONTEND_URL:-https://staging.suderra.com}',
    );
  });

  it.each(ALL_COMPOSE_FILES)(
    '%s wires FRONTEND_URL to no service other than auth-service',
    (fileName) => {
      const services = readCompose(fileName).services ?? {};
      const carriers = Object.entries(services)
        .filter(([, service]) => environmentMap(service).has('FRONTEND_URL'))
        .map(([name]) => name);
      expect(carriers.filter((name) => name !== 'auth-service')).toEqual([]);
    },
  );

  it('the service catalog and the generated deploy env manifest declare it for auth-service', () => {
    const catalog = fs.readFileSync(
      path.join(REPO_ROOT, 'platform/libs/service-catalog/src/index.ts'),
      'utf8',
    );
    const authEntryStart = catalog.indexOf("serviceId: 'auth-service'");
    const nextEntryStart = catalog.indexOf('buildEntry({', authEntryStart);
    expect(authEntryStart).toBeGreaterThan(-1);
    expect(catalog.slice(authEntryStart, nextEntryStart)).toContain("'FRONTEND_URL'");

    const manifest = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, 'infrastructure/deploy/required-secrets.yaml'), 'utf8'),
    ) as RequiredSecretsManifest;
    expect(manifest.runtime_required_env.map((entry) => entry.name)).toContain('FRONTEND_URL');
  });

  it('the fail-closed parser is the only reader in apps/', () => {
    // A read is a quoted config key or a raw process.env access; prose in a
    // comment that names the variable is not a reader.
    const readers = listTypeScriptFiles('apps').filter((file) =>
      /['"]FRONTEND_URL['"]|process\.env\.FRONTEND_URL/.test(
        fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
      ),
    );
    expect(readers).toEqual([PARSER]);

    const parser = fs.readFileSync(path.join(REPO_ROOT, PARSER), 'utf8');
    expect(parser).toContain('export function parseFrontendUrl(');
    expect(parser).toContain('FRONTEND_URL is required in');
    expect(parser).not.toContain('process.env');
  });
});
