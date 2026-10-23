import { isContractSemver, SITE_PATHS, type SitePath } from './edge-contract';
import type { OsBundle, UpdateTerms } from './edge-update-manifest.service';
import { isNetpolicyBody, type NetpolicyBody } from './site-netpolicy-manifest.service';

/**
 * What re-issues an update request: the intent's parameters, never a statement
 * (ADR-048 DEC-2.12). A refused request is issued again as a NEW statement (a
 * verified statement spends its sequence value), so the row keeps what is needed to
 * sign the next one — which release or bundle, under which terms, for how long a
 * window — and nothing that was signed.
 *
 * A recipe is stored as JSON and read back by the reconciler, so the read goes
 * through {@link parseRecipe}: a value that is not one the cloud wrote is refused
 * there, not trusted into a signature.
 */

/** What re-issues an edge-update. */
export interface EdgeUpdateRecipe {
  readonly kind: 'edge-update';
  readonly version: string;
  readonly terms: UpdateTerms;
  readonly windowSeconds: number;
}

/** What re-issues an os-update. */
export interface OsUpdateRecipe {
  readonly kind: 'os-update';
  readonly bundle: OsBundle;
  readonly terms: UpdateTerms;
  readonly windowSeconds: number;
}

/**
 * What re-issues a site-config: the operator's extra site files (config.yaml is the
 * cloud's own, rendered afresh with every statement), by site path, as base64.
 */
export interface SiteConfigRecipe {
  readonly kind: 'site-config';
  readonly files: Readonly<Record<string, string>>;
  readonly windowSeconds: number;
}

/** What re-issues a site-netpolicy: the policy, in the contract's own form. */
export interface SiteNetpolicyRecipe {
  readonly kind: 'site-netpolicy';
  readonly policy: NetpolicyBody;
  readonly windowSeconds: number;
}

/**
 * What re-issues a trust-anchors push: the digest of the bundle two people approved
 * (the push is that bundle or nothing: the cloud refuses to sign off a different one) and
 * how long the cloud keeps delivering it, its own bound, since the statement has no
 * window.
 */
export interface TrustAnchorsRecipe {
  readonly kind: 'trust-anchors';
  readonly bundleDigest: string;
  readonly windowSeconds: number;
}

export type UpdateRecipe =
  | EdgeUpdateRecipe
  | OsUpdateRecipe
  | SiteConfigRecipe
  | SiteNetpolicyRecipe
  | TrustAnchorsRecipe;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTerms(value: unknown): UpdateTerms | null {
  if (!isRecord(value)) return null;
  const { localApproval, blockersOverride, maxOutageSeconds } = value;
  if (
    typeof localApproval !== 'boolean' ||
    typeof blockersOverride !== 'boolean' ||
    typeof maxOutageSeconds !== 'number' ||
    !Number.isInteger(maxOutageSeconds)
  ) {
    return null;
  }
  return { localApproval, blockersOverride, maxOutageSeconds };
}

function parseBundle(value: unknown): OsBundle | null {
  if (!isRecord(value)) return null;
  const { version, rollbackFloor, minCurrentVersion, supportedAgentAbi, url, sha256, sizeBytes } =
    value;
  if (
    typeof version !== 'string' ||
    typeof rollbackFloor !== 'string' ||
    typeof minCurrentVersion !== 'string' ||
    typeof supportedAgentAbi !== 'string' ||
    typeof url !== 'string' ||
    typeof sha256 !== 'string' ||
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes)
  ) {
    return null;
  }
  return { version, rollbackFloor, minCurrentVersion, supportedAgentAbi, url, sha256, sizeBytes };
}

function parseSiteFiles(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(value)) {
    if (!SITE_PATHS.some((known) => known === path) || typeof content !== 'string') return null;
    files[path] = content;
  }
  return files;
}

function parsePolicy(value: unknown): NetpolicyBody | null {
  return isNetpolicyBody(value) ? value : null;
}

/** The recipe a stored value is, or null when it is not one the cloud wrote. */
export function parseRecipe(value: unknown): UpdateRecipe | null {
  if (!isRecord(value)) return null;
  const windowSeconds = value['windowSeconds'];
  if (typeof windowSeconds !== 'number' || !Number.isInteger(windowSeconds)) return null;
  if (value['kind'] === 'trust-anchors') {
    const bundleDigest = value['bundleDigest'];
    return typeof bundleDigest === 'string' && /^[0-9a-f]{64}$/.test(bundleDigest)
      ? { kind: 'trust-anchors', bundleDigest, windowSeconds }
      : null;
  }
  if (value['kind'] === 'site-config') {
    const files = parseSiteFiles(value['files']);
    return files === null ? null : { kind: 'site-config', files, windowSeconds };
  }
  if (value['kind'] === 'site-netpolicy') {
    const policy = parsePolicy(value['policy']);
    return policy === null ? null : { kind: 'site-netpolicy', policy, windowSeconds };
  }
  const terms = parseTerms(value['terms']);
  if (terms === null) return null;
  if (value['kind'] === 'edge-update') {
    const version = value['version'];
    return typeof version === 'string' && isContractSemver(version)
      ? { kind: 'edge-update', version, terms, windowSeconds }
      : null;
  }
  if (value['kind'] === 'os-update') {
    const bundle = parseBundle(value['bundle']);
    return bundle === null ? null : { kind: 'os-update', bundle, terms, windowSeconds };
  }
  return null;
}

/** The operator's extra site files of a site-config recipe, decoded; a path the recipe holds is always a site path (see {@link parseRecipe}). */
export function siteFilesOf(recipe: SiteConfigRecipe): Map<SitePath, Buffer> {
  const files = new Map<SitePath, Buffer>();
  for (const path of SITE_PATHS) {
    const content = recipe.files[path];
    if (content !== undefined) files.set(path, Buffer.from(content, 'base64'));
  }
  return files;
}
