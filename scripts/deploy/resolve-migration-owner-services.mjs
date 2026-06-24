#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');

// WHY a hand-rolled matcher (not picomatch): this script runs in the deploy
// `prepare` job, which has no `npm ci` step, and picomatch is only present as a
// hoisted transitive dev-dependency — importing it would make every selective
// deploy die with ERR_MODULE_NOT_FOUND. The migrationGlobs vocabulary is small
// and fixed (literal path segments + `*` + `[...]` char classes + `{a,b}`
// braces), so a Node-builtin glob→RegExp keeps deploy detection dependency-free.
function globToRegExp(glob) {
  let re = '';
  let inBrace = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      // Copy the character class verbatim — `[0-9]` is regex-compatible.
      let cls = '[';
      let j = i + 1;
      if (glob[j] === '!' || glob[j] === '^') {
        cls += '^';
        j += 1;
      }
      while (j < glob.length && glob[j] !== ']') {
        cls += glob[j];
        j += 1;
      }
      cls += ']';
      re += cls;
      i = j;
    } else if (c === '{') {
      inBrace = true;
      re += '(?:';
    } else if (c === '}') {
      inBrace = false;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else {
      // Escape any remaining RegExp metacharacter so it matches literally.
      re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAnyGlob(globs, file) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

function usage() {
  console.error('Usage: node scripts/deploy/resolve-migration-owner-services.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const [baseSha, headSha] = process.argv.slice(2);
if (!headSha) {
  usage();
}

const catalog = JSON.parse(
  readFileSync(resolve(repoRoot, 'infrastructure/deploy/service-catalog.generated.json'), 'utf8'),
);

const schemas = catalog.dbSchemas ?? [];
if (!Array.isArray(schemas)) {
  throw new Error('service-catalog.generated.json is missing dbSchemas[]');
}
const deployableBackendServices = new Set(catalog.deploy?.backendImageTargets ?? []);

function diffFiles(base, head) {
  if (!base) {
    return ['__ALL_MIGRATION_OWNERS__'];
  }

  const output = execFileSync('git', ['diff', '--name-only', base, head], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const changedFiles = diffFiles(baseSha, headSha);
const allOwners = changedFiles.includes('__ALL_MIGRATION_OWNERS__');
const ownerServices = new Set();

for (const schema of schemas) {
  const serviceId = schema.serviceId;
  const globs = schema.migrationGlobs ?? [];
  if (!serviceId || !Array.isArray(globs)) {
    continue;
  }
  if (deployableBackendServices.size > 0 && !deployableBackendServices.has(serviceId)) {
    continue;
  }

  if (allOwners) {
    ownerServices.add(serviceId);
    continue;
  }

  if (changedFiles.some((file) => matchesAnyGlob(globs, file))) {
    ownerServices.add(serviceId);
  }
}

process.stdout.write([...ownerServices].sort().join(' '));
