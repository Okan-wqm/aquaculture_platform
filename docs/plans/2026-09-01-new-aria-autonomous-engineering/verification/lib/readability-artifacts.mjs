import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { verifyAstFunctions } from './ast-readability.mjs';
import { classifyPlanRelativeArtifact } from './artifact-policy.mjs';
import { walkRegularFiles } from './secure-tree.mjs';

export function planArtifactFiles(planRoot) {
  return walkRegularFiles(planRoot).map((path) => {
    const local = relative(planRoot, path).replaceAll('\\', '/');
    return { artifact: classifyPlanRelativeArtifact(local), local, path };
  });
}

export function authoredCodeModules(planRoot) {
  return planArtifactFiles(planRoot)
    .filter(({ artifact }) => artifact?.authoredCode)
    .map(({ local }) => local)
    .sort();
}

export function verifyReadabilityArtifacts(errors, planRoot) {
  for (const { artifact, local } of planArtifactFiles(planRoot)) {
    if (!artifact)
      errors.push({ code: 'READABILITY_POLICY', message: `${local}: artifact denied` });
  }
}

export function verifyReadabilityFileLimits(errors, planRoot, repositoryRoot, limits) {
  const files = planArtifactFiles(planRoot)
    .filter(({ artifact }) => !['gitattributes', 'raw'].includes(artifact?.kind))
    .map(({ artifact, path }) => ({ artifact, path }));
  files.push({
    artifact: { authoredCode: false },
    path: join(
      repositoryRoot,
      'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    ),
  });
  for (const { artifact, path } of files) {
    const source = readFileSync(path, 'utf8');
    const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    const local = path.startsWith(planRoot)
      ? relative(planRoot, path).replaceAll('\\', '/')
      : relative(repositoryRoot, path).replaceAll('\\', '/');
    if (lines > limits.authored_file_hard_lines) {
      errors.push({ code: 'READABILITY_LIMIT', message: `${local}: hard line limit ${lines}` });
    }
    if (
      /^(?:authority|phases|verification)\//u.test(local) &&
      lines > limits.authored_file_target_lines
    ) {
      errors.push({ code: 'READABILITY_LIMIT', message: `${local}: authored target ${lines}` });
    }
    if (artifact?.authoredCode) verifyAstFunctions(errors, local, source, limits);
  }
}
