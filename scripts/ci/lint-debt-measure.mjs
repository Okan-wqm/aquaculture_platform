#!/usr/bin/env node
/**
 * Measure the lint debt of every project in the affected lane's lint
 * quarantine, renew the quarantine from that measurement, or verify that the
 * committed quarantine is a measured one. The rules (bound, security class,
 * renewal) live in scripts/ci/lib/lint-debt.mjs; this file only runs them.
 *
 *   node scripts/ci/lint-debt-measure.mjs --dry-run
 *       measure and print; writes nothing, so any working tree is fine
 *   node scripts/ci/lint-debt-measure.mjs
 *       measure a clean committed tree and write scripts/ci/lint-debt-measurement.json
 *   node scripts/ci/lint-debt-measure.mjs --renew
 *       the same, then rewrite targets.lint of scripts/ci/affected-target-policy.json
 *   node scripts/ci/lint-debt-measure.mjs --verify [--policy P] [--measurement M]
 *       exit 1 naming every lint entry that is unmeasured, past its bound,
 *       measured clean or carrying security-class lint
 *
 * Measuring runs each project's own lint invocation (lintInvocations) one
 * project at a time, at nice 10, with ESLint's JSON formatter. A recorded
 * measurement names the commit it was taken at, and that tree must be clean:
 * the numbers are evidence for exactly that commit, which tests/invariants/
 * affected-target-quarantine-ssot.spec.ts then requires to be in HEAD's history.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setPriority, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyNxRuntimeEnv } from '../../tools/toolchain/toolchain-runtime.mjs';

import {
  MEASUREMENT_SCHEMA,
  lintInvocations,
  renewLintQuarantine,
  summarizeLintInvocations,
  verifyLintQuarantine,
} from './lib/lint-debt.mjs';
import { readStrictJson } from './lib/strict-json.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_POLICY = join(repoRoot, 'scripts/ci/affected-target-policy.json');
const DEFAULT_MEASUREMENT = join(repoRoot, 'scripts/ci/lint-debt-measurement.json');
const TOOLCHAIN_RUN = join(repoRoot, 'tools/toolchain/run.mjs');
const OUTPUT_LIMIT = 64 * 1024 * 1024;

function parseArgs(argv) {
  const args = { mode: 'record', policy: DEFAULT_POLICY, measurement: DEFAULT_MEASUREMENT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return resolve(argv[index]);
    };
    if (arg === '--dry-run') args.mode = 'dry-run';
    else if (arg === '--renew') args.mode = 'renew';
    else if (arg === '--verify') args.mode = 'verify';
    else if (arg === '--policy') args.policy = next();
    else if (arg === '--measurement') args.measurement = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(args) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function isAncestorOfHead(sha) {
  return git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
}

/** The UTC committer day of a commit, YYYY-MM-DD; null when git cannot read it. */
function commitDayOf(sha) {
  const shown = git(['show', '-s', '--format=%ct', sha]);
  const seconds = Number(shown.stdout.trim());
  if (shown.status !== 0 || !Number.isSafeInteger(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function verify(args) {
  const policy = readStrictJson(args.policy);
  const measurement = existsSync(args.measurement) ? readStrictJson(args.measurement) : null;
  const problems = verifyLintQuarantine(
    policy,
    measurement,
    { isAncestorOfHead, commitDayOf },
    utcToday(),
  );
  if (problems.length > 0) {
    console.error(`lint quarantine is not a measured one:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const count = Object.keys(policy.targets?.lint?.knownUnstableProjects ?? {}).length;
  console.log(`lint quarantine: ${count} entries, each measured and within its bound`);
  return 0;
}

function projectGraph(scratch) {
  const file = join(scratch, 'graph.json');
  const result = spawnSync(
    process.execPath,
    [TOOLCHAIN_RUN, 'npx', 'nx', 'graph', `--file=${file}`],
    {
      cwd: repoRoot,
      env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
      encoding: 'utf8',
      maxBuffer: OUTPUT_LIMIT,
    },
  );
  if (result.status !== 0) throw new Error(`nx graph failed:\n${result.stderr}`);
  const nodes = readJson(file).graph.nodes;
  return new Map(
    Object.entries(nodes).map(([name, node]) => [
      name,
      { name, root: node.data.root, targets: node.data.targets ?? {} },
    ]),
  );
}

function packageScriptsFor(projects) {
  const scripts = {};
  for (const project of projects) {
    const options = project.targets.lint?.options ?? {};
    for (const dir of [options.cwd ?? '.', project.root]) {
      const path = join(repoRoot, dir, 'package.json');
      if (scripts[dir] === undefined && existsSync(path)) {
        scripts[dir] = readJson(path).scripts ?? {};
      }
    }
  }
  return scripts;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runInvocation(project, invocation, outputFile) {
  const cwd = join(repoRoot, invocation.cwd);
  const env = { ...process.env };
  applyNxRuntimeEnv(env);
  const formatter = ['--format', 'json', '--output-file', outputFile];
  const result =
    invocation.mode === 'argv'
      ? spawnSync(process.execPath, [TOOLCHAIN_RUN, 'eslint', ...invocation.args, ...formatter], {
          cwd,
          env,
          encoding: 'utf8',
          maxBuffer: OUTPUT_LIMIT,
        })
      : spawnSync(
          '/bin/sh',
          [
            '-c',
            `${invocation.command} ${formatter.slice(0, 3).join(' ')} ${shellQuote(outputFile)}`,
          ],
          {
            cwd,
            env: {
              ...env,
              PATH: [
                join(cwd, 'node_modules/.bin'),
                join(repoRoot, 'node_modules/.bin'),
                env.PATH,
              ].join(':'),
            },
            encoding: 'utf8',
            maxBuffer: OUTPUT_LIMIT,
          },
        );
  // ESLint exits 1 when it reports problems; anything else is a run that
  // measured nothing and must not be recorded as a measurement.
  if ((result.status !== 0 && result.status !== 1) || !existsSync(outputFile)) {
    throw new Error(
      `${project}: eslint did not complete (status ${String(result.status)}):\n${result.stderr}`,
    );
  }
  const results = readJson(outputFile);
  if (!Array.isArray(results)) throw new Error(`${project}: eslint wrote no result array`);
  return results;
}

function describeInvocation(invocation) {
  const text =
    invocation.mode === 'argv' ? `eslint ${invocation.args.join(' ')}` : invocation.command;
  return invocation.cwd === '.' ? text : `(cd ${invocation.cwd}) ${text}`;
}

async function writeFormatted(path, value) {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(path)) ?? {};
  writeFileSync(path, await prettier.format(JSON.stringify(value), { ...options, filepath: path }));
}

async function measure(args) {
  if (args.mode !== 'dry-run') {
    const status = git(['status', '--porcelain']);
    if (status.status !== 0 || status.stdout.trim().length > 0) {
      throw new Error(
        'a recorded measurement is evidence for one commit: commit or remove every change first ' +
          '(--dry-run measures any tree and records nothing)',
      );
    }
  }
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const measuredAt = utcToday();
  const policy = readStrictJson(args.policy);
  const quarantine = policy.targets?.lint?.knownUnstableProjects ?? {};
  const { NON_SECURITY_RESTRICTED_SYNTAX_MESSAGES } = await import(
    pathToFileURL(join(repoRoot, 'eslint.config.mjs')).href
  );
  const nonSecurity = [...NON_SECURITY_RESTRICTED_SYNTAX_MESSAGES];

  // Lower this process's priority once; every eslint child inherits it.
  setPriority(10);
  const scratch = mkdtempSync(join(tmpdir(), 'lint-debt-'));
  try {
    const graph = projectGraph(scratch);
    const names = Object.keys(quarantine).sort();
    const missing = names.filter((name) => !graph.has(name));
    if (missing.length > 0) throw new Error(`not Nx projects: ${missing.join(', ')}`);
    const projects = names.map((name) => graph.get(name));
    const scripts = packageScriptsFor(projects);
    const measured = {};
    for (const project of projects) {
      const invocations = lintInvocations(project, scripts);
      const runs = invocations.map((invocation, index) => ({
        results: runInvocation(project.name, invocation, join(scratch, `${index}-out.json`)),
        maxWarnings: invocation.maxWarnings,
      }));
      measured[project.name] = {
        finding_id: quarantine[project.name].finding_id,
        ...summarizeLintInvocations(runs, nonSecurity),
        measured_with: invocations.map(describeInvocation),
      };
      const row = measured[project.name];
      console.log(
        `${project.name}: debt ${row.debt} (errors ${row.errors}, warnings ${row.warnings}), ` +
          `security-class ${row.security}`,
      );
    }
    return {
      schema: MEASUREMENT_SCHEMA,
      measured_at: measuredAt,
      measured_sha: sha,
      projects: measured,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'verify') return verify(args);

  const measurement = await measure(args);
  if (args.mode === 'dry-run') {
    console.log(JSON.stringify(measurement, null, 2));
    return 0;
  }
  await writeFormatted(args.measurement, measurement);
  console.log(`lint debt measurement: ${args.measurement}`);
  if (args.mode !== 'renew') return 0;

  // Strict: a renewal rewrites the file from what it parsed, so a repeated
  // key would leave the file without its first block (INFRA-MEDIUM-228).
  const renewal = renewLintQuarantine(readStrictJson(args.policy), measurement);
  await writeFormatted(args.policy, renewal.policy);
  console.log(`deleted (measured clean): ${renewal.deleted.join(', ') || '(none)'}`);
  console.log(`renewed: ${renewal.renewed.join(', ') || '(none)'}`);
  if (renewal.refused.length > 0) {
    console.error(
      `NOT renewed, security-class lint to pay down first: ${renewal.refused.join(', ')}`,
    );
  }
  if (renewal.unmeasured.length > 0) {
    console.error(`NOT renewed, unmeasured: ${renewal.unmeasured.join(', ')}`);
  }
  return renewal.refused.length + renewal.unmeasured.length > 0 ? 1 : 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
