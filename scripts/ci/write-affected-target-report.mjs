#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isoDate,
  loadFindingStates,
  validateAffectedTargetPolicy,
} from './affected-target-policy-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    else if (arg === '--today') args.today = next();
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(args.policy, 'utf8'));

  // ADR-0017: the consumer is the gate. The WHOLE policy is validated on
  // every run, not only the affected slice, so a malformed, expired or
  // paid-off quarantine anywhere in the file fails the run before an Nx
  // target is chosen. Editing prose can no longer extend a quarantine.
  const violations = validateAffectedTargetPolicy(policy, {
    today: args.today ?? isoDate(new Date()),
    findingStates: loadFindingStates(REPO_ROOT),
  });
  if (violations.length > 0) {
    throw new Error(
      `affected-target-policy ${args.policy} violates the quarantine contract (ADR-0017):\n` +
        violations.map((violation) => `  - ${violation}`).join('\n'),
    );
  }

  const affectedProjects = lines(args.affectedProjects);
  const explicitExcludes = new Set(lines(args.explicitExcludes));
  const knownUnstable = policy.targets?.[args.target]?.knownUnstableProjects ?? {};
  const strictProjects = [];
  const explicitlyExcludedProjects = [];
  const quarantinedProjects = [];

  for (const project of affectedProjects) {
    if (explicitExcludes.has(project)) {
      explicitlyExcludedProjects.push(project);
    } else if (Object.prototype.hasOwnProperty.call(knownUnstable, project)) {
      const { owner, expiry, findingId, reason } = knownUnstable[project];
      quarantinedProjects.push({ project, owner, expiry, findingId, reason });
    } else {
      strictProjects.push(project);
    }
  }

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
  };

  console.log(`CI affected target policy: target=${args.target}`);
  console.log(`Changed files considered: ${report.changedFiles.length}`);
  console.log(`Affected projects with target: ${affectedProjects.length}`);
  console.log(`Strict projects: ${strictProjects.length ? strictProjects.join(', ') : '(none)'}`);

  if (explicitlyExcludedProjects.length > 0) {
    console.log(`Explicitly excluded projects: ${explicitlyExcludedProjects.join(', ')}`);
  }

  if (quarantinedProjects.length > 0) {
    console.log('Known-unstable project target quarantine (governed debt, ADR-0017):');
    for (const entry of quarantinedProjects) {
      const label = `${entry.project}: ${entry.reason} [owner=${entry.owner} expiry=${entry.expiry} finding=${entry.findingId}]`;
      console.log(`  - ${label}`);
      console.log(`::warning title=CI affected ${args.target} baseline debt::${label}`);
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
