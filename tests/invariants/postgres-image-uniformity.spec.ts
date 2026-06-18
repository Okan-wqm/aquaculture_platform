/**
 * Platform-wide invariant: postgres image is governed by one manifest across
 * CI workflows and every docker-compose file.
 *
 * INFRA-CRITICAL-010 closed the pgvector-missing failure by switching every
 * postgres callsite to the digest-pinned image in
 * `.github/manifests/postgres-image.json`. This invariant locks the contract:
 * a future regression that introduces a different image, unpins the digest, or
 * adds an undeclared consumer fails CI before drift can land.
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
const POSTGRES_IMAGE_MANIFEST_PATH = join(
  REPO_ROOT,
  '.github',
  'manifests',
  'postgres-image.json',
);

// Files in scope: every workflow yml + every docker-compose*.yml.
// We exclude node_modules, dist, worktrees, and historical review docs.
const SCOPE_GLOBS = [
  '.github/workflows/*.yml',
  'docker-compose*.yml',
];

interface PostgresImageManifest {
  schemaVersion: number;
  image: string;
  imageFamily: string;
  postgresMajor: number;
  requiredCapabilities: string[];
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

function readPostgresImageManifest(): PostgresImageManifest {
  const parsed: unknown = JSON.parse(readFileSync(POSTGRES_IMAGE_MANIFEST_PATH, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Postgres image manifest must be a JSON object');
  }
  return {
    schemaVersion: numberValue(parsed.schema_version, 'schema_version'),
    image: stringValue(parsed.image, 'image'),
    imageFamily: stringValue(parsed.image_family, 'image_family'),
    postgresMajor: numberValue(parsed.postgres_major, 'postgres_major'),
    requiredCapabilities: stringArray(parsed.required_capabilities, 'required_capabilities'),
    consumers: stringArray(parsed.consumers, 'consumers'),
  };
}

function readPostgresImageReferences(): ImageReference[] {
  const cmd =
    `git -C ${REPO_ROOT} grep -nE '^[[:space:]]*image:[[:space:]]+(.*timescaledb.*|.*postgres.*|.*pgvector.*)' -- ` +
    SCOPE_GLOBS.map((g) => `'${g}'`).join(' ');

  let raw: string;
  try {
    raw = execSync(cmd, { encoding: 'utf8' });
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) {
      throw new Error('No postgres image references found in workflow or docker-compose scope');
    }
    throw err;
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

describe('INVARIANT: postgres image is uniform + SHA-pinned', () => {
  it('asserts every postgres `image:` reference matches the manifest SSoT', () => {
    const manifest = readPostgresImageManifest();
    const references = readPostgresImageReferences();

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.image).toMatch(/^timescale\/timescaledb-ha:pg16@sha256:[a-f0-9]{64}$/);
    expect(manifest.imageFamily).toBe('timescale/timescaledb-ha');
    expect(manifest.postgresMajor).toBe(16);
    expect(manifest.requiredCapabilities).toEqual(
      expect.arrayContaining(['timescaledb', 'pgvector', 'hnsw_vector_cosine_ops']),
    );

    const referencedConsumers = Array.from(new Set(references.map((reference) => reference.file)));
    expect(referencedConsumers.sort()).toEqual([...manifest.consumers].sort());

    const divergentReferences = references.filter((reference) => reference.image !== manifest.image);
    if (divergentReferences.length > 0) {
      throw new Error(
        `INFRA-CRITICAL-010 invariant VIOLATED — postgres image references do not match ` +
          `.github/manifests/postgres-image.json.\n` +
          divergentReferences
            .map((reference) => `  - ${reference.file}:${reference.line} -> ${reference.image}`)
            .join('\n') +
          `\n\nFix: update the manifest intentionally, then update every workflow yml and docker-compose*.yml consumer to the manifest image.`,
      );
    }

    // Enforce SHA-pinning per SEC-CI-002.
    if (!manifest.image.includes('@sha256:')) {
      throw new Error(
        `INFRA-CRITICAL-010 / SEC-CI-002 invariant VIOLATED — postgres image is not digest-pinned: "${manifest.image}".\n` +
          `Fix: append @sha256:<digest> to the image tag.`,
      );
    }

    // Enforce HA edition (the tag that ships with pgvector).
    if (!manifest.image.includes(manifest.imageFamily)) {
      throw new Error(
        `INFRA-CRITICAL-010 invariant VIOLATED — postgres image is not the HA edition: "${manifest.image}".\n` +
          `The HA edition (timescale/timescaledb-ha:*) is required because messaging-service\n` +
          `migration 1800700000000-AddMessagesEmbeddingColumn.ts creates an HNSW index using vector_cosine_ops,\n` +
          `which requires pgvector. The non-HA timescaledb image does not include pgvector.`,
      );
    }
  });
});
