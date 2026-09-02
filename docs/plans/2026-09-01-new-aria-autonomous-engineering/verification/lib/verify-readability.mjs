import { existsSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parseStrictJson } from './canonical.mjs';
import {
  typescriptVersion,
  verifyAstDependencies,
  verifyAstFunctions,
} from './ast-readability.mjs';
import { walkRegularFiles } from './secure-tree.mjs';

function add(errors, code, message) {
  errors.push({ code, message });
}

const expectedLimits = {
  authored_file_target_lines: 250,
  authored_file_hard_lines: 400,
  function_lines: 60,
  function_parameters: 5,
  cyclomatic_complexity: 10,
  cognitive_complexity: 15,
};
const requiredGeneratedFields = [
  'owner',
  'reason',
  'expires_at',
  'input_digests',
  'generator_argv',
  'generator_version',
  'generator_digest',
  'output_digests',
  'deterministic_check_argv',
];
const projectionRanges = [
  '001-011',
  '012-022',
  '023-033',
  '034-044',
  '045-055',
  '056-066',
  '067-077',
  '078-088',
];
const dependencyIdentity = {
  layers: ['domain', 'kernel', 'application', 'adapters', 'runtime'],
  rule: 'A module may import its own layer or an earlier layer only.',
  migration_exempt: false,
  child_process_modules: [
    'verification/dossier-target-test-fixture.mjs',
    'verification/lib/bootstrap-d0.mjs',
    'verification/lib/hermetic-git.mjs',
    'verification/lib/projection-format.mjs',
    'verification/lib/review-view-transform.mjs',
    'verification/run-d0-suite.mjs',
    'verification/target-control-test-fixture.mjs',
    'verification/test-dossier-admission.mjs',
    'verification/test-dossier-resolution.mjs',
    'verification/test-hermetic-git.mjs',
    'verification/test-negative-controls.mjs',
    'verification/test-parallel-isolation.mjs',
    'verification/test-secure-tree.mjs',
    'verification/test-target-command.mjs',
  ],
  approved_external_specifiers: [
    'graphql',
    'node:assert/strict',
    'node:child_process',
    'node:crypto',
    'node:fs',
    'node:os',
    'node:path',
    'node:url',
    'prettier',
    'typescript',
  ],
};
const domainModules = new Set(['verification/lib/canonical.mjs', 'verification/lib/markdown.mjs']);
const kernelModules = new Set([
  'verification/lib/api-contract.mjs',
  'verification/lib/ast-readability.mjs',
  'verification/lib/ast-runtime-guards.mjs',
  'verification/lib/d0-suite.mjs',
  'verification/lib/delivery-readback-contract.mjs',
  'verification/lib/external-authority-path.mjs',
  'verification/lib/git-batch-parser.mjs',
  'verification/lib/git-objects.mjs',
  'verification/lib/hermetic-git.mjs',
  'verification/lib/private-node.mjs',
  'verification/lib/review-evidence-policy.mjs',
  'verification/lib/review-evidence-semantics.mjs',
  'verification/lib/runtime-dependencies.mjs',
  'verification/lib/secure-tree.mjs',
  'verification/lib/target-git-facts.mjs',
  'verification/lib/target-manifest.mjs',
  'verification/lib/verify-audit-oracle.mjs',
  'verification/lib/verify-relations.mjs',
  'verification/lib/verify-signature.mjs',
  'verification/lib/verify-target.mjs',
]);
const adapterModules = new Set([
  'verification/lib/github-delivery-provider.mjs',
  'verification/lib/github-final-note.mjs',
  'verification/lib/github-ruleset-policy.mjs',
]);
function verifyLimits(errors, policy) {
  if (JSON.stringify(policy.limits) !== JSON.stringify(expectedLimits))
    add(errors, 'READABILITY_POLICY', 'numeric limit drift');
}
function verifyEngine(errors, policy) {
  const engine = policy.analysis_engine;
  if (
    !engine ||
    engine.name !== 'typescript' ||
    engine.version !== '5.9.3' ||
    typescriptVersion() !== policy.analysis_engine.version
  ) {
    add(errors, 'READABILITY_POLICY', 'pinned TypeScript AST engine drift');
  }
}
function verifyGeneratedFieldSchema(errors, policy) {
  if (
    JSON.stringify(policy.generated_exception_required_fields) !==
    JSON.stringify(requiredGeneratedFields)
  )
    add(errors, 'READABILITY_POLICY', 'generated exception schema drift');
}
function verifyMatrixException(errors, policy) {
  const exceptions = policy.declarative_exceptions;
  const exception = Array.isArray(exceptions) ? exceptions[0] : null;
  if (
    !exception ||
    exception.path !== 'FINDING-COVERAGE.md' ||
    exception.owner !== 'new-aria-program-authority' ||
    JSON.stringify(exception.projection_ranges) !== JSON.stringify(projectionRanges)
  ) {
    add(errors, 'READABILITY_POLICY', 'canonical matrix exception drift');
  }
}
function expectedDependencyLayer(path) {
  if (domainModules.has(path)) return 'domain';
  if (kernelModules.has(path)) return 'kernel';
  if (adapterModules.has(path)) return 'adapters';
  if (path.startsWith('verification/lib/')) return 'application';
  return 'runtime';
}
function hasExactRosterShape(rosters) {
  return (
    JSON.stringify(Object.keys(rosters).sort()) ===
      JSON.stringify([...dependencyIdentity.layers].sort()) &&
    Object.values(rosters).every(Array.isArray)
  );
}
function verificationModules(planRoot) {
  return walkRegularFiles(join(planRoot, 'verification'))
    .filter((path) => extname(path) === '.mjs')
    .map((path) => relative(planRoot, path).replaceAll('\\', '/'))
    .sort();
}
function hasExactUniqueRoster(declared, actual) {
  return (
    declared.every((path) => typeof path === 'string') &&
    new Set(declared).size === declared.length &&
    JSON.stringify([...declared].sort()) === JSON.stringify(actual)
  );
}
function hasExactAssignments(rosters) {
  return Object.entries(rosters).every(([layer, paths]) =>
    paths.every((path) => expectedDependencyLayer(path) === layer),
  );
}

function verifyDependencyPolicy(errors, planRoot, policy) {
  const dependency = policy.dependency_policy;
  for (const [field, expected] of Object.entries(dependencyIdentity)) {
    if (JSON.stringify(dependency?.[field]) !== JSON.stringify(expected)) {
      add(errors, 'READABILITY_POLICY', `dependency ${field} drift`);
    }
  }
  const rosters = dependency?.d0_verification_layers;
  if (!rosters || typeof rosters !== 'object' || Array.isArray(rosters)) {
    add(errors, 'READABILITY_POLICY', 'dependency layer roster missing');
    return;
  }
  if (!hasExactRosterShape(rosters)) {
    add(errors, 'READABILITY_POLICY', 'dependency layer roster shape drift');
    return;
  }
  const declared = Object.values(rosters).flat();
  if (!hasExactUniqueRoster(declared, verificationModules(planRoot))) {
    add(errors, 'READABILITY_POLICY', 'dependency layer roster is not exact and unique');
  }
  if (!hasExactAssignments(rosters)) {
    add(errors, 'READABILITY_POLICY', 'dependency layer assignment drift');
  }
}

function verifyPolicy(errors, planRoot, policy) {
  verifyLimits(errors, policy);
  verifyEngine(errors, policy);
  verifyGeneratedFieldSchema(errors, policy);
  verifyMatrixException(errors, policy);
  verifyDependencyPolicy(errors, planRoot, policy);
}

function verifyFileLimits(errors, planRoot, repositoryRoot, limits) {
  const files = walkRegularFiles(planRoot).filter((path) =>
    ['.graphql', '.json', '.jsonl', '.md', '.mjs'].includes(extname(path)),
  );
  files.push(
    join(
      repositoryRoot,
      'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    ),
  );
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    const local = path.startsWith(planRoot)
      ? relative(planRoot, path).replaceAll('\\', '/')
      : relative(repositoryRoot, path).replaceAll('\\', '/');
    if (lines > limits.authored_file_hard_lines)
      add(errors, 'READABILITY_LIMIT', `${local}: hard line limit ${lines}`);
    if (
      /^(?:authority|phases|verification)\//u.test(local) &&
      lines > limits.authored_file_target_lines
    ) {
      add(errors, 'READABILITY_LIMIT', `${local}: authored target ${lines}`);
    }
    if (extname(path) === '.mjs') verifyAstFunctions(errors, local, source, limits);
  }
}

export function verifyReadability(planRoot, repositoryRoot) {
  const errors = [];
  const policyPath = join(planRoot, 'verification/readability-policy.json');
  const policy = parseStrictJson(readFileSync(policyPath, 'utf8'));
  verifyPolicy(errors, planRoot, policy);
  verifyFileLimits(errors, planRoot, repositoryRoot, policy.limits);
  verifyAstDependencies(errors, planRoot, policy);
  const manifestPath = join(planRoot, 'verification/projection-manifest.json');
  if (!existsSync(manifestPath)) add(errors, 'READABILITY_POLICY', 'projection manifest missing');
  else {
    const manifest = parseStrictJson(readFileSync(manifestPath, 'utf8'));
    for (const field of policy.generated_exception_required_fields) {
      if (!(field in manifest))
        add(errors, 'READABILITY_POLICY', `projection manifest missing ${field}`);
    }
  }
  return errors;
}
