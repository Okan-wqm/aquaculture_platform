import { isContractSemver } from './edge-contract';
import type { OsBundle, UpdateTerms } from './edge-update-manifest.service';

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

export type UpdateRecipe = EdgeUpdateRecipe | OsUpdateRecipe;

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

/** The recipe a stored value is, or null when it is not one the cloud wrote. */
export function parseRecipe(value: unknown): UpdateRecipe | null {
  if (!isRecord(value)) return null;
  const terms = parseTerms(value['terms']);
  const windowSeconds = value['windowSeconds'];
  if (terms === null || typeof windowSeconds !== 'number' || !Number.isInteger(windowSeconds)) {
    return null;
  }
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
