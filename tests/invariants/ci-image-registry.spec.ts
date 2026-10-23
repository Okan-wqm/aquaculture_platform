/**
 * Platform-wide invariant: CI pulls no third-party image anonymously.
 *
 * # WHY
 *
 * GitHub-hosted runners share egress IPs, and anonymous registry quotas are per source IP, so
 * every other tenant on those IPs spends the same quota. When it runs out, every job that pulls
 * an image fails with `toomanyrequests` before its first step, whatever the change.
 *
 *   - Docker Hub's anonymous pull limit failed ARIA's first PR (#1906) three times
 *     (INFRA-HIGH-213). #1924 moved the images to ECR Public on the premise that it had no
 *     anonymous limit for this use.
 *   - That premise was false. ECR Public allows 500 GB/month and 1 pull/s per anonymous source
 *     IP, neither adjustable. On 2026-10-16 it failed most CI-Affected runs. Removing the pulls
 *     no step used (INFRA-HIGH-225, ci-service-containers-used.spec.ts) left the ones CI needs:
 *     the CI-Affected test job's nats service, Rust CI's NATS testcontainer, ci-full's redis
 *     and e2e-messaging's redis (INFRA-HIGH-227).
 *
 * The fix is a registry the org controls. `.github/manifests/ci-images.json` records each image
 * once (mirror repository, tag, upstream index digest). `.github/workflows/ci-image-mirror.yml`
 * copies each digest into GHCR byte-for-byte, and consumers pull the copy with their job's
 * GITHUB_TOKEN, which draws on no anonymous quota.
 *
 * # WHAT this spec holds
 *
 *   1. The manifest is well-formed and every entry has a consumer.
 *   2. Every workflow `image:` / `container:` scalar is one of: a manifest mirror ref spelled
 *      exactly `<mirror>:<tag>@<digest>`; an image this repository builds
 *      (ghcr.io/okan-wqm/aquaculture_platform/<name>, outside ci/); or a Docker Hub family in
 *      DOCKER_HUB_EXCEPTIONS keyed to an unresolved finding. A bare Docker Hub name, any
 *      public.ecr.aws ref, any other registry and a mirror ref with a stale digest all fail.
 *   3. A workflow job that pulls from GHCR passes `credentials` with GITHUB_TOKEN and grants
 *      `packages: read`. An anonymous GHCR pull would work only while the package stays public,
 *      and would draw on GHCR's anonymous limits.
 *   4. A Rust testcontainer takes its image from the manifest (`ci_image("<name>", "<tag>")`,
 *      which reads ci-images.json through `include_str!`), never from a string literal. The
 *      Rust test then holds no second copy of a digest.
 *   5. No workflow, composite action, Rust source or CI script names a
 *      `public.ecr.aws/docker/library/` image outside a comment.
 *   6. The mirror workflow runs on every change to the manifest, on pull requests and on main,
 *      with `packages: write`, and copies by digest without annotations (an annotation changes
 *      the index digest every consumer pins).
 *
 * The Docker Hub exceptions are image families still owned by an unresolved finding
 * (isUnresolvedFindingState: every state but RESOLVED, so the sweep's STALE and BLOCKED
 * judgements keep the debt). Resolving that finding while the exception remains fails here, and
 * so does an exception whose image is no longer used. An exception cannot outlive its fix.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

import { isUnresolvedFindingState } from '../../tools/gates/finding-registry-chain';
// The Docker reference grammar has one owner, shared with ARIA's infrastructure-policy
// adapter (ARIA-HIGH-012): `.registry` is null exactly when the CLI resolves to Docker Hub,
// `.name` is the reference without tag or digest (the image family).
import { parseImageReference } from '../../tools/gates/infra-policy/image-reference';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FINDINGS_REGISTRY_PATH = join(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');
const CI_IMAGES_MANIFEST = '.github/manifests/ci-images.json';
const MIRROR_WORKFLOW = '.github/workflows/ci-image-mirror.yml';
const ORG_REGISTRY = 'ghcr.io/okan-wqm/aquaculture_platform';
const MIRROR_PREFIX = `${ORG_REGISTRY}/ci`;

/**
 * Docker Hub image families CI still pulls, each owned by an unresolved finding.
 * timescale/timescaledb-ha (with the Dockerfile FROM bases and the buildkit image) is
 * INFRA-HIGH-214's: moving it into ci-images.json also moves postgres-image.json's SSOT.
 */
const DOCKER_HUB_EXCEPTIONS: Readonly<Record<string, string>> = {
  'timescale/timescaledb-ha': 'INFRA-HIGH-214',
};

type Mapping = Record<string, unknown>;

interface CiImage {
  readonly name: string;
  readonly upstream: string;
  readonly digest: string;
  readonly mirror: string;
  readonly tag: string;
}

interface ImageReference {
  readonly source: string;
  readonly image: string;
}

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadManifest(): { schemaVersion: unknown; images: unknown } {
  return JSON.parse(readFileSync(join(REPO_ROOT, CI_IMAGES_MANIFEST), 'utf8')) as {
    schemaVersion: unknown;
    images: unknown;
  };
}

function manifestImages(): CiImage[] {
  const { images } = loadManifest();
  if (!Array.isArray(images)) {
    throw new Error(`${CI_IMAGES_MANIFEST}: "images" must be an array`);
  }
  return images.map((entry: unknown, index): CiImage => {
    if (!isMapping(entry)) {
      throw new Error(`${CI_IMAGES_MANIFEST}: images[${index}] is not an object`);
    }
    const field = (key: keyof CiImage): string => {
      const value = entry[key];
      if (typeof value !== 'string') {
        throw new Error(`${CI_IMAGES_MANIFEST}: images[${index}].${key} must be a string`);
      }
      return value;
    };
    return {
      name: field('name'),
      upstream: field('upstream'),
      digest: field('digest'),
      mirror: field('mirror'),
      tag: field('tag'),
    };
  });
}

/** The one spelling a consumer may use: tag for the reader, digest for the pull. */
function mirrorRef(image: CiImage): string {
  return `${image.mirror}:${image.tag}@${image.digest}`;
}

function gitGrep(pattern: string, pathspecs: readonly string[]): string[] {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'grep', '-nE', pattern, '--', ...pathspecs], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.length > 0);
  } catch (error) {
    const grepError = error as { status?: number };
    if (grepError.status === 1) {
      return [];
    }
    throw error;
  }
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

/** `image:` / `container:` scalars in workflow YAML; expressions and mappings are skipped. */
function workflowImageReferences(): ImageReference[] {
  return gitGrep('^[[:space:]]*(image|container):[[:space:]]+[^[:space:]{$]', [
    '.github/workflows/*.yml',
    '.github/workflows/*.yaml',
  ]).map((line) => {
    const match = line.match(/^([^:]+:\d+):\s*(?:image|container):\s*['"]?([^'"\s#]+)/);
    if (!match) {
      throw new Error(`Unable to parse workflow image reference: ${line}`);
    }
    return { source: match[1]!, image: match[2]! };
  });
}

/** `ci_image("<name>", "<tag>")` calls in Rust: testcontainers resolved from the manifest. */
function rustManifestConsumers(): ImageReference[] {
  return gitGrep('ci_image\\([[:space:]]*"', ['*.rs']).map((line) => {
    const match = line.match(/^([^:]+:\d+):.*ci_image\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
    if (!match) {
      throw new Error(`ci_image must take a string-literal name and tag: ${line}`);
    }
    return { source: match[1]!, image: `${match[2]!}:${match[3]!}` };
  });
}

/** Finding ids whose latest registry row is still owed (the registry's one predicate). */
function unresolvedFindingIds(): Set<string> {
  const unresolved = new Set<string>();
  for (const line of readFileSync(FINDINGS_REGISTRY_PATH, 'utf8').split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const row = JSON.parse(line) as { id?: unknown; state?: unknown };
    if (typeof row.id !== 'string') {
      continue;
    }
    if (typeof row.state === 'string' && isUnresolvedFindingState(row.state)) {
      unresolved.add(row.id);
    } else {
      unresolved.delete(row.id);
    }
  }
  return unresolved;
}

/** Why a workflow image ref is not an approved form, or null when it is. */
function imageViolation(image: string, mirrorRefs: ReadonlySet<string>): string | null {
  if (mirrorRefs.has(image)) return null;
  const { registry, name: family } = parseImageReference(image);
  if (family.startsWith(`${MIRROR_PREFIX}/`)) {
    return `is not spelled as a ${CI_IMAGES_MANIFEST} entry (<mirror>:<tag>@<digest>)`;
  }
  if (family.startsWith(`${ORG_REGISTRY}/`)) return null;
  if (registry === null && family in DOCKER_HUB_EXCEPTIONS) return null;
  return `is a third-party registry pull; mirror it through ${CI_IMAGES_MANIFEST}`;
}

interface GhcrPull {
  readonly where: string;
  readonly hasTokenCredentials: boolean;
  readonly packagesReadable: boolean;
}

function grantsPackagesRead(permissions: unknown): boolean {
  if (permissions === 'read-all' || permissions === 'write-all') return true;
  return isMapping(permissions) && ['read', 'write'].includes(String(permissions.packages));
}

function usesJobToken(credentials: unknown): boolean {
  return (
    isMapping(credentials) &&
    /^\$\{\{\s*(secrets\.GITHUB_TOKEN|github\.token)\s*\}\}$/.test(String(credentials.password))
  );
}

/** Every job service / job container that pulls from GHCR, with how it authenticates. */
function ghcrPulls(): GhcrPull[] {
  const pulls: GhcrPull[] = [];
  for (const workflow of trackedWorkflowFiles()) {
    const doc = yaml.load(readFileSync(join(REPO_ROOT, workflow), 'utf8'));
    if (!isMapping(doc) || !isMapping(doc.jobs)) continue;
    for (const [jobId, job] of Object.entries(doc.jobs)) {
      if (!isMapping(job)) continue;
      const permissions = job.permissions ?? doc.permissions;
      const pullers: Array<[string, unknown]> = [['container', job.container]];
      if (isMapping(job.services)) {
        pullers.push(
          ...Object.entries(job.services).map(([id, svc]): [string, unknown] => [
            `services.${id}`,
            svc,
          ]),
        );
      }
      for (const [key, spec] of pullers) {
        const image = typeof spec === 'string' ? spec : isMapping(spec) ? spec.image : undefined;
        if (typeof image !== 'string' || !image.startsWith('ghcr.io/')) continue;
        pulls.push({
          where: `${workflow} jobs.${jobId}.${key}`,
          hasTokenCredentials: isMapping(spec) && usesJobToken(spec.credentials),
          packagesReadable: grantsPackagesRead(permissions),
        });
      }
    }
  }
  return pulls;
}

/** A line that is only a comment in YAML, shell, Rust or TS. */
function isCommentLine(text: string): boolean {
  return /^\s*(#|\/\/|\*|\/\*)/.test(text);
}

describe('INVARIANT: CI pulls no third-party image anonymously (INFRA-HIGH-213, INFRA-HIGH-227)', () => {
  const images = manifestImages();
  const mirrorRefs = new Set(images.map(mirrorRef));
  const workflowRefs = workflowImageReferences();
  const rustRefs = rustManifestConsumers();

  // Both extractors must be live: a parse regression that returns nothing would turn every
  // check below vacuously green. This is deliberately not a count floor. A floor of "> 30" once
  // counted 25 service pulls that no step used as coverage (INFRA-HIGH-225).
  it('finds the image references it guards', () => {
    expect(workflowRefs.length).toBeGreaterThan(0);
    expect(rustRefs.length).toBeGreaterThan(0);
    expect(images.length).toBeGreaterThan(0);
  });

  it('keeps ci-images.json well-formed: one entry per name:tag, mirror under ci/, digest pinned', () => {
    expect(loadManifest().schemaVersion).toBe(1);
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const image of images) {
      const key = `${image.name}:${image.tag}`;
      if (seen.has(key)) problems.push(`${key} is listed twice`);
      seen.add(key);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(image.name)) problems.push(`${key}: bad name`);
      if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(image.tag)) problems.push(`${key}: bad tag`);
      if (!/^sha256:[0-9a-f]{64}$/.test(image.digest)) problems.push(`${key}: digest not sha256`);
      if (image.mirror !== `${MIRROR_PREFIX}/${image.name}`) {
        problems.push(`${key}: mirror must be ${MIRROR_PREFIX}/${image.name}`);
      }
      if (image.upstream !== `docker.io/library/${image.name}:${image.tag}`) {
        problems.push(`${key}: upstream must be docker.io/library/${image.name}:${image.tag}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every ci-images.json entry at least one consumer', () => {
    const consumed = new Set([
      ...workflowRefs.map((ref) => ref.image).filter((image) => mirrorRefs.has(image)),
      ...rustRefs.map((ref) => {
        const image = images.find((entry) => `${entry.name}:${entry.tag}` === ref.image);
        return image ? mirrorRef(image) : ref.image;
      }),
    ]);
    const unused = images.map(mirrorRef).filter((ref) => !consumed.has(ref));
    expect(unused).toEqual([]);
  });

  it('pulls every workflow image from the mirror, an org-built image or a tracked exception', () => {
    const violations = workflowRefs.flatMap((ref) => {
      const reason = imageViolation(ref.image, mirrorRefs);
      return reason === null ? [] : [`${ref.source} ${ref.image} ${reason}`];
    });
    expect(violations).toEqual([]);
  });

  it('authenticates every GHCR service/container pull with the job GITHUB_TOKEN', () => {
    const pulls = ghcrPulls();
    expect(pulls.length).toBeGreaterThan(0);
    const anonymous = pulls
      .filter((pull) => !pull.hasTokenCredentials || !pull.packagesReadable)
      .map(
        (pull) =>
          `${pull.where}: credentials=${pull.hasTokenCredentials} packages-read=${pull.packagesReadable}`,
      );
    expect(anonymous).toEqual([]);
  });

  it('resolves every Rust testcontainer image from the manifest, never a literal', () => {
    const literalImages = gitGrep('GenericImage::new\\([[:space:]]*"', ['*.rs']).filter(
      (line) =>
        !line.includes(`GenericImage::new("${ORG_REGISTRY}/`) || line.includes(MIRROR_PREFIX),
    );
    expect(literalImages).toEqual([]);

    const unknown = rustRefs
      .filter((ref) => !images.some((image) => `${image.name}:${image.tag}` === ref.image))
      .map((ref) => `${ref.source} ci_image(${ref.image}) is not a ${CI_IMAGES_MANIFEST} entry`);
    expect(unknown).toEqual([]);

    const files = new Set(rustRefs.map((ref) => ref.source.replace(/:\d+$/, '')));
    const unread = [...files].filter(
      (file) => !readFileSync(join(REPO_ROOT, file), 'utf8').includes(CI_IMAGES_MANIFEST),
    );
    expect(unread).toEqual([]);
  });

  it('names no public.ecr.aws Docker official image outside a comment', () => {
    const refs = gitGrep('public\\.ecr\\.aws/docker/library/', [
      '.github/workflows/*.yml',
      '.github/workflows/*.yaml',
      '.github/actions/**',
      '*.rs',
      'scripts/**',
      'libs/migration-harness/**',
    ]).filter((line) => !isCommentLine(line.replace(/^[^:]+:\d+:/, '')));
    expect(refs).toEqual([]);
  });

  it('runs the mirror on every manifest change, on PRs and main, copying by digest', () => {
    const doc = yaml.load(readFileSync(join(REPO_ROOT, MIRROR_WORKFLOW), 'utf8')) as Mapping;
    const on = doc.on as Mapping;
    for (const event of ['push', 'pull_request'] as const) {
      const trigger = on[event] as Mapping;
      expect({ event, paths: trigger.paths }).toEqual({
        event,
        paths: expect.arrayContaining([CI_IMAGES_MANIFEST, MIRROR_WORKFLOW]),
      });
    }
    expect(on.push).toEqual(expect.objectContaining({ branches: ['main'] }));

    const jobs = Object.values(doc.jobs as Mapping).filter(isMapping);
    const mirrorJob = jobs.find((job) =>
      JSON.stringify(job.steps ?? []).includes('imagetools create'),
    );
    expect(mirrorJob).toBeDefined();
    expect(mirrorJob!.permissions).toEqual({ contents: 'read', packages: 'write' });
    const steps = JSON.stringify(mirrorJob!.steps);
    expect(steps).toContain(CI_IMAGES_MANIFEST);
    expect(steps).toMatch(/\}@\$\{digest\}/);
    expect(steps).not.toContain('--annotation');
  });

  it('keys every Docker Hub exception to an unresolved finding and an image still in use', () => {
    const unresolved = unresolvedFindingIds();
    const families = new Set(workflowRefs.map((ref) => parseImageReference(ref.image).name));
    for (const [family, findingId] of Object.entries(DOCKER_HUB_EXCEPTIONS)) {
      expect({ family, findingUnresolved: unresolved.has(findingId) }).toEqual({
        family,
        findingUnresolved: true,
      });
      expect({ family, inUse: families.has(family) }).toEqual({ family, inUse: true });
    }
  });

  it('classifies image references the way the Docker CLI does', () => {
    const registryHost = (image: string): string | null => parseImageReference(image).registry;
    const imageFamily = (image: string): string => parseImageReference(image).name;
    expect(registryHost('redis:7-alpine')).toBeNull();
    expect(registryHost('timescale/timescaledb-ha:pg16@sha256:00')).toBeNull();
    expect(registryHost('public.ecr.aws/docker/library/redis:7-alpine')).toBe('public.ecr.aws');
    expect(registryHost('ghcr.io/okan-wqm/aquaculture_platform/mosquitto:abc')).toBe('ghcr.io');
    expect(registryHost('localhost:5000/img:1')).toBe('localhost:5000');
    expect(imageFamily('timescale/timescaledb-ha:pg16@sha256:00')).toBe('timescale/timescaledb-ha');
    expect(imageFamily('localhost:5000/img:1')).toBe('localhost:5000/img');
    expect(imageFamily(`${MIRROR_PREFIX}/nats:2.10-alpine@sha256:00`)).toBe(
      `${MIRROR_PREFIX}/nats`,
    );

    const pinned = new Set([`${MIRROR_PREFIX}/nats:2.10-alpine@sha256:${'a'.repeat(64)}`]);
    expect(
      imageViolation(`${MIRROR_PREFIX}/nats:2.10-alpine@sha256:${'a'.repeat(64)}`, pinned),
    ).toBeNull();
    expect(
      imageViolation(`${MIRROR_PREFIX}/nats:2.10-alpine@sha256:${'b'.repeat(64)}`, pinned),
    ).toMatch(/not spelled/);
    expect(imageViolation(`${MIRROR_PREFIX}/nats:2.10-alpine`, pinned)).toMatch(/not spelled/);
    expect(imageViolation('public.ecr.aws/docker/library/nats:2.10-alpine', pinned)).toMatch(
      /third-party/,
    );
    expect(imageViolation('nats:2.10-alpine', pinned)).toMatch(/third-party/);
    expect(imageViolation('timescale/timescaledb-ha:pg16@sha256:00', pinned)).toBeNull();
    expect(imageViolation(`${ORG_REGISTRY}/mosquitto:abc`, pinned)).toBeNull();
  });
});
