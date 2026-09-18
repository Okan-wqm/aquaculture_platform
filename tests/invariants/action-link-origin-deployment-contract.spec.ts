/**
 * DEPLOY-HIGH-016 — the origin of every e-mailed action link is deployed
 * to the service that mints it.
 *
 * auth-service builds the invitation-acceptance and password-reset URLs that
 * notification-service puts in e-mail. It reads that origin from
 * `FRONTEND_URL`. Before this gate existed, the droplet compose provisioned
 * `FRONTEND_URL` to admin-api-service — which never reads it — and not to
 * auth-service, which fell back to a development default. Every production
 * invitation and reset e-mail carried a `http://localhost:8080` link, and
 * nothing failed: both halves of the mistake were individually plausible.
 *
 * # What is asserted
 *
 * The consumer set is DERIVED, never listed here: a service "consumes" a key
 * when its own non-test source reads it. For every deployed compose file, the
 * set of services provisioning the key must equal the set of consuming
 * services that file defines — both directions:
 *
 *   - a consumer without the key is the bug above (a silent wrong default);
 *   - a non-consumer WITH the key is how that bug hid, because the key looked
 *     provisioned to anyone who grepped the compose file.
 *
 * Local-development compose files are out of scope: there the code's
 * development default is the correct value, and `parseFrontendUrl` refuses it
 * outside development anyway.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const APPS_DIR = join(REPO_ROOT, 'apps');

/** Compose files that run services with NODE_ENV production or staging. */
const DEPLOYED_COMPOSE_FILES = [
  'docker-compose.prod.yml',
  'docker-compose.droplet.yml',
  'docker-compose.staging.yml',
] as const;

/**
 * Environment keys whose value is an externally reachable origin: wrong in
 * production is invisible locally, so provisioning cannot be left to habit.
 */
const ORIGIN_KEYS = ['FRONTEND_URL'] as const;

interface ComposeService {
  environment?: Record<string, unknown> | string[];
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

function isSourceFile(name: string): boolean {
  if (name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')) return false;
  return name.endsWith('.ts') || name.endsWith('.tsx');
}

function walkSource(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walkSource(full, out);
      continue;
    }
    if (isSourceFile(entry)) out.push(full);
  }
}

/** Services whose own non-test source reads `key`, by directory name. */
function consumersOf(key: string): Set<string> {
  const consumers = new Set<string>();
  for (const app of readdirSync(APPS_DIR)) {
    const srcDir = join(APPS_DIR, app, 'src');
    let files: string[] = [];
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    walkSource(srcDir, files);
    for (const file of files) {
      if (readFileSync(file, 'utf8').includes(key)) {
        consumers.add(app);
        break;
      }
    }
  }
  return consumers;
}

function environmentKeys(service: ComposeService | undefined): Set<string> {
  const environment = service?.environment;
  if (environment === undefined) return new Set<string>();
  if (Array.isArray(environment)) {
    return new Set(
      environment.map((entry) => {
        const [name] = entry.split('=', 1);
        return name ?? '';
      }),
    );
  }
  return new Set(Object.keys(environment));
}

function readCompose(fileName: string): ComposeDocument {
  return yaml.load(readFileSync(join(REPO_ROOT, fileName), 'utf8')) as ComposeDocument;
}

describe('action-link origin deployment contract (DEPLOY-HIGH-016)', () => {
  for (const key of ORIGIN_KEYS) {
    it(`provisions ${key} to exactly the services that read it`, () => {
      const consumers = consumersOf(key);
      expect(consumers.size).toBeGreaterThan(0);

      const problems: string[] = [];
      for (const fileName of DEPLOYED_COMPOSE_FILES) {
        const services = readCompose(fileName).services ?? {};
        for (const [name, service] of Object.entries(services)) {
          const provisioned = environmentKeys(service).has(key);
          const consumes = consumers.has(name);
          if (consumes && !provisioned) {
            problems.push(
              `${fileName}: service "${name}" reads ${key} in its source but the file ` +
                `does not provision it — it would fall back to its development default.`,
            );
          }
          if (!consumes && provisioned) {
            problems.push(
              `${fileName}: service "${name}" is given ${key} but no source file under ` +
                `apps/${name}/src reads it — a dead entry that makes the key look provisioned.`,
            );
          }
        }
      }

      if (problems.length > 0) {
        throw new Error(
          `${key} provisioning does not match its consumers:\n  ${problems.join('\n  ')}`,
        );
      }
    });
  }
});
