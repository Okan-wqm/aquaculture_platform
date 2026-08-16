/**
 * Dead-contract scan — shared logic for the FE GraphQL operation ratchet.
 *
 * A frontend GraphQL operation is "defined" as an exported UPPER_SNAKE const
 * whose template-literal body declares a `mutation|query|subscription Name`.
 * It is "wired" when its identifier is referenced anywhere under web/** beyond
 * its own definition (a call site, a re-export, a test, the offline-queue
 * MUTATIONS map, …). An operation that is defined but never referenced is a
 * DEAD CONTRACT: shipped to the bundle, reachable by nothing — exactly the
 * Wave-6 M2 failure mode (`MARK_MESSAGES_READ` existed but no code invoked it,
 * so mobile read state never advanced).
 *
 * This module is the SINGLE source of the scan so the baseline generator and
 * the invariant spec can never drift apart.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { listEffectiveWorktreeFiles } from './effective-worktree-files';

export type OperationKind = 'mutation' | 'query' | 'subscription';

export interface OperationConst {
  /** The exported UPPER_SNAKE identifier (e.g. MARK_MESSAGES_READ). */
  id: string;
  /** Repo-relative path of the file that defines it. */
  file: string;
  /** The GraphQL operation kind declared in the template body. */
  kind: OperationKind;
}

/** `export const FOO = gql`…`` / `export const FOO = `…`` definitions. */
const DEF_RE = /export\s+const\s+([A-Z][A-Z0-9_]+)\s*=\s*(?:gql\s*)?`([^`]*)`/g;
/** First operation keyword inside the template body. */
const OP_RE = /\b(mutation|query|subscription)\s+[A-Za-z0-9_]+/;
/** UPPER_SNAKE token (≥2 chars) for the reference-frequency pass. */
const TOKEN_RE = /\b[A-Z][A-Z0-9_]{1,}\b/g;

function listWebFiles(repoRoot: string): string[] {
  return listEffectiveWorktreeFiles(repoRoot, ['web/']).filter((file) => /\.(ts|tsx)$/.test(file));
}

const isSpec = (f: string): boolean => /\.(spec|test)\.tsx?$/.test(f);

/**
 * Scan web/** and return every defined operation const that has ZERO
 * references beyond its own definition (i.e. dead contracts), sorted
 * deterministically by id.
 *
 * Reference counting is a single token-frequency pass over ALL web files
 * (definition files + specs): a const referenced anywhere — call site,
 * re-export, or test — is considered wired. Definitions are only collected
 * from non-spec files (a fixture-only operation is not a product contract).
 */
export function scanDeadContracts(repoRoot: string): OperationConst[] {
  const files = listWebFiles(repoRoot);
  const sources = new Map<string, string>();
  for (const f of files) sources.set(f, readFileSync(join(repoRoot, f), 'utf8'));

  // 1. Collect operation-const definitions from non-spec files.
  const defs = new Map<string, OperationConst>();
  for (const f of files) {
    if (isSpec(f)) continue;
    const src = sources.get(f)!;
    DEF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEF_RE.exec(src)) !== null) {
      const id = m[1]!;
      const op = OP_RE.exec(m[2]!);
      if (op) defs.set(id, { id, file: f, kind: op[1] as OperationKind });
    }
  }

  // 2. Single-pass UPPER_SNAKE token frequency across ALL web files.
  const freq = new Map<string, number>();
  for (const src of sources.values()) {
    const tokens = src.match(TOKEN_RE);
    if (!tokens) continue;
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  // 3. A const with exactly one occurrence (its own definition) is dead.
  const dead: OperationConst[] = [];
  for (const def of defs.values()) {
    if ((freq.get(def.id) ?? 0) <= 1) dead.push(def);
  }
  dead.sort((a, b) => a.id.localeCompare(b.id));
  return dead;
}

/** Stable key for baseline set membership. */
export function deadContractKey(o: OperationConst): string {
  return `${o.id}\t${o.file}`;
}
