#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { partitionAffectedProjects } from './lib/affected-target-policy.mjs';
import { readStrictJson } from './lib/strict-json.mjs';

function parseArgs(argv) {
  const args = {
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };

    if (arg === '--target') args.target = next();
    else if (arg === '--base') args.base = next();
    else if (arg === '--head') args.head = next();
    else if (arg === '--policy') args.policy = next();
    else if (arg === '--changed-files') args.changedFiles = next();
    else if (arg === '--affected-projects') args.affectedProjects = next();
    else if (arg === '--explicit-excludes') args.explicitExcludes = next();
    else if (arg === '--strict-projects') args.strictProjects = next();
    else if (arg === '--report') args.report = next();
    else if (arg === '--dry-run') args.dryRun = next() === 'true';
    else throw new Error(`Unknown argument: ${arg}`);
  }

  for (const key of [
    'target',
    'base',
    'head',
    'policy',
    'changedFiles',
    'affectedProjects',
    'explicitExcludes',
    'strictProjects',
    'report',
  ]) {
    if (!args[key]) throw new Error(`${key} is required`);
  }

  return args;
}

function lines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// One Nx project name per line — nothing else may reach the strict list. A JSON
// array that leaked through as a single "name" (`["a","b"]`) is matched by no
// quarantine key and by no Nx project, so the lane would run nothing and pass.
const NX_PROJECT_NAME = /^[A-Za-z0-9@/._-]+$/;

function projectNames(path) {
  const names = lines(path);
  const malformed = names.filter((name) => !NX_PROJECT_NAME.test(name));
  if (malformed.length > 0) {
    throw new Error(`Affected project list carries non-project lines: ${malformed.join(' | ')}`);
  }
  return names;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Strict: a repeated key would let the second block shadow the first
  // without a word (INFRA-MEDIUM-228), so the lane refuses the file instead.
  const policy = readStrictJson(args.policy);
  const affectedProjects = projectNames(args.affectedProjects);
  // Which affected project is gated, quarantined or lapsed back to strict is
  // owned by scripts/ci/lib/affected-target-policy.mjs: a malformed policy is
  // refused whole, an expired entry gates its own project strictly.
  const {
    strictProjects,
    explicitlyExcludedProjects,
    quarantinedProjects,
    expiredQuarantineProjects,
  } = partitionAffectedProjects(policy, {
    target: args.target,
    affectedProjects,
    explicitExcludes: lines(args.explicitExcludes),
    today: new Date().toISOString().slice(0, 10),
  });

  writeFileSync(
    args.strictProjects,
    `${strictProjects.join('\n')}${strictProjects.length ? '\n' : ''}`,
    'utf8',
  );

  const report = {
    target: args.target,
    base: args.base,
    head: args.head,
    dryRun: args.dryRun,
    changedFiles: lines(args.changedFiles),
    affectedProjects,
    strictProjects,
    explicitlyExcludedProjects,
    quarantinedProjects,
    expiredQuarantineProjects,
  };

  console.log(`CI affected target policy: target=${args.target}`);
  console.log(`Changed files considered: ${report.changedFiles.length}`);
  console.log(`Affected projects with target: ${affectedProjects.length}`);
  console.log(`Strict projects: ${strictProjects.length ? strictProjects.join(', ') : '(none)'}`);

  if (explicitlyExcludedProjects.length > 0) {
    console.log(`Explicitly excluded projects: ${explicitlyExcludedProjects.join(', ')}`);
  }

  if (quarantinedProjects.length > 0) {
    console.log('Known-unstable project target quarantine:');
    for (const entry of quarantinedProjects) {
      const tracked = `${entry.finding_id}, owner ${entry.owner}, expires ${entry.expires_on}`;
      console.log(`  - ${entry.project}: ${entry.reason} [${tracked}]`);
      console.log(
        `::warning title=CI affected ${args.target} quarantine (${tracked})::${entry.project}: ${entry.reason}`,
      );
    }
  }

  if (expiredQuarantineProjects.length > 0) {
    console.log('Expired quarantine entries, gated strictly again (pay the debt down or renew):');
    for (const entry of expiredQuarantineProjects) {
      const tracked = `${entry.finding_id}, owner ${entry.owner}`;
      console.log(`  - ${entry.project}: expired ${entry.expires_on} [${tracked}]`);
      console.log(
        `::warning title=CI affected ${args.target} quarantine expired (${tracked})::` +
          `${entry.project}: expired ${entry.expires_on}; the ${args.target} target gates it strictly`,
      );
    }
  }

  writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Affected target policy report: ${args.report}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
