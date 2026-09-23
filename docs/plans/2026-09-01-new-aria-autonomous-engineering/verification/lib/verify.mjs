import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { buildProjectionSet } from './projections.mjs';
import { markdownLinks } from './markdown.mjs';
import { verifyHistory } from './verify-history.mjs';
import { verifyApiContract } from './verify-api.mjs';
import { verifyAuthorityContracts } from './verify-authority.mjs';
import { verifyMapping } from './verify-mapping.mjs';
import { verifyReadability } from './verify-readability.mjs';
import { walkRegularFiles } from './secure-tree.mjs';

function add(errors, code, message) {
  errors.push({ code, message });
}

function runCheck(errors, code, check) {
  try {
    errors.push(...check());
  } catch (error) {
    add(errors, code, error instanceof Error ? error.message : String(error));
  }
}

function verifyProjectionParity(planRoot, sourceRepositoryRoot, runtimeRepositoryRoot) {
  const errors = [];
  for (const [relativePath, expected] of buildProjectionSet(
    planRoot,
    sourceRepositoryRoot,
    runtimeRepositoryRoot,
  )) {
    const path = join(planRoot, relativePath);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== expected) {
      add(errors, 'PROJECTION_PARITY', `${relativePath}: missing or drifted`);
    }
  }
  return errors;
}

function normalizeTarget(target) {
  const withoutTitle = target.trim().replace(/^<|>$/gu, '');
  return decodeURI(withoutTitle.split('#')[0]);
}

function verifyRelativeLinks(planRoot) {
  const errors = [];
  for (const path of walkRegularFiles(planRoot).filter((file) => file.endsWith('.md'))) {
    for (const link of markdownLinks(readFileSync(path, 'utf8'))) {
      if (/^(?:https?:|mailto:|repo:|#)/u.test(link)) continue;
      const target = normalizeTarget(link);
      if (target && !existsSync(resolve(dirname(path), target))) {
        add(errors, 'RELATIVE_LINK', `${relative(planRoot, path)} -> ${link}`);
      }
    }
  }
  return errors;
}

function verifyD0Projection(planRoot) {
  const errors = [];
  const progress = readFileSync(join(planRoot, 'PROGRESS.md'), 'utf8');
  if (
    !progress.includes('**D0 state:** `VERIFYING`') ||
    progress.includes('**D0 state:** `DONE`')
  ) {
    add(errors, 'D0_STATE', 'PROGRESS must derive D0 VERIFYING');
  }
  if (!progress.startsWith('<!-- GENERATED:'))
    add(errors, 'D0_STATE', 'PROGRESS generated marker missing');
  return errors;
}

export function verifyVerifiedSnapshot(snapshot, gitRepositoryRoot, targetFacts) {
  const {
    planRoot,
    repositoryRoot: sourceRepositoryRoot,
    runtimeRepositoryRoot = sourceRepositoryRoot,
  } = snapshot;
  const errors = [];
  runCheck(errors, 'PROGRAM_PARITY', () =>
    verifyMapping(planRoot, gitRepositoryRoot, targetFacts.git_tool),
  );
  runCheck(errors, 'API_CONTRACT', () => verifyApiContract(planRoot));
  runCheck(errors, 'AUTHORITY_CONTRACT', () => verifyAuthorityContracts(planRoot));
  runCheck(errors, 'HISTORICAL_EVIDENCE', () =>
    verifyHistory(planRoot, {
      gitRepositoryRoot,
      sourceRepositoryRoot,
      runtimeRepositoryRoot,
      gitTool: targetFacts.git_tool,
    }),
  );
  runCheck(errors, 'READABILITY_POLICY', () => verifyReadability(planRoot, sourceRepositoryRoot));
  runCheck(errors, 'PROJECTION_PARITY', () =>
    verifyProjectionParity(planRoot, sourceRepositoryRoot, runtimeRepositoryRoot),
  );
  runCheck(errors, 'RELATIVE_LINK', () => verifyRelativeLinks(planRoot));
  runCheck(errors, 'D0_STATE', () => verifyD0Projection(planRoot));
  return errors;
}
