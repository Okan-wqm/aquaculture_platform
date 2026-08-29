import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';

export const FINDING_REGISTRY_RELATIVE_PATH = join(
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl',
);
export const FINDING_REGISTRY_SCHEMA_RELATIVE_PATH = `${FINDING_REGISTRY_RELATIVE_PATH}.schema.json`;
export const FINDING_RESERVATION_BASENAME = 'finding-id-reservations-v1.json';
export const SOURCE_FINDING_PLAN_RELATIVE_PATH = join(
  'docs',
  'plans',
  '2026-06-18-enterprise-grade-debt-closure',
);
export const SOURCE_FINDING_MANIFEST_BASENAME = 'manifest.json';
export const SOURCE_FINDING_LEGACY_ARTIFACT_BASENAME = 'source-findings.jsonl';
export const SOURCE_FINDING_ARTIFACT_BASENAME = /^source-findings\.(?<sha256>[0-9a-f]{64})\.jsonl$/;

export type FindingAuthorityTarget =
  | { readonly kind: 'REGISTRY'; readonly path: string }
  | { readonly kind: 'RESERVATION'; readonly path: string }
  | { readonly kind: 'SOURCE_MANIFEST'; readonly path: string }
  | { readonly kind: 'SOURCE_LEGACY_ARTIFACT'; readonly path: string }
  | { readonly kind: 'SOURCE_ARTIFACT'; readonly path: string; readonly contentId: string };

export const FINDING_AUTHORITY_TRANSACTION_MAX_BYTES = 128 * 1024 * 1024;

export function findingAuthorityTargetMaxBytes(target: FindingAuthorityTarget): number {
  switch (target.kind) {
    case 'RESERVATION':
      return 4 * 1024 * 1024;
    case 'SOURCE_MANIFEST':
      return 16 * 1024 * 1024;
    case 'REGISTRY':
    case 'SOURCE_LEGACY_ARTIFACT':
    case 'SOURCE_ARTIFACT':
      return 64 * 1024 * 1024;
  }
}

function hasPathSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`${sep}${suffix}`);
}

/**
 * Resolve one mutation coordinate without following aliases. All write APIs use this resolver,
 * so the governed-target catalog and the actual rename destination cannot observe different
 * filesystem identities.
 */
export function canonicalFindingMutationPath(filePath: string): string {
  if (!isAbsolute(filePath) || normalize(filePath) !== filePath) {
    throw new Error(`Finding mutation target must be one normalized absolute path: ${filePath}`);
  }
  const absolutePath = resolve(filePath);
  const root = parse(absolutePath).root;
  const relativeSegments = absolutePath.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (const [index, segment] of relativeSegments.entries()) {
    cursor = join(cursor, segment);
    const isTarget = index === relativeSegments.length - 1;
    if (isTarget && !existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Finding mutation target contains a symbolic-link alias: ${filePath}`);
    }
    if (!isTarget && !stat.isDirectory()) {
      throw new Error(`Finding mutation target parent is not a directory: ${cursor}`);
    }
    if (isTarget && !stat.isFile()) {
      throw new Error(`Finding mutation target is not a regular file: ${filePath}`);
    }
  }
  const parent = dirname(absolutePath);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`Finding mutation target parent is not a real directory: ${parent}`);
  }
  return absolutePath;
}

export function classifyFindingAuthorityTarget(filePath: string): FindingAuthorityTarget | null {
  const path = canonicalFindingMutationPath(filePath);
  if (hasPathSuffix(path, FINDING_REGISTRY_RELATIVE_PATH)) return { kind: 'REGISTRY', path };
  if (basename(path) === FINDING_RESERVATION_BASENAME) return { kind: 'RESERVATION', path };

  const planMarker = `${sep}${SOURCE_FINDING_PLAN_RELATIVE_PATH}${sep}`;
  if (!path.includes(planMarker)) return null;
  const name = basename(path);
  if (name === SOURCE_FINDING_MANIFEST_BASENAME) return { kind: 'SOURCE_MANIFEST', path };
  if (name === SOURCE_FINDING_LEGACY_ARTIFACT_BASENAME) {
    return { kind: 'SOURCE_LEGACY_ARTIFACT', path };
  }
  const artifact = SOURCE_FINDING_ARTIFACT_BASENAME.exec(name);
  const contentId = artifact?.groups?.sha256;
  return contentId === undefined ? null : { kind: 'SOURCE_ARTIFACT', path, contentId };
}
