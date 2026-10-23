/**
 * INVARIANT: no tracked `.github/workflows` tree below the repository root
 * (INFRA-MEDIUM-256).
 *
 * GitHub reads workflows only from the repository root's `.github/workflows`.
 * A workflow file anywhere else is dead: it never runs, and nothing says so.
 * `e2e/.github/workflows/e2e-tests.yml` was the only caller of the e2e security,
 * workflow and integration suites and sat in exactly that state after the root
 * copy was removed (ARIA-HIGH-334); `sens-api-gateway/.github` was the same
 * shape (INFRA-HIGH-237). Both are the defect `test-target-ci-reachability`
 * exists for — a gate green because it never runs — and neither reachability
 * direction can see it, because the file is not a project target or a script.
 *
 * What is checked: every tracked file whose path contains `.github/workflows/`
 * below anything other than the root must be explained in
 * NESTED_WORKFLOW_ALLOWLIST (fixture data some check reads, not a workflow
 * anything means to run), and every allowlist entry must still hold one, so the
 * list cannot outlive its reason. The detector has its own cases, so the scan
 * over the real tree cannot pass because the detector went blind.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Trees below the root that hold a `.github/workflows` directory GitHub does
 * not run, each with the reason it is not a coverage gap. Keyed by directory
 * prefix.
 */
const NESTED_WORKFLOW_ALLOWLIST: Readonly<Record<string, string>> = {
  'tools/aria-adapters/fixtures/':
    'inert fixture data of the workflow-shell-safety adapter: the adapter reads these files as ' +
    'input to its checks and nothing is meant to run them',
};

/** Tracked files that sit in a `.github/workflows` directory other than the root's. */
function nestedWorkflowFiles(tracked: readonly string[]): string[] {
  return tracked.filter(
    (file) => /(^|\/)\.github\/workflows\//.test(file) && !file.startsWith('.github/workflows/'),
  );
}

/** The nested workflow files nothing explains: not under an allowlisted prefix. */
function unexplainedNestedWorkflows(tracked: readonly string[]): string[] {
  return nestedWorkflowFiles(tracked).filter(
    (file) => !Object.keys(NESTED_WORKFLOW_ALLOWLIST).some((prefix) => file.startsWith(prefix)),
  );
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file !== '');
}

describe('INVARIANT: no workflow below the repository root', () => {
  it('flags a workflow tree below the root, whatever the directory, and spares the root', () => {
    const flagged = nestedWorkflowFiles([
      '.github/workflows/ci-full.yml',
      'e2e/.github/workflows/e2e-tests.yml',
      'apps/farm-service/.github/workflows/ci.yml',
      'sens-api-gateway/.github/workflows/release.yml',
      'docs/github-workflows-notes.md',
      'e2e/tests/github/workflows/not-a-workflow.yml',
      '.github/manifests/workflow-roles.json',
    ]);
    expect(flagged).toEqual([
      'e2e/.github/workflows/e2e-tests.yml',
      'apps/farm-service/.github/workflows/ci.yml',
      'sens-api-gateway/.github/workflows/release.yml',
    ]);
  });

  it('finds the tracked files at all (the scan cannot silently return nothing)', () => {
    const tracked = trackedFiles();
    expect(tracked.length).toBeGreaterThan(1000);
    expect(tracked.some((file) => file.startsWith('.github/workflows/'))).toBe(true);
  });

  it('explains a nested workflow only by an allowlisted prefix', () => {
    const [prefix] = Object.keys(NESTED_WORKFLOW_ALLOWLIST);
    expect(prefix).toBeDefined();
    expect(
      unexplainedNestedWorkflows([
        `${prefix}some-adapter/.github/workflows/unsafe.yml`,
        'e2e/.github/workflows/e2e-tests.yml',
        `elsewhere/${prefix}x/.github/workflows/y.yml`,
      ]),
    ).toEqual([
      'e2e/.github/workflows/e2e-tests.yml',
      `elsewhere/${prefix}x/.github/workflows/y.yml`,
    ]);
  });

  it('keeps no workflow below the repository root: GitHub runs only the root .github/workflows', () => {
    expect(unexplainedNestedWorkflows(trackedFiles())).toEqual([]);
  });

  it('keeps the allowlist honest: every prefix still holds a nested workflow file', () => {
    const nested = nestedWorkflowFiles(trackedFiles());
    for (const [prefix, reason] of Object.entries(NESTED_WORKFLOW_ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(0);
      expect({ prefix, held: nested.some((file) => file.startsWith(prefix)) }).toEqual({
        prefix,
        held: true,
      });
    }
  });
});
