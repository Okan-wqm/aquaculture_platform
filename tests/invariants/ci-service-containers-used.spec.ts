/**
 * Platform-wide invariant: a workflow job declares a service container only when one of its
 * steps reaches it.
 *
 * # WHY
 *
 * The runner pulls and health-checks every `services:` image before the job's first step. For a
 * job that never talks to the service, that pull adds nothing, but it can still fail the job.
 * CI pulled these images anonymously from public.ecr.aws, and ECR Public limits anonymous pulls
 * per source IP: 500 GB/month and 1 pull/s, neither adjustable. GitHub-hosted runners share
 * their egress IPs, so other tenants spend the same quota.
 *
 * `ci-affected.yml` had copied a redis+nats block into 13 jobs, and only `test` used nats. On
 * 2026-10-16, 17 of 19 failed CI-Affected runs died with `toomanyrequests` in jobs that never
 * opened a connection: install, lint, build, pre-flight, docs-check, merge-gate and others.
 * That made 25 of the 26 pulls per run pure failure surface (INFRA-HIGH-225). Nothing caught
 * the copy-paste, because an unused service container is syntactically valid.
 *
 * # WHAT counts as reaching a service
 *
 * The job's `env`, plus each step's `run`, `env` and `with`, must contain at least one of:
 *
 *   1. `localhost:<port>` / `127.0.0.1:<port>` on a host port the service publishes
 *      (`ports: ['4222:4222']`): the URL form, e.g. `NATS_URL: nats://localhost:4222`;
 *   2. an env var whose name ends in `PORT` and whose value is such a port: the granular form,
 *      e.g. `REDIS_HOST: localhost` + `REDIS_PORT: 6379`;
 *   3. the service id used as a host (`redis://redis:6379`, `redis:6379`, `DB_HOST: postgres`):
 *      the form a job running in a `container:` uses;
 *   4. `job.services.<id>`: the expression that reads a randomly mapped port.
 *
 * The service id as a bare word does NOT count. `pre-flight` runs
 * `scripts/nats/generate-nats-conf.py` and never contacts a broker, so a name match would have
 * kept its unused nats service green. A reference has to be shaped like a connection.
 *
 * The registry each remaining image comes from is ci-image-registry.spec.ts's concern: the GHCR
 * mirror pinned in .github/manifests/ci-images.json (INFRA-HIGH-227). This spec only asks
 * whether the image needs to be pulled at all.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

type Mapping = Record<string, unknown>;

interface DeclaredService {
  readonly workflow: string;
  readonly job: string;
  readonly service: string;
  readonly reached: boolean;
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trackedWorkflowFiles(): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((path) => path.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Host side of each `host:container` mapping; a bare `container` port maps to a random host port. */
function publishedHostPorts(ports: unknown): string[] {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) {
    throw new Error(`services.*.ports must be a list, got ${JSON.stringify(ports)}`);
  }
  return ports.flatMap((entry) => {
    // `[ip:]host:container[/proto]`; the host port is the second-to-last field.
    const fields = (String(entry).split('/')[0] ?? '').split(':');
    const host = fields.length >= 2 ? fields[fields.length - 2] : undefined;
    return host ? [host] : [];
  });
}

interface JobReferences {
  readonly text: string;
  readonly env: ReadonlyArray<readonly [string, string]>;
}

function envPairs(env: unknown): Array<[string, string]> {
  return isMapping(env) ? Object.entries(env).map(([key, value]) => [key, String(value)]) : [];
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function jobReferences(job: Mapping): JobReferences {
  const env = envPairs(job.env);
  const text: string[] = env.map(([key, value]) => `${key}=${value}`);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const step of steps) {
    if (!isMapping(step)) continue;
    const stepEnv = envPairs(step.env);
    env.push(...stepEnv);
    text.push(...stepEnv.map(([key, value]) => `${key}=${value}`));
    text.push(scalarText(step.run), scalarText(step.with));
  }
  return { text: text.join('\n'), env };
}

function reachesService(
  service: string,
  hostPorts: readonly string[],
  refs: JobReferences,
): boolean {
  const id = escapeRegExp(service);
  if (new RegExp(`\\bjob\\.services\\.${id}\\b`).test(refs.text)) return true;
  for (const port of hostPorts) {
    if (new RegExp(`(?:localhost|127\\.0\\.0\\.1):${escapeRegExp(port)}(?!\\d)`).test(refs.text)) {
      return true;
    }
    if (refs.env.some(([key, value]) => /PORT$/i.test(key) && value.trim() === port)) return true;
  }
  // The service id as a host: the URL authority's host (userinfo stripped, so the `postgres`
  // user in `postgres://postgres:pw@localhost` is not mistaken for the host), `<id>:<port>`,
  // or a *HOST env var.
  for (const match of refs.text.matchAll(/:\/\/([^/\s'"]+)/g)) {
    const authority = match[1] ?? '';
    const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
    if (host === service) return true;
  }
  if (new RegExp(`(?<![\\w./-])${id}:\\d{2,5}(?!\\d)`).test(refs.text)) return true;
  return refs.env.some(([key, value]) => /HOST$/i.test(key) && value.trim() === service);
}

function declaredServices(workflow: string, source: string): DeclaredService[] {
  const parsed = yaml.load(source);
  if (!isMapping(parsed) || !isMapping(parsed.jobs)) return [];
  const declared: DeclaredService[] = [];
  for (const [jobId, job] of Object.entries(parsed.jobs)) {
    if (!isMapping(job) || job.services === undefined) continue;
    if (!isMapping(job.services)) {
      throw new Error(`${workflow} job ${jobId}: services must be a mapping to be reviewable`);
    }
    const refs = jobReferences(job);
    for (const [serviceId, spec] of Object.entries(job.services)) {
      const ports = publishedHostPorts(isMapping(spec) ? spec.ports : undefined);
      declared.push({
        workflow,
        job: jobId,
        service: serviceId,
        reached: reachesService(serviceId, ports, refs),
      });
    }
  }
  return declared;
}

function unreached(workflow: string, source: string): string[] {
  return declaredServices(workflow, source)
    .filter((entry) => !entry.reached)
    .map((entry) => `${entry.workflow} job ${entry.job}: service ${entry.service}`);
}

/** A one-job workflow whose job declares `services` and runs `steps`. */
function fixture(services: string, steps: string, jobExtra = ''): string {
  return [
    'on: push',
    'jobs:',
    '  probe:',
    '    runs-on: ubuntu-latest',
    jobExtra,
    '    services:',
    services,
    '    steps:',
    steps,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

const REDIS = [
  '      redis:',
  '        image: r',
  '        ports:',
  "          - '6379:6379'",
].join('\n');
const NATS = ['      nats:', '        image: n', '        ports:', "          - '4222:4222'"].join(
  '\n',
);

describe('INVARIANT: a job declares only the service containers its steps reach (INFRA-HIGH-225)', () => {
  const workflows = trackedWorkflowFiles();

  it('scans the tracked workflows', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it('every declared service container is reached by a step of its job', () => {
    const violations = workflows.flatMap((workflow) =>
      unreached(workflow, readFileSync(join(REPO_ROOT, workflow), 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  describe('reference classification', () => {
    it('flags a service no step reaches', () => {
      expect(unreached('w.yml', fixture(REDIS, '      - run: npm ci'))).toEqual([
        'w.yml job probe: service redis',
      ]);
    });

    it('does not accept the service id as a bare word (a script path is not a connection)', () => {
      const steps = '      - run: python3 scripts/nats/generate-nats-conf.py --check';
      expect(unreached('w.yml', fixture(NATS, steps))).toEqual(['w.yml job probe: service nats']);
    });

    it('does not mistake a URL user name for the host', () => {
      const postgres = '      postgres:\n        image: p';
      const steps = '      - run: psql postgres://postgres:pw@db.example.com:5432/app';
      expect(unreached('w.yml', fixture(postgres, steps))).toEqual([
        'w.yml job probe: service postgres',
      ]);
    });

    it('does not let one service port vouch for another service', () => {
      const steps = [
        '      - run: npm test',
        '        env:',
        '          NATS_URL: nats://localhost:4222',
      ];
      expect(unreached('w.yml', fixture(`${REDIS}\n${NATS}`, steps.join('\n')))).toEqual([
        'w.yml job probe: service redis',
      ]);
    });

    it.each([
      [
        'a localhost URL in step env',
        '      - run: x\n        env:\n          URL: redis://localhost:6379',
        '',
      ],
      ['a 127.0.0.1 address in run', '      - run: redis-cli -u redis://127.0.0.1:6379 ping', ''],
      [
        'granular HOST + PORT env',
        '      - run: x\n        env:\n          REDIS_HOST: localhost\n          REDIS_PORT: 6379',
        '',
      ],
      [
        'the service id as a URL host',
        '      - run: x\n        env:\n          URL: redis://redis:6379/0',
        '',
      ],
      [
        'the service id as a *HOST env value',
        '      - run: x\n        env:\n          CACHE_HOST: redis',
        '',
      ],
      ['a job.services expression', '      - run: echo ${{ job.services.redis.ports[6379] }}', ''],
      [
        'job-level env',
        '      - run: npm test',
        '    env:\n      REDIS_URL: redis://localhost:6379',
      ],
    ])('accepts %s', (_label, steps, jobExtra) => {
      expect(unreached('w.yml', fixture(REDIS, steps, jobExtra))).toEqual([]);
    });

    it('reads the host side of each port mapping', () => {
      expect(publishedHostPorts(['16379:6379', '4222', 8222, '127.0.0.1:5432:5432/tcp'])).toEqual([
        '16379',
        '5432',
      ]);
    });
  });
});
