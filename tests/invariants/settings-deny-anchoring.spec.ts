/**
 * Settings Deny Anchoring Invariant
 * ============================================================================
 *
 * Closes the 2026-09-16 security pre-flight finding (F0-G): the permission
 * deny-list used `./`-relative paths, which every git worktree resolves
 * against ITS OWN root — a session opened inside .claude/worktrees/wf_*
 * could read the live repository-root `.env` and `.claude/settings.local.json`
 * (which, at the time of the finding, was git-TRACKED and carried 90 live
 * admin bearer JWTs in a PUBLIC repository).
 *
 * Asserts:
 *   1. .claude/settings.json parses and its deny list contains:
 *      - `//`-anchored .env denies (project-root anchored),
 *      - `**`-glob .env denies (any-depth, worktree-local copies),
 *      - a read-deny on .claude/settings.local.json (both anchored forms).
 *   2. .claude/settings.local.json is NOT tracked by git (the 90-JWT class
 *      must never re-enter the index silently).
 *   3. .gitignore lists .claude/settings.local.json (belt to (2)'s braces).
 *
 * A settings PR that relaxes any of these fails CI here.
 */

import { execSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');
const LOCAL_SETTINGS_REL = '.claude/settings.local.json';

const REQUIRED_DENIES = [
  'Read(//.env)',
  'Read(//.env.*)',
  'Read(**/.env)',
  'Read(**/.env.*)',
  'Read(//.claude/settings.local.json)',
  'Read(**/.claude/settings.local.json)',
];

function trackedFiles(): Set<string> {
  const out = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' });
  return new Set(out.split('\n').filter(Boolean));
}

describe('settings deny anchoring (F0-G)', () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as {
    permissions?: { deny?: unknown[] };
  };
  const deny = (settings.permissions?.deny ?? []) as unknown[];

  it('parses .claude/settings.json with a deny list', () => {
    expect(Array.isArray(deny)).toBe(true);
    expect(deny.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_DENIES)('denies %s (root-anchored and globbed)', (rule) => {
    expect(deny).toContain(rule);
  });

  it('never tracks .claude/settings.local.json (the 90-JWT class)', () => {
    expect(trackedFiles().has(LOCAL_SETTINGS_REL)).toBe(false);
  });

  it('gitignores .claude/settings.local.json', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain(LOCAL_SETTINGS_REL);
  });
});
