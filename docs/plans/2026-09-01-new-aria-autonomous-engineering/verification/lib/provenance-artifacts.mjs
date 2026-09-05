import { relative } from 'node:path';
import { classifyPlanRelativeArtifact } from './artifact-policy.mjs';
import { walkRegularFiles } from './secure-tree.mjs';

export const provenanceManifestPath = 'verification/verifier-inputs.jsonl';
export const provenanceExternalPaths = [
  '../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
  '../../../tools/quality/format-scope.json',
  '../../../.prettierrc',
  '../../../package.json',
  '../../../package-lock.json',
];

export function expectedPaths(planRoot) {
  const paths = walkRegularFiles(planRoot)
    .map((path) => relative(planRoot, path).replaceAll('\\', '/'))
    .filter((path) => {
      if (!classifyPlanRelativeArtifact(path)) throw new Error(`${path}: artifact type is denied`);
      return path !== provenanceManifestPath;
    });
  return [...paths, ...provenanceExternalPaths].sort();
}
