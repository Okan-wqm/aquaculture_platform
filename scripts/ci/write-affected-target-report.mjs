#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
  const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
  const affectedProjects = projectNames(args.affectedProjects);
  const explicitExcludes = new Set(lines(args.explicitExcludes));
  const knownUnstable = policy.targets?.[args.target]?.knownUnstableProjects ?? {};
  const strictProjects = [];
  const explicitlyExcludedProjects = [];
  const quarantinedProjects = [];

  for (const project of affectedProjects) {
    if (explicitExcludes.has(project)) {
      explicitlyExcludedProjects.push(project);
    } else if (Object.prototype.hasOwnProperty.call(knownUnstable, project)) {
      quarantinedProjects.push({ project, reason: knownUnstable[project] });
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
    console.log('Known-unstable project target quarantine:');
    for (const entry of quarantinedProjects) {
      console.log(`  - ${entry.project}: ${entry.reason}`);
      console.log(
        `::warning title=CI affected ${args.target} baseline debt::${entry.project}: ${entry.reason}`,
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
