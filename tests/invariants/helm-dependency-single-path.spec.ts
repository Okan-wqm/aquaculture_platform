/**
 * `helm dependency update` must be spelled exactly once, and that one spelling
 * must survive a transient registry failure without surviving a real one.
 *
 * WHY. The chart's subchart archives are not committed — Chart.yaml is the SSoT
 * and `charts/` is build output — so every renderer resolves them from the
 * declared upstream repositories at CI time. Two workflows do that:
 * `ci-affected.yml`'s Phase A4 (which feeds `helm template`, and on which the
 * required `build-status` check depends) and `infra-helm-lint.yml`'s lint
 * matrix.
 *
 * WHAT IT COST. Both carried the command as their own hand-written line, which
 * put a live third-party chart registry on the critical path of a REQUIRED
 * check with no tolerance for it being briefly unreachable. On 2026-08-03
 * charts.bitnami.com reset the connection mid-fetch and `pre-flight` went red,
 * taking `build-status` with it, on a pull request whose diff touched no
 * infrastructure at all. Recovery was not even a re-run: the workflow token
 * cannot POST `rerun-failed-jobs`, so an unrelated commit had to be pushed to
 * make CI try again.
 *
 * The retry that fixes it is one property of one implementation. Two
 * hand-written copies are how a property becomes true of only one of them —
 * the drift `aria-single-restore-path.spec.ts` exists to prevent for the state
 * artifact, where ORPHAN-CRITICAL-484's fix landed on the consumer lane and
 * never reached the producer.
 *
 * The behavioural half runs `resolve.sh` against a stub `helm`. Asserting that
 * the words "attempt" and "sleep" appear in the script would also be satisfied
 * by a loop that never increments its counter; counting the stub's invocations
 * is what actually distinguishes retrying from spinning.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

const RESOLVER_ACTION = '.github/actions/helm-dependency-update';
const RESOLVE_SH = join(REPO_ROOT, RESOLVER_ACTION, 'resolve.sh');

/** The workflows that must resolve chart dependencies before they can render. */
const CHART_RENDERING_WORKFLOWS = ['ci-affected.yml', 'infra-helm-lint.yml'] as const;

/**
 * An invocation of the resolver, matched on the command rather than the step
 * name: renaming a step is not the hazard, a second copy of the fetch is.
 */
const INVOKES_THE_RESOLVER = /helm\s+dependency\s+(update|build)\b/;

/**
 * The file with the lines that DESCRIBE behaviour, rather than perform it,
 * removed — comments and step labels.
 *
 * ORPHAN-MEDIUM-458's lesson, and one this file tripped over twice on its first
 * run. Both callsites' comments and the action's own header quote the command
 * they describe, so a raw text scan reports three implementations where there
 * is one. Then, with comments stripped, it still reported two: the surviving
 * match in `ci-affected.yml` was the step's own `name:` — `Phase A4 — helm
 * dependency update (Chart.yaml SSoT to charts/)` — a label GitHub renders and
 * never executes.
 *
 * Both are the same error: matching the description instead of the thing. A
 * gate that fails on accurate documentation gets the documentation deleted, or
 * the step renamed to something less true, which is worse than the drift it was
 * built to catch.
 *
 * Line-level rather than a YAML parse, because an inline `#` following a real
 * command is part of an executable line, and because `name:` is unambiguous at
 * line level in a workflow file.
 */
function executableYaml(body: string): string {
  return body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('#') && !/^-?\s*name:/.test(trimmed);
    })
    .join('\n');
}

function ciFiles(): { rel: string; body: string }[] {
  const files: { rel: string; body: string }[] = [];
  for (const name of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    files.push({
      rel: `.github/workflows/${name}`,
      body: readFileSync(join(WORKFLOW_DIR, name), 'utf8'),
    });
  }
  for (const dir of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const candidate of ['action.yml', 'action.yaml']) {
      const abs = join(ACTIONS_DIR, dir.name, candidate);
      if (existsSync(abs)) {
        files.push({
          rel: `.github/actions/${dir.name}/${candidate}`,
          body: readFileSync(abs, 'utf8'),
        });
        break;
      }
    }
  }
  return files;
}

/**
 * Run `resolve.sh` against a chart directory with a stub `helm` that fails its
 * first `failures` invocations and succeeds after that. `failures: Infinity`
 * stands in for a registry that is genuinely down.
 *
 * Backoff is set to 0 so the tests measure the retry COUNT rather than waiting
 * out the real 5s + 10s schedule; the doubling itself is arithmetic on a
 * variable the script never branches on.
 */
function runResolver({
  failures,
  attempts,
  withChart = true,
}: {
  failures: number;
  attempts?: string;
  withChart?: boolean;
}): { status: number; output: string; calls: number } {
  const dir = mkdtempSync(join(tmpdir(), 'helm-resolve-'));
  const chartDir = join(dir, 'chart');
  const binDir = join(dir, 'bin');
  const counter = join(dir, 'calls');
  execFileSync('mkdir', ['-p', chartDir, binDir]);
  if (withChart) writeFileSync(join(chartDir, 'Chart.yaml'), 'name: stub\nversion: 0.0.0\n');
  writeFileSync(counter, '');

  // Appends a line per invocation, then fails or succeeds by count. `wc -l`
  // over the file is the call count — the assertion the text scan could not
  // make.
  const stub = [
    '#!/usr/bin/env bash',
    `echo call >> "${counter}"`,
    `calls=$(wc -l < "${counter}")`,
    `if [ "$calls" -le ${Number.isFinite(failures) ? failures : 999999} ]; then`,
    '  echo "Save error occurred: connection reset by peer" >&2',
    '  exit 1',
    'fi',
    'echo "resolved"',
  ].join('\n');
  writeFileSync(join(binDir, 'helm'), `${stub}\n`);
  chmodSync(join(binDir, 'helm'), 0o755);

  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', [RESOLVE_SH, chartDir], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKOFF_SECONDS: '0',
        ...(attempts ? { ATTEMPTS: attempts } : {}),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return {
    status,
    output,
    calls: readFileSync(counter, 'utf8').split('\n').filter(Boolean).length,
  };
}

describe('helm dependency resolution has a single path', () => {
  it('has exactly one implementation that fetches chart dependencies', () => {
    const implementations = ciFiles()
      .filter(({ body }) => INVOKES_THE_RESOLVER.test(executableYaml(body)))
      .map(({ rel }) => rel);

    expect(implementations).toEqual([]);
    // The command itself now lives in the script, not in any YAML — so the YAML
    // scan above must find NOTHING, and the script must be the one place it is.
    expect(INVOKES_THE_RESOLVER.test(readFileSync(RESOLVE_SH, 'utf8'))).toBe(true);
  });

  it('has every chart-rendering workflow use that one implementation', () => {
    // Existence of the action proves nothing on its own: a workflow could keep
    // its own copy while the action sat unused, which is the state the
    // state-artifact restore was in for months.
    for (const name of CHART_RENDERING_WORKFLOWS) {
      const body = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
      expect(body).toContain(`uses: ./${RESOLVER_ACTION}`);
    }
  });
});

describe('the resolver retries a transient failure', () => {
  it('succeeds when the registry fails once, and says that it retried', () => {
    // The 2026-08-03 incident in miniature: one reset, then the registry is
    // back. Before this action, that reset failed a required check.
    const { status, output, calls } = runResolver({ failures: 1 });
    expect(status).toBe(0);
    expect(calls).toBe(2);
    // Surfaced, not silent — a retry nobody can count is a dependency that
    // looks healthy right up until it exhausts the attempts.
    //
    // Asserted as the two SPECIFIC messages rather than as "some ::warning::
    // was printed", because the weaker form was written first and a mutation
    // walked straight through it: deleting the success notice still left the
    // retry notice, so the generic assertion passed while the behaviour it
    // named was gone. Both lines carry distinct information — that an attempt
    // failed, and that the step nonetheless recovered and on which attempt —
    // so both are pinned.
    expect(output).toMatch(/::warning::.*failed on attempt 1\/3; retrying/);
    expect(output).toMatch(/::warning::.*succeeded on attempt 2\/3/);
  });

  it('does not retry when the first attempt succeeds', () => {
    const { status, output, calls } = runResolver({ failures: 0 });
    expect(status).toBe(0);
    expect(calls).toBe(1);
    expect(output).not.toContain('::warning::');
  });

  it('still fails, and bounds its attempts, when the registry is really down', () => {
    // The property that keeps this a retry rather than a way to never fail. An
    // unbounded loop does not turn red; it burns the job timeout and then says
    // the same thing far later.
    const { status, calls, output } = runResolver({ failures: Infinity });
    expect(status).toBe(1);
    expect(calls).toBe(3);
    expect(output).toContain('::error::');
  });

  it('honours a configured attempt count rather than a hardcoded one', () => {
    const { status, calls } = runResolver({ failures: Infinity, attempts: '5' });
    expect(status).toBe(1);
    expect(calls).toBe(5);
  });

  it('refuses a zero-attempt configuration instead of passing without asking', () => {
    // Succeeding by never calling the resolver is the one outcome worse than
    // either failing or retrying.
    const { status, calls } = runResolver({ failures: Infinity, attempts: '0' });
    expect(status).toBe(1);
    expect(calls).toBe(0);
  });

  it('fails on a missing Chart.yaml without calling the resolver at all', () => {
    const { status, calls, output } = runResolver({ failures: 0, withChart: false });
    expect(status).toBe(1);
    expect(calls).toBe(0);
    expect(output).toContain('No Chart.yaml');
  });
});
