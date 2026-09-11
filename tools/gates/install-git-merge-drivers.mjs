#!/usr/bin/env node
/**
 * install-git-merge-drivers — register this repository's custom git merge
 * drivers into the local `.git/config`.
 *
 * A `merge=<name>` attribute in `.gitattributes` is only half of a merge
 * driver. The other half is `merge.<name>.driver` in git config, which is
 * per-clone and cannot be committed. Without it git prints
 * `Failed to merge in the changes` / falls back to the default text merge,
 * and the attribute is decoration — which is exactly the state
 * `docs/aria/CURRENT_STATE.md merge=ours` had been in: a pin with a written
 * rationale that had never once taken effect, because nothing in the repo
 * ever registered the `ours` driver.
 *
 * So registration is not a setup step a contributor is asked to remember.
 * It runs from `prepare`, after every `npm install` / `npm ci`, on developer
 * machines and CI runners alike, and `tools/gates/git-merge-drivers.json` is
 * the single list both this script and the invariant spec read.
 *
 * It must never fail an install. A missing git directory (dependency
 * tarball), a read-only config, a git that is not on PATH: warn on stderr
 * and exit 0. The invariant spec, not this script, is what makes a missing
 * registration visible.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
export const MANIFEST_PATH = join(HERE, 'git-merge-drivers.json');

export function readMergeDriverManifest(manifestPath = MANIFEST_PATH) {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.drivers !== 'object') {
    throw new Error(`Merge driver manifest has no "drivers" object: ${manifestPath}`);
  }
  for (const [name, spec] of Object.entries(parsed.drivers)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`Merge driver name must be lower-kebab-case: ${name}`);
    }
    if (spec === null || typeof spec !== 'object') {
      throw new Error(`Merge driver ${name} is not an object`);
    }
    if (typeof spec.driver !== 'string' || spec.driver.length === 0) {
      throw new Error(`Merge driver ${name} is missing a driver command`);
    }
    if (typeof spec.name !== 'string' || spec.name.length === 0) {
      throw new Error(`Merge driver ${name} is missing a human-readable name`);
    }
  }
  return parsed.drivers;
}

function git(args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
}

function readConfig(key) {
  try {
    return git(['config', '--local', '--get', key]);
  } catch {
    return null;
  }
}

function main() {
  let drivers;
  try {
    drivers = readMergeDriverManifest();
  } catch (error) {
    process.stderr.write(`install-git-merge-drivers: ${error.message}\n`);
    return;
  }

  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    // Not a git checkout (published tarball, vendored copy). Nothing to do.
    return;
  }

  const changed = [];
  for (const [name, spec] of Object.entries(drivers)) {
    for (const [suffix, value] of [
      ['driver', spec.driver],
      ['name', spec.name],
    ]) {
      const key = `merge.${name}.${suffix}`;
      if (readConfig(key) === value) continue;
      try {
        git(['config', '--local', key, value]);
        changed.push(key);
      } catch (error) {
        process.stderr.write(
          `install-git-merge-drivers: could not set ${key} — ${error.message}\n` +
            "Merges of the files that declare this driver will fall back to git's text merge.\n",
        );
        return;
      }
    }
  }

  if (changed.length > 0) {
    process.stdout.write(
      `install-git-merge-drivers: registered ${changed.length} git config key(s) for ` +
        `${Object.keys(drivers).length} merge driver(s).\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
