/**
 * ARIA-HIGH-497 — environment files are ignored by default, templates by exception.
 *
 * `.gitignore` used to list env file NAMES (`.env`, `.env.local`,
 * `.env.production`, ...). A name list only covers the names someone thought
 * of: an operator backup such as `.env.bak-20260920-frontend-url`, or a new
 * stage file like `.env.staging`, matched none of them and sat one `git add`
 * away from committing live secrets. The rule is now deny-by-default
 * (`.env`, `.env.*`, `*.env`) with the committed templates re-included
 * (`!.env.example`, `!.env.*.example`).
 *
 * `--no-index` is required: without it git never reports a tracked path as
 * ignored, so the template check would pass whatever the rules said.
 */
import { execFileSync } from 'node:child_process';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function ignored(relPath: string): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '--no-index', '-q', '--', relPath], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe('ARIA-HIGH-497 — env files are ignored by default', () => {
  it('ignores secret-bearing env files whatever their suffix', () => {
    const secretBearing = [
      '.env',
      '.env.bak-20260920-frontend-url',
      '.env.production',
      '.env.staging',
      'apps/auth-service/.env.local',
      'infrastructure/docker/droplet.env',
    ];
    expect(secretBearing.filter((relPath) => !ignored(relPath))).toEqual([]);
  });

  it('keeps every tracked env template visible to git', () => {
    const templates = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((relPath) => /(^|\/)\.env/.test(relPath));
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.filter((relPath) => ignored(relPath))).toEqual([]);
  });
});
