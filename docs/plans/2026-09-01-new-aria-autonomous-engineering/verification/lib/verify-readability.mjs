import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parseStrictJson } from './canonical.mjs';
import {
  typescriptVersion,
  verifyAstDependencies,
  verifyAstFunctions,
} from './ast-readability.mjs';

function add(errors, code, message) {
  errors.push({ code, message });
}

function filesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
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

function verifyPolicy(errors, policy) {
  verifyLimits(errors, policy);
  verifyEngine(errors, policy);
  verifyGeneratedFieldSchema(errors, policy);
  verifyMatrixException(errors, policy);
}

function verifyFileLimits(errors, planRoot, repositoryRoot, limits) {
  const files = filesUnder(planRoot).filter((path) =>
    ['.md', '.mjs', '.json', '.jsonl'].includes(extname(path)),
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
  verifyPolicy(errors, policy);
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
