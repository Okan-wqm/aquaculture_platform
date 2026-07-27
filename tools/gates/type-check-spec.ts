#!/usr/bin/env ts-node
/**
 * type-check-spec — monorepo gate that runs `tsc -p <project>/tsconfig.spec.json
 * --noEmit` against every project with a spec tsconfig and compares the
 * resulting error count to a per-project baseline.
 *
 * Why this gate exists
 * --------------------
 * `ts-jest` runs with a permissive transform, while
 * `tsc -p tsconfig.spec.json` runs with the project's full strict
 * settings. CI today only invokes the former — so contract drift
 * (renamed types, new required fields, narrowed unions) accumulates in
 * spec files SILENTLY until a separate cleanup PR runs the strict
 * compile and surfaces hundreds of errors at once.
 *
 * This was observed three times in a row before this gate landed:
 *   - farm-module #146 (spec baseline cleanup)
 *   - sensor-service #162 (80 baseline errors)
 *   - gateway-api #164 (115 baseline errors)
 *
 * The architectural fix is not to keep cleaning service-by-service —
 * it is to RUN the strict compile in CI so drift can never accumulate
 * past one PR. This is the gate that does that.
 *
 * Why a baseline (not "must be 0")
 * --------------------------------
 * At gate-introduction time, 11 of 20 projects still have non-zero
 * spec error counts. A "must be 0" gate would either block every PR
 * (DoS) or require a 300-error monolithic cleanup PR (un-reviewable).
 *
 * The baseline file pins the CURRENT count per project. The gate fails
 * on any REGRESSION (count > baseline) and warns when count < baseline
 * so the baseline can be tightened. PRs that drive a project to 0 also
 * lock that project at 0 — no future regression possible.
 *
 * Usage
 * -----
 *   ts-node tools/gates/type-check-spec.ts                  # run all projects
 *   ts-node tools/gates/type-check-spec.ts --project apps/farm-service
 *   ts-node tools/gates/type-check-spec.ts --update-baseline  # rewrite baseline
 *
 * Exit codes
 * ----------
 *   0 — all project counts within baseline (gate green)
 *   1 — one or more projects regressed (gate red)
 *   2 — usage error / missing tsconfig.spec.json
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'tools', 'gates', 'type-check-spec-baseline.json');

interface BaselineEntry {
  errors: number;
  finding?: string;
  notes?: string;
}

interface Baseline {
  generatedAt: string;
  description: string;
  projects: Record<string, BaselineEntry>;
}

function discoverProjects(): string[] {
  // Project roots that may contain a `tsconfig.spec.json`. `platform/libs`
  // was added in PR-39 when @platform/outbox got its first test suite —
  // before then no platform lib had a spec config, so the gate never had
  // to look there.
  // `tests` joined in 2026-07-27: tests/invariants owns ~170 structural gates
  // and carried 16 strict-tsc errors that nothing saw — it was outside these
  // roots, and ts-jest transpiles without type-checking, so the drift was
  // invisible from both directions (FARM-MEDIUM-302). Driven to 0 in the same
  // commit, which locks it at 0 here.
  const roots: readonly string[] = ['apps', 'libs', 'platform/libs', 'tests'];
  const projects: string[] = [];
  for (const root of roots) {
    const rootDir = join(REPO_ROOT, root);
    if (!existsSync(rootDir)) continue;
    for (const child of readdirSync(rootDir)) {
      const projectDir = join(rootDir, child);
      if (!statSync(projectDir).isDirectory()) continue;
      const specCfg = join(projectDir, 'tsconfig.spec.json');
      if (existsSync(specCfg)) {
        projects.push(`${root}/${child}`);
      }
    }
  }
  return projects.sort();
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    return {
      generatedAt: new Date().toISOString(),
      description: 'Per-project baseline error counts for tsc -p <project>/tsconfig.spec.json --noEmit. The gate fails on any regression above these numbers; PRs that drive a count down should also update this file (use --update-baseline).',
      projects: {},
    };
  }
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  return JSON.parse(raw) as Baseline;
}

function writeBaseline(baseline: Baseline): void {
  const sorted: Record<string, BaselineEntry> = {};
  for (const key of Object.keys(baseline.projects).sort()) {
    sorted[key] = baseline.projects[key]!;
  }
  baseline.projects = sorted;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}

function countSpecErrors(project: string): number {
  const cfg = join(REPO_ROOT, project, 'tsconfig.spec.json');
  if (!existsSync(cfg)) {
    throw new Error(`tsconfig.spec.json missing for ${project}`);
  }
  // Direct invocation of node_modules/.bin/tsc — avoids npx flag parsing
  // pitfalls (npx --no was being treated as a workspace selector and
  // tsc never ran, causing the gate to silently report 0 errors for
  // projects that actually had hundreds).
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  const result = spawnSync(
    tscBin,
    ['-p', cfg, '--noEmit', '--pretty', 'false'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  // tsc returns non-zero on any error; we don't care about the exit code,
  // we count "error TS" lines on combined stdout+stderr.
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  const matches = combined.match(/error TS\d+/g);
  return matches ? matches.length : 0;
}

interface ProjectResult {
  project: string;
  count: number;
  baseline: number;
  status: 'green' | 'regressed' | 'improved' | 'new';
}

function evaluate(projects: string[], baseline: Baseline): ProjectResult[] {
  const results: ProjectResult[] = [];
  for (const project of projects) {
    const count = countSpecErrors(project);
    const entry = baseline.projects[project];
    const baseCount = entry?.errors ?? 0;
    let status: ProjectResult['status'];
    if (!entry) {
      status = count === 0 ? 'green' : 'new';
    } else if (count > baseCount) {
      status = 'regressed';
    } else if (count < baseCount) {
      status = 'improved';
    } else {
      status = 'green';
    }
    results.push({ project, count, baseline: baseCount, status });
  }
  return results;
}

function reportTable(results: readonly ProjectResult[]): void {
  const colProject = Math.max(8, ...results.map((r) => r.project.length));
  const header = `${'project'.padEnd(colProject)}  count  baseline  status`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const delta = r.count - r.baseline;
    const arrow = delta === 0 ? '' : delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `${r.project.padEnd(colProject)}  ${String(r.count).padStart(5)}  ${String(r.baseline).padStart(8)}  ${r.status}${arrow ? ` (${arrow})` : ''}`,
    );
  }
}

function main(): number {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');
  const projectFlagIndex = args.indexOf('--project');
  const projectFilter = projectFlagIndex >= 0 ? args[projectFlagIndex + 1] : undefined;

  const allProjects = discoverProjects();
  const projects = projectFilter
    ? allProjects.filter((p) => p === projectFilter || p.endsWith(`/${projectFilter}`))
    : allProjects;
  if (projects.length === 0) {
    console.error(`No projects matched filter: ${projectFilter ?? '(none)'}`);
    return 2;
  }

  const baseline = loadBaseline();

  if (updateBaseline) {
    console.log(`Updating baseline for ${projects.length} project(s)…`);
    for (const project of projects) {
      const count = countSpecErrors(project);
      const existing = baseline.projects[project];
      baseline.projects[project] = {
        errors: count,
        finding: existing?.finding,
        notes: existing?.notes,
      };
      console.log(`  ${project}: ${count}`);
    }
    baseline.generatedAt = new Date().toISOString();
    writeBaseline(baseline);
    console.log(`Wrote ${BASELINE_PATH}`);
    return 0;
  }

  const results = evaluate(projects, baseline);
  reportTable(results);

  const regressed = results.filter((r) => r.status === 'regressed');
  const newProjects = results.filter((r) => r.status === 'new');
  const improved = results.filter((r) => r.status === 'improved');

  console.log('');
  if (regressed.length > 0) {
    console.error(`FAIL: ${regressed.length} project(s) regressed above baseline:`);
    for (const r of regressed) {
      console.error(`  - ${r.project}: ${r.count} (baseline ${r.baseline}, +${r.count - r.baseline})`);
      console.error(`    Run: npx tsc -p ${r.project}/tsconfig.spec.json --noEmit`);
    }
    return 1;
  }
  if (newProjects.length > 0) {
    console.error(`FAIL: ${newProjects.length} project(s) have a tsconfig.spec.json but no baseline entry. Add an entry (with --update-baseline) before merging.`);
    for (const r of newProjects) {
      console.error(`  - ${r.project}: ${r.count} errors (no baseline)`);
    }
    return 1;
  }
  if (improved.length > 0) {
    console.log(`NOTE: ${improved.length} project(s) improved below baseline. Tighten with --update-baseline:`);
    for (const r of improved) {
      console.log(`  - ${r.project}: ${r.count} (baseline ${r.baseline}, ${r.count - r.baseline})`);
    }
  }
  console.log(`OK: ${results.length} project(s) within baseline.`);
  return 0;
}

const exitCode = main();
process.exit(exitCode);
