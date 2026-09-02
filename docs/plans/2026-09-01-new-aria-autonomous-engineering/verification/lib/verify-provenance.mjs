import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { canonicalJson, decodeUtf8Fatal, parseStrictJson, sha256 } from './canonical.mjs';
import { listCommitTree, readCommitEntries } from './git-objects.mjs';
import { createGitSession } from './hermetic-git.mjs';
import {
  assertRuntimeDependencyRoster,
  observeRuntimeDependencies,
} from './runtime-dependencies.mjs';
import { walkRegularFiles } from './secure-tree.mjs';

const manifestPath = 'verification/verifier-inputs.jsonl';
const designPath = '../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';
const formatScopePath = '../../../tools/quality/format-scope.json';
const prettierConfigPath = '../../../.prettierrc';
const packageJsonPath = '../../../package.json';
const packageLockPath = '../../../package-lock.json';
const externalPaths = [
  designPath,
  formatScopePath,
  prettierConfigPath,
  packageJsonPath,
  packageLockPath,
];
const extensions = ['.md', '.mjs', '.json', '.jsonl', '.graphql', '.raw', '.gitattributes'];
const portableRuntime = {
  node: {
    logical_name: 'node',
    version_requirement: '>=20.11.0',
    environment_policy: 'new-aria-hermetic-node-v1',
  },
  git: { logical_name: 'git', environment_policy: 'new-aria-hermetic-git-v1' },
};

function add(errors, message) {
  errors.push({ code: 'VERIFIER_PROVENANCE', message });
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function expectedPaths(planRoot) {
  const paths = walkRegularFiles(planRoot)
    .map((path) => relative(planRoot, path).replaceAll('\\', '/'))
    .filter((path) => extensions.some((extension) => path.endsWith(extension)))
    .filter((path) => path !== manifestPath);
  return [...paths, ...externalPaths].sort();
}

export function bundleDigest(records) {
  return sha256(
    Buffer.from(records.map((record) => `${record.path}\0${record.sha256}\n`).join('')),
  );
}

function verifyRuntime(errors, runtime) {
  const policies = { node: runtime?.node, git: runtime?.git };
  if (
    !exactKeys(runtime, ['dependencies', 'git', 'node', 'package_lock_sha256']) ||
    canonicalJson(policies) !== canonicalJson(portableRuntime) ||
    !/^[a-f0-9]{64}$/u.test(runtime.package_lock_sha256 ?? '')
  ) {
    errors.push({ code: 'VERIFIER_RUNTIME', message: 'portable verifier runtime policy mismatch' });
    return;
  }
  try {
    assertRuntimeDependencyRoster(runtime.dependencies);
  } catch (error) {
    errors.push({ code: 'VERIFIER_RUNTIME', message: error.message });
  }
}

export function runtimeProvenance(repositoryRoot) {
  const facts = observeRuntimeDependencies(repositoryRoot);
  return {
    ...portableRuntime,
    package_lock_sha256: facts.package_lock_sha256,
    dependencies: facts.runtime_dependencies,
  };
}

function metadataIdentity(metadata) {
  const value = metadata ?? {};
  const expectedFlags = [
    '--repo-root',
    '--mode',
    '--base',
    '--head',
    '--reviewed-ref',
    '--base-tree',
    '--head-tree',
    '--diff-sha256',
    '--design-sha256',
    '--format-scope-sha256',
  ];
  return [
    exactKeys(value, [
      'schema_version',
      'kind',
      'verifier_version',
      'claim',
      'recorded_at_utc',
      'verifier_script',
      'required_flags',
      'cwd_contract',
      'runtime',
      'input_bundle_algorithm',
      'input_bundle_sha256',
    ]),
    value.schema_version === '2.0.0',
    value.kind === 'metadata',
    value.verifier_version === '2.0.0',
    value.claim === 'verifier input provenance; not an admission record',
    typeof value.recorded_at_utc === 'string',
    value.verifier_script ===
      'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/verify-d0.mjs',
    JSON.stringify(value.required_flags) === JSON.stringify(expectedFlags),
    value.cwd_contract === 'repository root',
    value.input_bundle_algorithm === 'sha256(path + NUL + sha256 + LF, lexicographic path order)',
  ].every(Boolean);
}

function verifyMetadata(errors, metadata, records) {
  if (!metadataIdentity(metadata)) add(errors, 'metadata identity, argv, or CWD drift');
  verifyRuntime(errors, metadata.runtime);
  const lock = records.find(({ path }) => path === packageLockPath);
  if (metadata.runtime?.package_lock_sha256 !== lock?.sha256) {
    errors.push({ code: 'VERIFIER_RUNTIME', message: 'package-lock provenance binding mismatch' });
  }
  if (metadata.input_bundle_sha256 !== bundleDigest(records))
    add(errors, 'input bundle digest mismatch');
}

function parseManifest(bytes) {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a)
    throw new Error('provenance must be newline terminated');
  return decodeUtf8Fatal(bytes, 'verifier provenance')
    .slice(0, -1)
    .split('\n')
    .map(parseStrictJson);
}

function validRecord(record, expected) {
  const value = record ?? {};
  return [
    exactKeys(value, ['schema_version', 'kind', 'path', 'sha256']),
    value.schema_version === '2.0.0',
    value.kind === 'input',
    typeof value.path === 'string',
    /^[a-f0-9]{64}$/u.test(value.sha256 ?? ''),
    expected.includes(value.path),
  ].every(Boolean);
}

function verifyRecords(errors, records, expected, readBytes) {
  if (JSON.stringify(records.map(({ path }) => path)) !== JSON.stringify(expected)) {
    add(errors, 'input path roster drift');
  }
  const files = new Map();
  for (const record of records) {
    if (!validRecord(record, expected)) {
      add(errors, 'input record schema or path drift');
      continue;
    }
    const bytes = readBytes(record.path);
    files.set(record.path, bytes);
    if (sha256(bytes) !== record.sha256) add(errors, `${record.path}: input digest mismatch`);
  }
  return files;
}

function repositoryPrefix(repositoryRoot, planRoot) {
  const prefix = relative(realpathSync(repositoryRoot), realpathSync(planRoot)).replaceAll(
    '\\',
    '/',
  );
  if (!prefix || prefix.startsWith('../') || isAbsolute(prefix))
    throw new Error('plan root escapes repository');
  return prefix;
}

export function loadVerifiedProvenance(planRoot, { repositoryRoot, revision, gitTool }) {
  const prefix = repositoryPrefix(repositoryRoot, planRoot);
  const git = createGitSession(gitTool);
  const external = externalPaths.map((path) => posix.normalize(`${prefix}/${path}`));
  const tree = listCommitTree(repositoryRoot, revision, [prefix, ...external], git);
  for (const entry of tree) {
    if (entry.mode !== '100644' || entry.type !== 'blob') {
      throw new Error(`${entry.path}: committed tree mode must be regular non-executable blob`);
    }
  }
  const relativePaths = tree
    .filter(({ path }) => path.startsWith(`${prefix}/`))
    .map(({ path }) => path.slice(prefix.length + 1))
    .filter((path) => extensions.some((extension) => path.endsWith(extension)))
    .filter((path) => path !== manifestPath);
  const expected = [...relativePaths, ...externalPaths].sort();
  const sources = new Map(expected.map((path) => [path, posix.normalize(`${prefix}/${path}`)]));
  const manifestSource = `${prefix}/${manifestPath}`;
  const entries = new Map(tree.map((entry) => [entry.path, entry]));
  const requested = [manifestSource, ...sources.values()].map((path) => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`${path}: committed blob missing`);
    return entry;
  });
  const snapshot = readCommitEntries(repositoryRoot, requested, git);
  const provenance = snapshot.get(manifestSource).bytes;
  const [metadata, ...records] = parseManifest(provenance);
  const errors = [];
  const files = verifyRecords(
    errors,
    records,
    expected,
    (path) => snapshot.get(sources.get(path)).bytes,
  );
  verifyMetadata(errors, metadata, records);
  if (errors.length > 0) throw new Error(`${errors[0].code}: ${errors[0].message}`);
  return { metadata, records, provenanceBytes: provenance, files };
}

export function verifyProvenance(planRoot, options) {
  if (!options)
    return [{ code: 'VERIFIER_PROVENANCE', message: 'verified target snapshot required' }];
  try {
    loadVerifiedProvenance(planRoot, options);
    return [];
  } catch (error) {
    return [{ code: 'VERIFIER_PROVENANCE', message: error.message }];
  }
}

export function verifyWorktreeProvenance(planRoot) {
  const errors = [];
  const [metadata, ...records] = parseManifest(readFileSync(resolve(planRoot, manifestPath)));
  const expected = expectedPaths(planRoot);
  verifyRecords(errors, records, expected, (path) => readFileSync(resolve(planRoot, path)));
  verifyMetadata(errors, metadata, records);
  return errors;
}
