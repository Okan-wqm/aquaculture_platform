import {
  classifyChangedPath,
  classifyPlanArtifact,
  regularArtifactEntry,
} from './artifact-policy.mjs';

function add(errors, code, message) {
  errors.push({ code, message });
}

function changedPaths(entries) {
  return entries.flatMap((entry) => [
    ...(entry.status.startsWith('A')
      ? []
      : [{ mode: entry.oldMode, path: entry.oldPath, type: entry.oldType }]),
    ...(entry.status.startsWith('D')
      ? []
      : [{ mode: entry.newMode, path: entry.newPath ?? entry.oldPath, type: entry.newType }]),
  ]);
}

function verifyChangedPaths(errors, facts) {
  for (const { mode, path, type } of changedPaths(facts.commit_scope_entries)) {
    const classification = classifyChangedPath(path);
    if (!classification.accepted) {
      add(errors, classification.code, path);
    } else if (!regularArtifactEntry({ mode, type })) {
      add(errors, 'D0_ARTIFACT_POLICY', `${path}: changed artifact is not a regular blob`);
    }
  }
}

function verifyPlanTree(errors, facts) {
  for (const entry of facts.plan_tree_entries) {
    if (!classifyPlanArtifact(entry.path)) {
      add(errors, 'D0_ARTIFACT_POLICY', `${entry.path}: artifact type is denied`);
    } else if (!regularArtifactEntry(entry)) {
      add(errors, 'D0_ARTIFACT_POLICY', `${entry.path}: artifact must be a regular blob`);
    }
  }
}

export function verifyTargetArtifacts(facts) {
  const errors = [];
  verifyChangedPaths(errors, facts);
  verifyPlanTree(errors, facts);
  return errors;
}
