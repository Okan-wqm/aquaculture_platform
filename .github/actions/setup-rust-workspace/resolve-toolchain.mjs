import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from 'node:process';

const repoRoot = env.GITHUB_WORKSPACE;
const outputPath = env.GITHUB_OUTPUT;

if (!repoRoot || !outputPath) {
  throw new Error('GITHUB_WORKSPACE and GITHUB_OUTPUT are required');
}

const manifestPath = resolve(repoRoot, 'tools/quality/rust-toolchain-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const safeValuePattern = /^[A-Za-z0-9_.+-]+$/;

function requireSafeValue(value, field) {
  if (typeof value !== 'string' || !safeValuePattern.test(value)) {
    throw new Error(`${field} must be one non-empty toolchain token`);
  }
  return value;
}

function requireUniqueValues(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }

  const values = value.map((item, index) => requireSafeValue(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return values;
}

if (manifest.schema_version !== 1 || manifest.authority !== 'rust-toolchain.toml') {
  throw new Error('Rust toolchain manifest has an unsupported schema or authority');
}

const toolchain = requireSafeValue(manifest.channel, 'channel');
const components = requireUniqueValues(manifest.components, 'components').join(',');
const targets = requireUniqueValues(manifest.targets, 'targets').join(',');

appendFileSync(
  outputPath,
  `toolchain=${toolchain}\ncomponents=${components}\ntargets=${targets}\n`,
  'utf8',
);
