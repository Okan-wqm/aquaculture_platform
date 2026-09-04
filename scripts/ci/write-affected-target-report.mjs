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

// A quarantine entry is tracked debt, and tracked debt has an owner, a reason,
// an expiry and a finding — the same four fields tests/invariants/
// invariant-reachability.dormant.json requires of a dormant invariant. A bare
// reason string was the previous shape; 19 `test` entries carried one with no
// owner, no clock and no finding for four months (PROC-MEDIUM-020). The policy
// file is refused whole when any entry of any target is malformed or expired,
// so the lane fails closed instead of warning about debt nobody owns.
const POLICY_VERSION = 2;
const FINDING_ID = /^[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON_LENGTH = 30;

function validateQuarantine(policy, today) {
  if (policy.version !== POLICY_VERSION) {
    throw new Error(`affected-target policy version ${policy.version} is not ${POLICY_VERSION}`);
  }
  const problems = [];
  for (const [target, config] of Object.entries(policy.targets ?? {})) {
    for (const [project, entry] of Object.entries(config.knownUnstableProjects ?? {})) {
      const where = `${target}/${project}`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${where}: entry must be an object {owner, reason, expires_on, finding_id}`);
        continue;
      }
      if (typeof entry.owner !== 'string' || entry.owner.trim().length === 0) {
        problems.push(`${where}: owner is required`);
      }
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(`${where}: reason must be at least ${MIN_REASON_LENGTH} characters`);
      }
      if (typeof entry.expires_on !== 'string' || !ISO_DATE.test(entry.expires_on)) {
        problems.push(`${where}: expires_on must be YYYY-MM-DD`);
      } else if (entry.expires_on < today) {
        problems.push(
          `${where}: expired ${entry.expires_on} (${entry.finding_id ?? 'no finding'})`,
        );
      }
      if (typeof entry.finding_id !== 'string' || !FINDING_ID.test(entry.finding_id)) {
        problems.push(`${where}: finding_id must be a registry id like INFRA-HIGH-001`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`affected-target policy quarantine is invalid:\n  ${problems.join('\n  ')}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(args.policy, 'utf8'));
  validateQuarantine(policy, new Date().toISOString().slice(0, 10));
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
      quarantinedProjects.push({ project, ...knownUnstable[project] });
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
      const tracked = `${entry.finding_id}, owner ${entry.owner}, expires ${entry.expires_on}`;
      console.log(`  - ${entry.project}: ${entry.reason} [${tracked}]`);
      console.log(
        `::warning title=CI affected ${args.target} quarantine (${tracked})::${entry.project}: ${entry.reason}`,
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
