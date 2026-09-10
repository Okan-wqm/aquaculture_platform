import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { canonicalJson, parseStrictJsonBytes, sha256 } from './canonical.mjs';
import { walkRegularFiles } from './secure-tree.mjs';

export const runtimeDependencyNames = ['graphql', 'prettier', 'typescript'];
export const runtimeDependencyPolicy = 'new-aria-private-package-snapshot-v1';
const exactDigest = /^[a-f0-9]{64}$/u;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const factKeys = ['environment_policy', 'logical_name', 'package_tree_sha256', 'version'];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function realDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} symbolic link is forbidden`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a real directory`);
}

function packageSnapshot(repositoryRoot, name) {
  const packageRoot = join(repositoryRoot, 'node_modules', name);
  realDirectory(packageRoot, `${name} package root`);
  const files = walkRegularFiles(packageRoot).map((path) => ({
    path: relative(packageRoot, path).replaceAll('\\', '/'),
    bytes: Buffer.from(readFileSync(path)),
  }));
  const manifestRecord = files.find(({ path }) => path === 'package.json');
  if (!manifestRecord) throw new Error(`${name} package.json is missing`);
  const manifest = parseStrictJsonBytes(manifestRecord.bytes, `${name} package.json`);
  if (manifest.name !== name || !exactVersion.test(manifest.version ?? '')) {
    throw new Error(`${name} package identity or exact version is invalid`);
  }
  const records = files.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }));
  return {
    fact: {
      logical_name: name,
      version: manifest.version,
      package_tree_sha256: sha256(Buffer.from(canonicalJson(records))),
      environment_policy: runtimeDependencyPolicy,
    },
    files,
  };
}

function capture(repositoryRoot) {
  const nodeModules = join(repositoryRoot, 'node_modules');
  realDirectory(nodeModules, 'node_modules root');
  const lockBytes = Buffer.from(readFileSync(join(repositoryRoot, 'package-lock.json')));
  const lock = parseStrictJsonBytes(lockBytes, 'package-lock.json');
  const packages = runtimeDependencyNames.map((name) => packageSnapshot(repositoryRoot, name));
  for (const { fact } of packages) {
    const locked = lock.packages?.[`node_modules/${fact.logical_name}`];
    if (locked?.version !== fact.version) {
      throw new Error(`${fact.logical_name} exact version is not bound by package-lock.json`);
    }
  }
  return {
    facts: {
      package_lock_sha256: sha256(lockBytes),
      runtime_dependencies: packages.map(({ fact }) => fact),
    },
    packages,
  };
}

function validDependencyFact(value) {
  if (!exactKeys(value, factKeys)) return false;
  if (!exactVersion.test(value.version)) return false;
  if (!exactDigest.test(value.package_tree_sha256)) return false;
  return value.environment_policy === runtimeDependencyPolicy;
}

export function assertRuntimeDependencyRoster(dependencies) {
  if (!Array.isArray(dependencies)) {
    throw new Error('runtime dependency roster must be exact and ordered');
  }
  const names = dependencies.map((value) => value?.logical_name);
  if (JSON.stringify(names) !== JSON.stringify(runtimeDependencyNames)) {
    throw new Error('runtime dependency roster must be exact and ordered');
  }
  for (const value of dependencies) {
    if (!validDependencyFact(value)) {
      throw new Error(`${value?.logical_name ?? 'unknown'} runtime dependency facts are invalid`);
    }
  }
}

function expectedFacts(value) {
  if (!exactDigest.test(value?.package_lock_sha256 ?? '')) {
    throw new Error('signed package-lock digest is invalid');
  }
  assertRuntimeDependencyRoster(value.runtime_dependencies);
  return {
    package_lock_sha256: value.package_lock_sha256,
    runtime_dependencies: value.runtime_dependencies,
  };
}

export function observeRuntimeDependencies(repositoryRoot) {
  return capture(repositoryRoot).facts;
}

export function verifyRuntimeDependencies(repositoryRoot, expected) {
  const signed = expectedFacts(expected);
  const observed = capture(repositoryRoot).facts;
  if (canonicalJson(observed) !== canonicalJson(signed)) {
    throw new Error('runtime dependency facts do not match signed authority');
  }
  return observed;
}

export function assertRuntimeBinding(target, runtime) {
  const provenance = {
    package_lock_sha256: runtime?.package_lock_sha256,
    runtime_dependencies: runtime?.dependencies,
  };
  if (canonicalJson(expectedFacts(target)) !== canonicalJson(expectedFacts(provenance))) {
    throw new Error('signed target and committed runtime provenance disagree');
  }
}

function writePackage(destinationRoot, name, files) {
  const packageRoot = join(destinationRoot, 'node_modules', name);
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const destination = join(packageRoot, file.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.bytes, { flag: 'wx', mode: 0o400 });
  }
}

export function copyVerifiedRuntimeDependencies(sourceRoot, destinationRoot, expected) {
  const signed = expectedFacts(expected);
  const snapshot = capture(sourceRoot);
  if (canonicalJson(snapshot.facts) !== canonicalJson(signed)) {
    throw new Error('runtime dependency facts do not match signed authority');
  }
  mkdirSync(join(destinationRoot, 'node_modules'), { mode: 0o700 });
  for (const runtimePackage of snapshot.packages) {
    writePackage(destinationRoot, runtimePackage.fact.logical_name, runtimePackage.files);
  }
  return verifyRuntimeDependencies(destinationRoot, signed);
}
