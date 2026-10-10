/**
 * Platform-wide invariant: CI never pulls a container image from Docker Hub anonymously.
 *
 * GitHub-hosted runners share egress IPs, so Docker Hub's anonymous pull quota is shared
 * with every other repository on those runners. On a busy day the quota runs out and every
 * job that starts a Docker Hub service container fails with `toomanyrequests` before its
 * first step, whatever the change under test (INFRA-HIGH-213: ARIA's first PR, #1906,
 * failed `CI - Affected` three times this way).
 *
 * Every image a workflow job service/container or a Rust testcontainer pulls must name its
 * registry host explicitly (`public.ecr.aws/docker/library/<image>` for Docker official
 * images, `ghcr.io/...` for images the org publishes). A bare `redis:7-alpine` or
 * `timescale/timescaledb-ha:...` resolves to Docker Hub and fails this spec.
 *
 * The only exceptions are image families listed in DOCKER_HUB_EXCEPTIONS, each keyed to an
 * OPEN registry finding that owns moving it. Closing that finding without removing the
 * exception fails here too, so an exception cannot outlive its fix.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FINDINGS_REGISTRY_PATH = join(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

/**
 * Docker Hub image families CI still pulls, each owned by an OPEN finding.
 * timescale/timescaledb-ha is not on the ECR official-image mirror; INFRA-HIGH-214 owns
 * moving it (with Dockerfile bases and the buildkit image) to a registry the org controls.
 */
const DOCKER_HUB_EXCEPTIONS: Readonly<Record<string, string>> = {
  'timescale/timescaledb-ha': 'INFRA-HIGH-214',
};

interface ImageReference {
  readonly source: string;
  readonly image: string;
}

function gitGrep(pattern: string, pathspecs: readonly string[]): string[] {
  try {
    return execSync(
      `git -C ${REPO_ROOT} grep -nE '${pattern}' -- ${pathspecs.map((p) => `'${p}'`).join(' ')}`,
      { encoding: 'utf8' },
    )
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

/** `GenericImage::new("<name>", "<tag>")` in Rust tests (testcontainers-rs). */
function rustTestcontainerReferences(): ImageReference[] {
  return gitGrep('GenericImage::new\\(', ['*.rs']).map((line) => {
    const match = line.match(/^([^:]+:\d+):.*GenericImage::new\(\s*"([^"]+)"\s*,\s*"([^"]+)"/);
    if (!match) {
      throw new Error(
        `GenericImage::new must take string literals so its registry is reviewable: ${line}`,
      );
    }
    return { source: match[1]!, image: `${match[2]!}:${match[3]!}` };
  });
}

/** Docker resolves a reference to Docker Hub when its first path component is not a host. */
function registryHost(image: string): string | null {
  const slash = image.indexOf('/');
  if (slash < 0) {
    return null;
  }
  const first = image.slice(0, slash);
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : null;
}

function imageFamily(image: string): string {
  return image.split('@')[0]!.replace(/:[^/]*$/, '');
}

function openFindingIds(): Set<string> {
  const open = new Set<string>();
  for (const line of readFileSync(FINDINGS_REGISTRY_PATH, 'utf8').split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const row = JSON.parse(line) as { id?: unknown; state?: unknown };
    if (typeof row.id === 'string' && (row.state === 'OPEN' || row.state === 'IN-PROGRESS')) {
      open.add(row.id);
    } else if (typeof row.id === 'string') {
      open.delete(row.id);
    }
  }
  return open;
}

describe('INVARIANT: CI images never come from Docker Hub anonymously (INFRA-HIGH-213)', () => {
  const references = [...workflowImageReferences(), ...rustTestcontainerReferences()];

  it('finds the image references it guards', () => {
    expect(references.length).toBeGreaterThan(30);
  });

  it('names an explicit registry host for every image outside the tracked exceptions', () => {
    const violations = references
      .filter((ref) => registryHost(ref.image) === null)
      .filter((ref) => !(imageFamily(ref.image) in DOCKER_HUB_EXCEPTIONS))
      .map((ref) => `${ref.source} ${ref.image}`);
    expect(violations).toEqual([]);
  });

  it('keys every Docker Hub exception to an OPEN finding and an image still in use', () => {
    const open = openFindingIds();
    const families = new Set(references.map((ref) => imageFamily(ref.image)));
    for (const [family, findingId] of Object.entries(DOCKER_HUB_EXCEPTIONS)) {
      expect({ family, findingOpen: open.has(findingId) }).toEqual({ family, findingOpen: true });
      expect({ family, inUse: families.has(family) }).toEqual({ family, inUse: true });
    }
  });

  it('classifies registry hosts the way the Docker CLI does', () => {
    expect(registryHost('redis:7-alpine')).toBeNull();
    expect(registryHost('timescale/timescaledb-ha:pg16@sha256:00')).toBeNull();
    expect(registryHost('public.ecr.aws/docker/library/redis:7-alpine')).toBe('public.ecr.aws');
    expect(registryHost('ghcr.io/okan-wqm/aquaculture_platform/mosquitto:abc')).toBe('ghcr.io');
    expect(registryHost('localhost:5000/img:1')).toBe('localhost:5000');
    expect(imageFamily('timescale/timescaledb-ha:pg16@sha256:00')).toBe('timescale/timescaledb-ha');
    expect(imageFamily('localhost:5000/img:1')).toBe('localhost:5000/img');
  });
});
