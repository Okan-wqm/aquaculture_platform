import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { parseStrictJson } from './canonical.mjs';

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

function maskNonCode(source) {
  const pattern = new RegExp(
    String.raw`/\*[\s\S]*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60`,
    'gu',
  );
  return source.replace(pattern, (match) => match.replace(/[^\n]/gu, ' '));
}

function closingBrace(masked, open) {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    if (masked[index] === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return masked.length - 1;
}

function functionSpans(source) {
  const masked = maskNonCode(source);
  const pattern = new RegExp(
    String.raw`(?:async\s+)?function\s+\w+\s*\(([^)]*)\)\s*\x7b|(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\x7b`,
    'gu',
  );
  const spans = [];
  for (const match of masked.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = closingBrace(masked, open);
    spans.push({ start: match.index, end: close, parameters: match[1] ?? match[2] ?? '' });
  }
  return spans;
}

function verifyFunctions(errors, path, source, limits) {
  for (const span of functionSpans(source)) {
    const body = source.slice(span.start, span.end + 1);
    const lines = body.split('\n').length;
    const parameters = span.parameters.trim() ? span.parameters.split(',').length : 0;
    const masked = maskNonCode(body);
    const branchPattern = new RegExp(
      String.raw`\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?`,
      'gu',
    );
    const cyclomatic = 1 + (masked.match(branchPattern)?.length ?? 0);
    if (lines > limits.function_lines)
      add(errors, 'READABILITY_LIMIT', `${path}: function lines ${lines}`);
    if (parameters > limits.function_parameters)
      add(errors, 'READABILITY_LIMIT', `${path}: function parameters ${parameters}`);
    if (cyclomatic > limits.cyclomatic_complexity || cyclomatic > limits.cognitive_complexity) {
      add(errors, 'READABILITY_LIMIT', `${path}: function complexity ${cyclomatic}`);
    }
  }
}

function verifyDependencyDirection(errors, planRoot, policy) {
  const layerByPath = new Map();
  const layers = policy.dependency_policy.layers;
  for (const [layer, paths] of Object.entries(policy.dependency_policy.d0_verification_layers)) {
    for (const path of paths) layerByPath.set(path, layers.indexOf(layer));
  }
  for (const [sourcePath, sourceLayer] of layerByPath) {
    const source = readFileSync(join(planRoot, sourcePath), 'utf8');
    const importPattern = new RegExp(
      String.raw`^\s*(?:import\s+[^\x27\x22\n]*?from\s+[\x27\x22](\.[^\x27\x22]+)[\x27\x22]|import\s+[\x27\x22](\.[^\x27\x22]+)[\x27\x22])`,
      'gmu',
    );
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      const targetPath = normalize(join(dirname(sourcePath), specifier)).replaceAll('\\', '/');
      const targetLayer = layerByPath.get(targetPath);
      if (targetLayer === undefined || targetLayer > sourceLayer) {
        add(errors, 'READABILITY_LIMIT', `${sourcePath}: forbidden dependency ${targetPath}`);
      }
    }
  }
}

function verifyPolicy(errors, policy) {
  const expectedLimits = {
    authored_file_target_lines: 250,
    authored_file_hard_lines: 400,
    function_lines: 60,
    function_parameters: 5,
    cyclomatic_complexity: 10,
    cognitive_complexity: 15,
  };
  if (JSON.stringify(policy.limits) !== JSON.stringify(expectedLimits))
    add(errors, 'READABILITY_POLICY', 'numeric limit drift');
  const required = [
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
  if (JSON.stringify(policy.generated_exception_required_fields) !== JSON.stringify(required))
    add(errors, 'READABILITY_POLICY', 'generated exception schema drift');
  const exception = policy.declarative_exceptions?.[0];
  const ranges = [
    '001-011',
    '012-022',
    '023-033',
    '034-044',
    '045-055',
    '056-066',
    '067-077',
    '078-088',
  ];
  if (
    exception?.path !== 'FINDING-COVERAGE.md' ||
    exception?.owner !== 'new-aria-program-authority' ||
    JSON.stringify(exception?.projection_ranges) !== JSON.stringify(ranges)
  ) {
    add(errors, 'READABILITY_POLICY', 'canonical matrix exception drift');
  }
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
    if (extname(path) === '.mjs') verifyFunctions(errors, local, source, limits);
  }
}

export function verifyReadability(planRoot, repositoryRoot) {
  const errors = [];
  const policyPath = join(planRoot, 'verification/readability-policy.json');
  const policy = parseStrictJson(readFileSync(policyPath, 'utf8'));
  verifyPolicy(errors, policy);
  verifyFileLimits(errors, planRoot, repositoryRoot, policy.limits);
  verifyDependencyDirection(errors, planRoot, policy);
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
