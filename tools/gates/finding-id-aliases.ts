import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as YAML from 'yaml';

/**
 * Historical finding-ID aliases.
 *
 * ## Why this exists
 *
 * A `Closes:` trailer is immutable once its commit is merged: amending it means
 * rewriting published history, which the force-push ban forbids. So when a
 * branch is integrated under DIFFERENT finding ids than the ones its commits
 * name — a branch that numbered its findings locally (`PR935-HIGH-001`) before
 * the integrator registered them in the ledger under the domain prefix the
 * registry schema admits (`EDGE-*`) — the trailer and the ledger disagree
 * forever, and every id-resolving gate fails on history nobody can change.
 *
 * The registry cannot absorb the branch-local ids either: `findings.jsonl.schema.json`
 * pins the id prefix to a closed domain alternation, deliberately, so a PR
 * number cannot become a finding domain.
 *
 * This sidecar records the mapping instead. It is machine-readable, reviewed
 * like any other file, and consumed by EVERY id-resolving path (the commit-msg
 * validator, the close ceremony, the closure derivation) so they cannot
 * disagree about what an alias means.
 *
 * ## What it is NOT
 *
 * Not an exemption list. An alias resolves ONLY to a canonical id that exists in
 * the ledger; an alias pointing nowhere is a hard failure of
 * `tests/invariants/finding-id-aliases.spec.ts`, and an id with no alias and no
 * ledger row still fails the gate exactly as before.
 */
export interface FindingIdAlias {
  /** The id a merged commit's trailer names. Never present in the ledger. */
  readonly alias: string;
  /** The ledger id that tracks the same finding. MUST exist in findings.jsonl. */
  readonly canonical: string;
  /** The review file whose heading carries the alias id. */
  readonly review_file: string;
  /** Short SHAs of the merged commits whose trailers name the alias. */
  readonly commits: readonly string[];
  /** ISO date the alias was recorded. */
  readonly effective_date: string;
  /** Why the ids diverged — one sentence, auditable. */
  readonly reason: string;
}

interface AliasSidecar {
  readonly version: number;
  readonly aliases?: readonly FindingIdAlias[];
}

export const FINDING_ID_ALIASES_RELATIVE_PATH = 'docs/reviews/_registry/finding-id-aliases.yaml';

export function findingIdAliasesPath(repoRoot: string): string {
  return resolve(repoRoot, FINDING_ID_ALIASES_RELATIVE_PATH);
}

/** Every recorded alias, or an empty list when the sidecar does not exist. */
export function loadFindingIdAliases(repoRoot: string): readonly FindingIdAlias[] {
  const path = findingIdAliasesPath(repoRoot);
  if (!existsSync(path)) return [];
  const parsed = YAML.parse(readFileSync(path, 'utf8')) as AliasSidecar | null;
  return parsed?.aliases ?? [];
}

/** alias id → canonical ledger id. */
export function loadFindingIdAliasMap(repoRoot: string): ReadonlyMap<string, string> {
  return new Map(loadFindingIdAliases(repoRoot).map((entry) => [entry.alias, entry.canonical]));
}

/** canonical ledger id → every alias that resolves to it. */
export function loadCanonicalToAliases(repoRoot: string): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const entry of loadFindingIdAliases(repoRoot)) {
    const list = out.get(entry.canonical) ?? [];
    list.push(entry.alias);
    out.set(entry.canonical, list);
  }
  return out;
}
