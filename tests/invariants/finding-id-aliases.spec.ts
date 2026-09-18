/**
 * INVARIANT: the finding-id alias sidecar cannot become an exemption list.
 *
 * `docs/reviews/_registry/finding-id-aliases.yaml` exists for one situation: a
 * merged commit's `Closes:` trailer names a finding id the ledger records under
 * a different id, and the trailer cannot be amended because rewriting published
 * history is forbidden. The sidecar maps the historical id onto the ledger id so
 * every gate resolves it the same way.
 *
 * That mechanism is only safe while each of these holds, so each is a test:
 *
 *  1. every alias resolves to an id that really exists in the ledger — an alias
 *     pointing nowhere would silently admit an unknown id;
 *  2. no alias shadows a real ledger id — otherwise a live finding could be
 *     redirected to a different row;
 *  3. no id is aliased twice, and no alias equals its own canonical;
 *  4. every alias carries the evidence a reader needs to audit it: the review
 *     file whose heading raises it, at least one merged commit that names it,
 *     an effective date and a reason;
 *  5. the review file exists and actually carries a heading for the alias id —
 *     the anchor a reader following the trailer lands on.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  loadFindingIdAliases,
  findingIdAliasesPath,
  type FindingIdAlias,
} from '../../tools/gates/finding-id-aliases';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

function ledgerIds(): Set<string> {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8').trim();
  const ids = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line) as { id?: unknown };
    if (typeof entry.id === 'string') ids.add(entry.id);
  }
  return ids;
}

function commitExists(sha: string): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', `${sha}^{commit}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe('INVARIANT: finding-id alias sidecar', () => {
  const aliases: readonly FindingIdAlias[] = loadFindingIdAliases(REPO_ROOT);
  const ids = ledgerIds();

  it('the sidecar parses (or is absent, which aliases nothing)', () => {
    const file = findingIdAliasesPath(REPO_ROOT);
    if (!fs.existsSync(file)) {
      expect(aliases).toEqual([]);
      return;
    }
    expect(Array.isArray(aliases)).toBe(true);
  });

  it('every alias resolves to an id that exists in the ledger', () => {
    const dangling = aliases
      .filter((entry) => !ids.has(entry.canonical))
      .map((entry) => `${entry.alias} -> ${entry.canonical}`);
    expect(dangling).toEqual([]);
  });

  it('no alias shadows a real ledger id', () => {
    const shadowing = aliases.filter((entry) => ids.has(entry.alias)).map((entry) => entry.alias);
    expect(shadowing).toEqual([]);
  });

  it('each historical id is aliased at most once, and never to itself', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    const selfReferencing: string[] = [];
    for (const entry of aliases) {
      if (seen.has(entry.alias)) duplicates.push(entry.alias);
      seen.add(entry.alias);
      if (entry.alias === entry.canonical) selfReferencing.push(entry.alias);
    }
    expect(duplicates).toEqual([]);
    expect(selfReferencing).toEqual([]);
  });

  it('every alias carries its audit evidence', () => {
    const incomplete = aliases
      .filter(
        (entry) =>
          !entry.review_file ||
          !entry.effective_date ||
          !entry.reason?.trim() ||
          (entry.commits ?? []).length === 0,
      )
      .map((entry) => entry.alias);
    expect(incomplete).toEqual([]);
  });

  it('every named commit is a real commit in this repository', () => {
    const unknown: string[] = [];
    for (const entry of aliases) {
      for (const sha of entry.commits ?? []) {
        if (!commitExists(sha)) unknown.push(`${entry.alias}: ${sha}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('the review file exists and carries a heading for the alias id', () => {
    const missing: string[] = [];
    for (const entry of aliases) {
      const file = path.join(REPO_ROOT, entry.review_file);
      if (!fs.existsSync(file)) {
        missing.push(`${entry.alias}: ${entry.review_file} does not exist`);
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      const heading = new RegExp(`^#{2,4}\\s+.*\\b${entry.alias}\\b`, 'm');
      const bullet = new RegExp(`^\\s*[-*]\\s+\\*\\*${entry.alias}\\*\\*`, 'm');
      if (!heading.test(text) && !bullet.test(text)) {
        missing.push(`${entry.alias}: no heading or bullet in ${entry.review_file}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
