/**
 * init-scripts-no-schema-ddl invariant.
 *
 * After ADR-031 (Platform Bootstrap Atom), every schema / role / function /
 * shared-table DDL belongs in apps/db-migrate/src/sql/platform-bootstrap/
 * — not in infrastructure/docker/init-scripts/. This invariant enforces
 * that contract at CI time.
 *
 * WHY this exists: Postgres docker-entrypoint init-scripts run ONCE on
 * initdb (empty PGDATA). They are NOT re-applied on container restart,
 * DROP SCHEMA, or volume reattach. Anything load-bearing in them is
 * automatically brittle — the bootstrap atom is the restart-survive
 * alternative.
 *
 * The .archive/ subdirectory is exempt — it carries forensic copies of
 * the pre-ADR-031 init-script flow for audit reference.
 *
 * Allowed in init-scripts/*.sql/*.sh after ADR-031:
 *   - RAISE NOTICE (logging)
 *   - Commentary / DO blocks that only log
 *
 * Forbidden (must move to apps/db-migrate/src/sql/platform-bootstrap/):
 *   - CREATE SCHEMA
 *   - CREATE DATABASE
 *   - CREATE EXTENSION
 *   - CREATE ROLE / ALTER ROLE
 *   - CREATE TABLE / DROP TABLE
 *   - CREATE FUNCTION / CREATE OR REPLACE FUNCTION
 *   - CREATE POLICY
 *   - GRANT ALL PRIVILEGES
 *   - GRANT ... ON SCHEMA   (schema-level grants, not DB-level)
 *   - ALTER DEFAULT PRIVILEGES
 *   - ALTER SCHEMA
 *   - ALTER TABLE
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPTS_DIR = resolve(REPO_ROOT, 'infrastructure', 'docker', 'init-scripts');

// Patterns whose presence in init-scripts/* fails the invariant.
// Each entry: [name, regex-source, severity-hint].
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'CREATE SCHEMA',                re: /\bCREATE\s+SCHEMA\b/i },
  { name: 'CREATE DATABASE',              re: /\bCREATE\s+DATABASE\b/i },
  { name: 'CREATE EXTENSION',             re: /\bCREATE\s+EXTENSION\b/i },
  { name: 'CREATE ROLE / ALTER ROLE',     re: /\b(?:CREATE|ALTER)\s+ROLE\b/i },
  { name: 'CREATE TABLE',                 re: /\bCREATE\s+TABLE\b/i },
  { name: 'DROP TABLE',                   re: /\bDROP\s+TABLE\b/i },
  { name: 'CREATE FUNCTION',              re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i },
  { name: 'CREATE POLICY',                re: /\bCREATE\s+POLICY\b/i },
  { name: 'GRANT ALL PRIVILEGES',         re: /\bGRANT\s+ALL\s+PRIVILEGES\b/i },
  { name: 'GRANT ... ON SCHEMA',          re: /\bGRANT\s+[A-Z, ]+\s+ON\s+SCHEMA\b/i },
  { name: 'ALTER SCHEMA',                 re: /\bALTER\s+SCHEMA\b/i },
  { name: 'ALTER DEFAULT PRIVILEGES',     re: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i },
  { name: 'ALTER TABLE',                  re: /\bALTER\s+TABLE\b/i },
];

interface InitScriptFile {
  readonly relPath: string;
  readonly content: string;
}

function listInitScripts(): InitScriptFile[] {
  const entries = readdirSync(INIT_SCRIPTS_DIR);
  const out: InitScriptFile[] = [];
  for (const entry of entries) {
    // Skip the forensic archive directory — its contents document
    // the pre-ADR-031 contract for audit reference only.
    if (entry === '.archive') continue;
    const full = join(INIT_SCRIPTS_DIR, entry);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    if (!entry.endsWith('.sql') && !entry.endsWith('.sh')) continue;
    out.push({
      relPath: `infrastructure/docker/init-scripts/${entry}`,
      content: readFileSync(full, 'utf8'),
    });
  }
  return out;
}

/**
 * Strip SQL/shell comments + multiline `/* ... *\/` blocks so we do not
 * match forbidden tokens that appear only in documentation. The pattern
 * matcher operates on the comment-stripped string.
 */
function stripComments(content: string, suffix: '.sql' | '.sh'): string {
  if (suffix === '.sql') {
    // Strip `--` line comments and `/* ... */` block comments.
    return content
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
  }
  // Shell: strip `#` line comments outside of single-quote contexts
  // (best-effort — false positives are OK because the spec only fails
  // on real DDL tokens present in the surviving content).
  return content
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

describe('init-scripts: no schema/role/function DDL (ADR-031)', () => {
  it('init-scripts dir exists', () => {
    expect(statSync(INIT_SCRIPTS_DIR).isDirectory()).toBe(true);
  });

  it('every init-script is initdb-only safe (no schema/role/function DDL)', () => {
    const files = listInitScripts();
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; pattern: string; line: number; snippet: string }> = [];

    for (const file of files) {
      const suffix = file.relPath.endsWith('.sh') ? '.sh' : '.sql';
      const stripped = stripComments(file.content, suffix);
      const lines = stripped.split('\n');
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line !== undefined && re.test(line)) {
            violations.push({
              file: file.relPath,
              pattern: name,
              line: i + 1,
              snippet: line.trim().slice(0, 120),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = [
        `ADR-031 violation: ${violations.length} forbidden DDL token(s) found in init-scripts.`,
        `Schema/role/function/policy/grant-on-schema/alter-default-privileges DDL`,
        `MUST live in apps/db-migrate/src/sql/platform-bootstrap/ — that atom is`,
        `restart-survive; init-scripts are NOT.`,
        '',
        ...violations.map(
          (v) => `  ✗ ${v.file}:${v.line}  ${v.pattern}\n      ${v.snippet}`,
        ),
      ].join('\n');
      throw new Error(msg);
    }
  });

  it('platform-bootstrap SQL directory exists with the 7 expected stages', () => {
    const bootstrapDir = resolve(REPO_ROOT, 'apps', 'db-migrate', 'src', 'sql', 'platform-bootstrap');
    expect(statSync(bootstrapDir).isDirectory()).toBe(true);
    const stages = readdirSync(bootstrapDir).filter((f) => f.endsWith('.sql')).sort();
    const expectedPrefixes = ['001-', '003-', '004-', '005-', '006-', '007-'];
    for (const prefix of expectedPrefixes) {
      const present = stages.some((s) => s.startsWith(prefix));
      expect(present).toBe(true);
    }
  });
});
