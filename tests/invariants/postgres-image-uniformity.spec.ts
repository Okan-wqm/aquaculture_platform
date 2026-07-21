/**
 * Platform-wide invariant: every Postgres image is governed by one manifest.
 *
 * INFRA-CRITICAL-010 closed the pgvector-missing failure by switching every
 * postgres callsite to the digest-pinned upstream image in the manifest.
 * INFRA-HIGH-039 adds one intentional production derivative containing the
 * checksum-pinned WAL-G binary. All CI/dev consumers stay on the upstream
 * digest; the droplet alone consumes the GHCR derivative whose release tag is
 * resolved and verified by the deploy digest manifest.
 *
 * Why uniformity matters:
 *   - Production migrations create indexes / extensions that depend on
 *     specific server features (pgvector HNSW, TimescaleDB hypertables).
 *     A test environment with a different image silently passes when
 *     production would fail.
 *   - Per SEC-CI-002, every container image must be SHA-pinned. Floating
 *     tags reintroduce supply-chain drift the platform spent effort to
 *     close.
 *   - Single source of truth: when the image needs bumping, the manifest is the
 *     authority and every callsite must match it exactly. Multiple values mean
 *     divergence and inconsistent test/prod behaviour.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POSTGRES_IMAGE_MANIFEST_PATH = join(REPO_ROOT, '.github', 'manifests', 'postgres-image.json');
const DROPLET_COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.droplet.yml');
const WALG_RUNTIME_COMMAND_PATH = join(
  REPO_ROOT,
  'infrastructure',
  'docker',
  'scripts',
  'walg-runtime-command.sh',
);
const WALG_SECRET_LOADER_PATH = join(
  REPO_ROOT,
  'infrastructure',
  'docker',
  'scripts',
  'walg-load-secrets.sh',
);

// Files in scope: every workflow yml + every docker-compose*.yml.
// We exclude node_modules, dist, worktrees, and historical review docs.
const SCOPE_GLOBS = ['.github/workflows/*.yml', 'docker-compose*.yml'];

interface PostgresImageManifest {
  schemaVersion: number;
  image: string;
  imageFamily: string;
  productionImage: string;
  productionImageFamily: string;
  dockerfile: string;
  buildContext: string;
  postgresMajor: number;
  requiredCapabilities: string[];
  productionRequiredCapabilities: string[];
  walG: {
    version: string;
    revision: string;
    asset: string;
    assetSha256: string;
    binaryPath: string;
  };
  baseConsumers: string[];
  productionConsumers: string[];
  consumers: string[];
}

interface ImageReference {
  file: string;
  line: number;
  image: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string field: ${field}`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Expected numeric field: ${field}`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Expected string array field: ${field}`);
  }
  return value;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected object field: ${field}`);
  }
  return value;
}

function readPostgresImageManifest(): PostgresImageManifest {
  const parsed: unknown = JSON.parse(readFileSync(POSTGRES_IMAGE_MANIFEST_PATH, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Postgres image manifest must be a JSON object');
  }
  const walG = recordValue(parsed.wal_g, 'wal_g');
  return {
    schemaVersion: numberValue(parsed.schema_version, 'schema_version'),
    image: stringValue(parsed.image, 'image'),
    imageFamily: stringValue(parsed.image_family, 'image_family'),
    productionImage: stringValue(parsed.production_image, 'production_image'),
    productionImageFamily: stringValue(parsed.production_image_family, 'production_image_family'),
    dockerfile: stringValue(parsed.dockerfile, 'dockerfile'),
    buildContext: stringValue(parsed.build_context, 'build_context'),
    postgresMajor: numberValue(parsed.postgres_major, 'postgres_major'),
    requiredCapabilities: stringArray(parsed.required_capabilities, 'required_capabilities'),
    productionRequiredCapabilities: stringArray(
      parsed.production_required_capabilities,
      'production_required_capabilities',
    ),
    walG: {
      version: stringValue(walG.version, 'wal_g.version'),
      revision: stringValue(walG.revision, 'wal_g.revision'),
      asset: stringValue(walG.asset, 'wal_g.asset'),
      assetSha256: stringValue(walG.asset_sha256, 'wal_g.asset_sha256'),
      binaryPath: stringValue(walG.binary_path, 'wal_g.binary_path'),
    },
    baseConsumers: stringArray(parsed.base_consumers, 'base_consumers'),
    productionConsumers: stringArray(parsed.production_consumers, 'production_consumers'),
    consumers: stringArray(parsed.consumers, 'consumers'),
  };
}

function readPostgresImageReferences(): ImageReference[] {
  const cmd =
    `git -C ${REPO_ROOT} grep -nE '^[[:space:]]*image:[[:space:]]+(.*timescaledb.*|.*postgres.*|.*pgvector.*)' -- ` +
    SCOPE_GLOBS.map((glob) => `'${glob}'`).join(' ');

  let raw: string;
  try {
    raw = execSync(cmd, { encoding: 'utf8' });
  } catch (error) {
    const commandError = error as { status?: number };
    if (commandError.status === 1) {
      throw new Error('No postgres image references found in workflow or docker-compose scope');
    }
    throw error;
  }

  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) {
        throw new Error(`Unable to parse postgres image reference: ${line}`);
      }
      const file = match[1]!;
      const lineNumber = Number(match[2]!);
      const image = match[3]!
        .replace(/^[\s]*image:\s*/, '')
        .trim()
        .split('#')[0]!
        .trim();
      return { file, line: lineNumber, image };
    });
}

function shellCaseBranch(script: string, branch: string, nextBranch: string): string {
  const branchStart = script.indexOf(`  ${branch})`);
  const branchEnd = script.indexOf(`  ${nextBranch})`, branchStart + 1);
  if (branchStart < 0 || branchEnd < 0) {
    throw new Error(`Could not extract shell case branch ${branch}`);
  }
  return script.slice(branchStart, branchEnd);
}

describe('INVARIANT: Postgres images are manifest-governed and immutable', () => {
  it('pins the upstream base and permits the production derivative only on the droplet', () => {
    const manifest = readPostgresImageManifest();
    const references = readPostgresImageReferences();

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.image).toMatch(/^timescale\/timescaledb-ha:pg16@sha256:[a-f0-9]{64}$/);
    expect(manifest.imageFamily).toBe('timescale/timescaledb-ha');
    expect(manifest.productionImage).toBe(
      'ghcr.io/okan-wqm/aquaculture_platform/postgres:${TAG:?TAG required}',
    );
    expect(manifest.productionImage).toContain(manifest.productionImageFamily);
    expect(manifest.buildContext).toBe('.');
    expect(manifest.postgresMajor).toBe(16);
    expect(manifest.requiredCapabilities).toEqual(
      expect.arrayContaining(['timescaledb', 'pgvector', 'hnsw_vector_cosine_ops']),
    );
    expect(manifest.productionRequiredCapabilities).toEqual(
      expect.arrayContaining([...manifest.requiredCapabilities, 'wal-g']),
    );

    expect(
      manifest.baseConsumers.filter((consumer) => manifest.productionConsumers.includes(consumer)),
    ).toEqual([]);
    expect([...manifest.baseConsumers, ...manifest.productionConsumers].sort()).toEqual(
      [...manifest.consumers].sort(),
    );

    const referencedConsumers = Array.from(new Set(references.map((reference) => reference.file)));
    expect(referencedConsumers.sort()).toEqual([...manifest.consumers].sort());

    const productionConsumers = new Set(manifest.productionConsumers);
    const divergentReferences = references.filter((reference) => {
      const expected = productionConsumers.has(reference.file)
        ? manifest.productionImage
        : manifest.image;
      return reference.image !== expected;
    });
    if (divergentReferences.length > 0) {
      throw new Error(
        `INFRA-CRITICAL-010 / INFRA-HIGH-039 invariant VIOLATED — Postgres image references do not match ` +
          `.github/manifests/postgres-image.json.\n` +
          divergentReferences
            .map((reference) => `  - ${reference.file}:${reference.line} -> ${reference.image}`)
            .join('\n') +
          `\n\nFix: keep CI/dev consumers on image and production_consumers on production_image.`,
      );
    }

    if (!manifest.image.includes('@sha256:')) {
      throw new Error(
        `INFRA-CRITICAL-010 / SEC-CI-002 invariant VIOLATED — postgres image is not digest-pinned: "${manifest.image}".\n` +
          `Fix: append @sha256:<digest> to the image tag.`,
      );
    }

    if (!manifest.image.includes(manifest.imageFamily)) {
      throw new Error(
        `INFRA-CRITICAL-010 invariant VIOLATED — postgres image is not the HA edition: "${manifest.image}".\n` +
          `The HA edition (timescale/timescaledb-ha:*) is required because messaging-service\n` +
          `migration 1800700000000-AddMessagesEmbeddingColumn.ts creates an HNSW index using vector_cosine_ops,\n` +
          `which requires pgvector. The non-HA timescaledb image does not include pgvector.`,
      );
    }
  });

  it('checksum-pins the official WAL-G asset in the exact Timescale derivative', () => {
    const manifest = readPostgresImageManifest();
    const dockerfile = readFileSync(join(REPO_ROOT, manifest.dockerfile), 'utf8');
    const deployWorkflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'deploy-digitalocean.yml'),
      'utf8',
    );

    expect(manifest.walG).toEqual({
      version: 'v3.0.8',
      revision: 'f81943e64bdf97aa66f6c52fec55114703f97af7',
      asset: 'wal-g-pg-22.04-amd64',
      assetSha256: 'f30544c5ce93cf83b87578e3c4a2e9c0e0ffc3d160ef89ecddaf75f397d98deb',
      binaryPath: '/usr/local/bin/wal-g',
    });
    expect(dockerfile).toContain(`FROM ${manifest.image}`);
    expect(dockerfile).toContain(`ADD --checksum=sha256:${manifest.walG.assetSha256}`);
    expect(dockerfile).toContain(
      `https://github.com/wal-g/wal-g/releases/download/${manifest.walG.version}/${manifest.walG.asset}`,
    );
    expect(dockerfile).toContain(manifest.walG.binaryPath);
    expect(dockerfile).toContain(manifest.walG.revision);
    expect(dockerfile).toContain(
      "grep -Eq '^wal-g version v3\\.0\\.8[[:space:]]+f81943e([[:space:]]|$)'",
    );
    expect(dockerfile).toContain('ARG BUILD_MAIN_SHA=0000000000000000000000000000000000000000');
    expect(dockerfile).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(dockerfile).toContain('org.opencontainers.image.revision="${BUILD_MAIN_SHA}"');
    expect(deployWorkflow).toMatch(
      /build-infra-images:[\s\S]*?Build \$\{\{ matrix\.image \}\} without registry authority[\s\S]*?push:\s*false[\s\S]*?build-args:\s*\|\s*BUILD_MAIN_SHA=\$\{\{ github\.sha \}\}[\s\S]*?Publish exact-current-main \$\{\{ matrix\.image \}\} image/,
    );
    expect(dockerfile.trimEnd()).toMatch(/USER root$/);
  });

  it('keeps WAL-G credentials outside the physical PGDATA backup boundary', () => {
    const compose = readFileSync(DROPLET_COMPOSE_PATH, 'utf8');
    const runtimeCommand = readFileSync(WALG_RUNTIME_COMMAND_PATH, 'utf8');
    const secretLoader = readFileSync(WALG_SECRET_LOADER_PATH, 'utf8');
    const backupPushBranch = shellCaseBranch(runtimeCommand, 'backup-push-full', 'wal-verify');
    const backupFetchBranch = shellCaseBranch(
      runtimeCommand,
      'backup-fetch',
      'assert-pgdata-boundary',
    );

    expect(compose).toContain('WALG_SECRET_DIR: /run/aqua-walg-secrets');
    expect(compose).not.toMatch(/WALG_SECRET_(?:DIR|RUNTIME_DIR):\s*\/var\/lib\/postgresql\/data/);
    expect(compose).not.toContain('/var/lib/postgresql/data/wal-g-secrets');

    expect(backupPushBranch.indexOf('assert_pgdata_boundary')).toBeGreaterThanOrEqual(0);
    expect(backupPushBranch.indexOf('assert_pgdata_boundary')).toBeLessThan(
      backupPushBranch.indexOf('walg_exec backup-push'),
    );
    expect(backupFetchBranch.indexOf('walg_exec backup-fetch')).toBeGreaterThanOrEqual(0);
    expect(backupFetchBranch.indexOf('assert_pgdata_boundary')).toBeGreaterThan(
      backupFetchBranch.indexOf('walg_exec backup-fetch'),
    );

    expect(secretLoader).toContain(
      'WALG_SECRET_DIR must resolve directly to the WAL-G tmpfs runtime directory',
    );
    expect(`${secretLoader}\n${runtimeCommand}`).not.toMatch(/\bln\s+/);
  });
});
