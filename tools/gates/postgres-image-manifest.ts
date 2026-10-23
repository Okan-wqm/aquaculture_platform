/**
 * The Postgres image-manifest authority: which image every postgres-family reference must be,
 * read from the one manifest that owns it.
 *
 * WHY this module exists: `.github/manifests/postgres-image.json` is the single source of truth
 * for every TimescaleDB/Postgres/pgvector image on the tree (INFRA-CRITICAL-010; the digest pins
 * close SEC-CI-002's supply-chain drift). The shape check, the base-vs-production expectation and
 * the "what is a postgres-family image" words lived inline in
 * tests/invariants/postgres-image-uniformity.spec.ts alone, so the second consumer, the ARIA
 * infrastructure-policy adapter (ARIA-HIGH-012), would have had to copy them, and the copy would
 * drift the first time the manifest moved. Both import them here; the manifest file stays the
 * only authority.
 *
 * The parser takes the manifest's text, not a path: the spec reads it from the checkout and the
 * adapter reads it through its contained workspace (tools/aria-adapters/adapter-fs.ts), so the
 * adapter never opens a file outside its containment and its snapshot.
 */

/** Repo-relative (POSIX) path of the manifest; callers read it from their own root. */
export const POSTGRES_IMAGE_MANIFEST_PATH = '.github/manifests/postgres-image.json';

/** Files whose postgres-family image references the manifest governs. */
export const POSTGRES_IMAGE_SCOPE_GLOBS = [
  '.github/workflows/*.yml',
  'docker-compose*.yml',
] as const;

/**
 * The words that make an image reference postgres-family (base, production derivative or any
 * other postgres image), as the spec's reference scan reads `image:` lines.
 */
export const POSTGRES_FAMILY_WORDS = ['timescaledb', 'postgres', 'pgvector'] as const;

export interface PostgresImageManifest {
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

/** The manifest, parsed from its text and shape-checked; a malformed manifest throws. */
export function parsePostgresImageManifest(text: string): PostgresImageManifest {
  const parsed: unknown = JSON.parse(text);
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

/**
 * The image a consumer file must reference: the production derivative for a
 * `production_consumers` entry, the pinned upstream base for every other consumer. The droplet's
 * fail-closed `${TAG:?TAG required}` spelling is the manifest's own `production_image` string,
 * compared exactly.
 */
export function expectedPostgresImageFor(
  manifest: PostgresImageManifest,
  consumerFile: string,
): string {
  return manifest.productionConsumers.includes(consumerFile)
    ? manifest.productionImage
    : manifest.image;
}

/** Whether an image reference is postgres-family, and so governed where the manifest reaches. */
export function isPostgresFamilyImage(image: string): boolean {
  return POSTGRES_FAMILY_WORDS.some((word) => image.includes(word));
}
