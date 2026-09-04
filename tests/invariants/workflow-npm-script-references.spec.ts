/**
 * Every `npm run <script>` a workflow invokes must exist somewhere.
 *
 * WHY THIS EXISTS: a workflow step calling `npm run gates:finding-registry:test`
 * was added in the same change as the script it calls. A later, unrelated revert
 * of `package.json` — reverting dependency edits — took the script with it and
 * left the step behind. The job died with `npm error Missing script`, and nothing
 * caught it before push: the script's own test passed, type-check passed, the
 * gate it guarded passed. The break lived in the seam between two files that no
 * check read together.
 *
 * That seam is generic. Any narrow revert, rename, or script cleanup can orphan a
 * workflow reference, and the failure always surfaces as a red CI job with a
 * message that reads like tooling trouble rather than a missing declaration.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not resolve working directories.
 * Workflows legitimately invoke scripts from other package.json files — via
 * `--workspace`, via `--prefix`, or by `cd`-ing inside a shell block or an SSH
 * heredoc — and statically resolving which manifest applies would need a shell
 * interpreter. So the assertion is the weaker, still-useful one: the script name
 * must exist in SOME package.json in the repository. A name that exists nowhere
 * cannot be correct under any working directory, and that is exactly the class of
 * defect this was written after.
 *
 * NX TARGETS ARE THE SAME SEAM (2026-09-04, INFRA-HIGH-141). A workflow step
 * that fans out over an Nx target (`affected-target-policy.sh --target X`,
 * `nx affected -t X`, `nx run-many --target=X`, `nx run <project>:<target>`)
 * references a declaration that lives in some project.json or package.json —
 * or in none. `ci-affected.yml` carried `--target test:invariant` and
 * `-t type-check` for months; no project declared either, Nx resolved each to
 * an empty set, and the steps were green without running anything. The target
 * references below are resolved through the project graph itself
 * (helpers/nx.ts), because a static scan would re-implement Nx's inference.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { nxProjectDetail, nxProjects, nxProjectsWithTarget } from './helpers/nx';
import {
  NX_RUN,
  NX_TARGET_FLAG,
  REPO_ROOT,
  declaredScriptNames,
  trackedPackageManifests,
  workflowScriptReferences,
  workflowTargetReferences,
} from './helpers/workflows';
/**
 * Targets that the named package scripts fan out over — `test:all` names
 * `test`, `test:integration:all` names `test:integration`. Scripts are looked
 * up in every tracked manifest, with the same deliberate weakness as
 * `declaredScriptNames()`: no working-directory resolution.
 */
function targetsNamedByScripts(scriptNames: ReadonlySet<string>): Set<string> {
  const targets = new Set<string>();
  for (const rel of trackedPackageManifests()) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    let parsed: { scripts?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8')) as typeof parsed;
    } catch {
      continue;
    }
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (!scriptNames.has(name)) continue;
      for (const match of command.matchAll(NX_TARGET_FLAG)) {
        if (match[1]) targets.add(match[1]);
      }
      for (const match of command.matchAll(NX_RUN)) {
        if (match[2]) targets.add(match[2]);
      }
    }
  }
  return targets;
}

/**
 * The inverse of the phantom-target check: a test lane a project DECLARES in
 * its project.json must be INVOKED by something. `test:integration` sat on
 * farm-service and auth-service for months with no workflow naming it
 * (INFRA-MEDIUM-142). Scope is the `test` family whose declaration is an
 * explicit executor; a target that exists only because a package.json script
 * was inferred (`test:watch`, a focused `test:water-chemistry`) is a developer
 * entry point, not a lane declaration, and stays out.
 */
function declaredTestLanes(): string[] {
  const lanes = new Set<string>();
  for (const name of nxProjects()) {
    for (const [target, definition] of Object.entries(nxProjectDetail(name).targets)) {
      if (!/^test(?::|$)/.test(target)) continue;
      if (target !== 'test' && definition.executor === 'nx:run-script') continue;
      lanes.add(target);
    }
  }
  return [...lanes].sort();
}

describe('workflow Nx target references', () => {
  it('finds Nx target fan-outs to check, so a silent regex break is visible', () => {
    expect(workflowTargetReferences().length).toBeGreaterThan(5);
  });

  it('resolves every referenced Nx target to at least one declaring project', () => {
    const phantom = workflowTargetReferences().filter(
      (ref) => nxProjectsWithTarget(ref.target).length === 0,
    );

    expect(phantom.map((r) => `${r.workflow}:${r.line} -> target ${r.target}`)).toEqual([]);
  });

  it('resolves every `nx run <project>:<target>` to a project that declares that target', () => {
    const workspace = new Set(nxProjects());
    const broken = workflowTargetReferences().filter((ref) => {
      if (ref.project === undefined) return false;
      if (!workspace.has(ref.project)) return true;
      return !nxProjectsWithTarget(ref.target).includes(ref.project);
    });

    expect(
      broken.map((r) => `${r.workflow}:${r.line} -> nx run ${r.project ?? ''}:${r.target}`),
    ).toEqual([]);
  });
});

describe('declared test lanes are invoked', () => {
  it('finds explicit test lanes to check, so a silent scan break is visible', () => {
    expect(declaredTestLanes()).toEqual(expect.arrayContaining(['test', 'test:integration']));
  });

  it('every explicitly declared test lane is named by a workflow or by a script a workflow runs', () => {
    const invoked = new Set(workflowTargetReferences().map((ref) => ref.target));
    const scripts = new Set(workflowScriptReferences().map((ref) => ref.script));
    for (const target of targetsNamedByScripts(scripts)) invoked.add(target);

    const silent = declaredTestLanes().filter((lane) => !invoked.has(lane));

    expect(silent).toEqual([]);
  });
});

describe('workflow npm script references', () => {
  it('finds npm run invocations to check, so a silent regex break is visible', () => {
    // Guards the guard: if NPM_RUN stopped matching, every assertion below would
    // pass over an empty set and report health it never verified.
    expect(workflowScriptReferences().length).toBeGreaterThan(5);
  });

  it('resolves every referenced script to a declared package script', () => {
    const declared = declaredScriptNames();
    expect(declared.size).toBeGreaterThan(50);

    const orphaned = workflowScriptReferences().filter((ref) => !declared.has(ref.script));

    expect(orphaned.map((r) => `${r.workflow}:${r.line} -> npm run ${r.script}`)).toEqual([]);
  });

  it('keeps the gate self-tests this repo runs in CI declared', () => {
    // Named explicitly because these two are the ones that were orphaned, and
    // because they are the tests that pin the finding-ID allocator and the
    // Closes: trailer resolver against each other.
    const declared = declaredScriptNames();
    for (const script of ['gates:commit-msg:test', 'gates:finding-registry:test']) {
      expect(declared.has(script)).toBe(true);
    }
  });
});
