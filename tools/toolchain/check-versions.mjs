#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const versionsPath = resolve(repoRoot, 'tools/toolchain/versions.json');
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
const checksTerraform = process.argv.includes('--terraform');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readCommand(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command} is unavailable or failed: ${detail}`);
  }
}

function parseVersionTuple(raw) {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    fail(`Unable to parse semantic version from "${raw}"`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  };
}

function assertNodeVersion() {
  const requiredMajor = Number(String(versions.node).replace(/^v/, ''));
  const actual = parseVersionTuple(process.version);
  if (actual.major !== requiredMajor) {
    fail(`Node ${versions.node} is required by ${versionsPath}; current runtime is ${process.version}`);
  }
}

function assertNpmVersion() {
  const constraint = String(versions.npm);
  const match = constraint.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    fail(`Unsupported npm constraint "${constraint}" in ${versionsPath}`);
  }

  const minimum = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  const actual = parseVersionTuple(readCommand('npm', ['--version']));
  const isBelowMinimum =
    actual.major < minimum.major ||
    (actual.major === minimum.major && actual.minor < minimum.minor) ||
    (actual.major === minimum.major &&
      actual.minor === minimum.minor &&
      actual.patch < minimum.patch);

  if (isBelowMinimum) {
    fail(`npm ${constraint} is required by ${versionsPath}; current runtime is ${actual.raw}`);
  }
}

function assertTerraformVersion() {
  const raw = readCommand('terraform', ['version', '-json']);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('terraform version -json did not return valid JSON');
  }

  if (parsed.terraform_version !== versions.terraform) {
    fail(
      `Terraform ${versions.terraform} is required by ${versionsPath}; ` +
        `current runtime is ${parsed.terraform_version ?? 'unknown'}`,
    );
  }
}

assertNodeVersion();
assertNpmVersion();

if (checksTerraform) {
  assertTerraformVersion();
}
